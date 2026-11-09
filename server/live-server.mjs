import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/**
 * Live relay for the project library and the active project snapshot.
 *
 * This process deliberately knows nothing about editing commands or rendering:
 * it stores project snapshots in SQLite and fans the active one out over SSE.
 * It has no renderer and no knowledge of any render pipeline.
 */

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const mediaRoot = process.env.TIMELINE_MEDIA_ROOT ?? publicRoot;
const seedFile = fileURLToPath(new URL('./seed-projects.json', import.meta.url));
const legacyDataFile =
  process.env.TIMELINE_PROJECTS_FILE ??
  fileURLToPath(new URL('../.data/projects.json', import.meta.url));
const dbFile =
  process.env.TIMELINE_DB_FILE ??
  fileURLToPath(new URL('../.data/projects.sqlite', import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const relayToken = process.env.TIMELINE_RELAY_TOKEN ?? '';
const writeRateLimit = Number(process.env.TIMELINE_WRITE_RATE_LIMIT ?? 120);

const clients = new Set();
const writeWindows = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

await mkdir(dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT NOT NULL,
    playhead_us INTEGER NOT NULL DEFAULT 0,
    timeline_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS projects_updated_at_idx
    ON projects (updated_at DESC, created_at DESC);

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'overlay')),
    url TEXT NOT NULL,
    poster_url TEXT,
    proxy_url TEXT,
    duration_us INTEGER NOT NULL CHECK (duration_us >= 0),
    width INTEGER,
    height INTEGER,
    has_audio INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS assets_created_at_idx
    ON assets (created_at DESC);

  CREATE TABLE IF NOT EXISTS project_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    timeline_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects (project_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS project_revisions_project_idx
    ON project_revisions (project_id, id DESC)
`);
db.prepare(
  `INSERT INTO meta (key, value) VALUES ('schema_version', '2')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run();

function applyCors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Live-Token');
}

function requestClient(request) {
  const forwarded = request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for'];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? request.socket.remoteAddress ?? 'unknown')
    .split(',')[0]
    .trim();
}

function writeAuthorized(request) {
  if (!relayToken) return true;
  return String(request.headers['x-live-token'] ?? '') === relayToken;
}

function writeRateLimited(request) {
  if (!Number.isFinite(writeRateLimit) || writeRateLimit <= 0) return false;
  const now = Date.now();
  const supplied = String(request.headers['x-live-token'] ?? '');
  const authenticated = relayToken && supplied === relayToken ? supplied : '';
  const key = `${requestClient(request)}:${authenticated}`;
  const current = writeWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    writeWindows.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > writeRateLimit;
}

function requireWriter(response, request) {
  if (writeRateLimited(request)) {
    sendJSON(response, 429, { error: 'rate_limited', retry_after_seconds: 60 });
    return false;
  }
  if (!writeAuthorized(request)) {
    sendJSON(response, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function sendJSON(response, status, body) {
  applyCors(response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function validProjectId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function validTimeline(timeline) {
  return (
    timeline &&
    typeof timeline === 'object' &&
    Array.isArray(timeline.segments) &&
    typeof timeline.duration_us === 'number' &&
    Number.isInteger(timeline.revision) &&
    timeline.revision > 0
  );
}

function validSnapshot(snapshot) {
  return (
    snapshot &&
    typeof snapshot === 'object' &&
    validProjectId(snapshot.project_id) &&
    typeof snapshot.title === 'string' &&
    validTimeline(snapshot.timeline) &&
    typeof snapshot.updatedAt === 'string'
  );
}

function validAsset(asset) {
  return (
    asset &&
    typeof asset === 'object' &&
    typeof asset.id === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(asset.id) &&
    typeof asset.name === 'string' &&
    asset.name.length > 0 &&
    (asset.kind === 'video' || asset.kind === 'audio' || asset.kind === 'overlay') &&
    typeof asset.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(asset.sha256) &&
    typeof asset.url === 'string' &&
    typeof asset.durationUS === 'number' &&
    Number.isInteger(asset.durationUS) &&
    asset.durationUS >= 0
  );
}

function assetRowToDTO(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    posterUrl: row.poster_url ?? undefined,
    proxyUrl: row.proxy_url ?? undefined,
    durationUS: row.duration_us,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    hasAudio: Boolean(row.has_audio),
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function listAssets() {
  return db
    .prepare('SELECT * FROM assets ORDER BY created_at DESC, id ASC')
    .all()
    .map(assetRowToDTO);
}

function registerAsset(asset) {
  const existing = db.prepare('SELECT * FROM assets WHERE sha256 = ?').get(asset.sha256);
  if (existing) return { asset: assetRowToDTO(existing), deduped: true };

  const current = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id);
  if (current) {
    db.prepare(
      `UPDATE assets SET name = ?, kind = ?, url = ?, poster_url = ?, proxy_url = ?,
         duration_us = ?, width = ?, height = ?, has_audio = ? WHERE id = ?`,
    ).run(
      asset.name,
      asset.kind,
      asset.url,
      asset.posterUrl ?? null,
      asset.proxyUrl ?? null,
      asset.durationUS,
      asset.width ?? null,
      asset.height ?? null,
      asset.hasAudio ? 1 : 0,
      asset.id,
    );
  } else {
    db.prepare(
      `INSERT INTO assets
         (id, sha256, name, kind, url, poster_url, proxy_url, duration_us, width, height, has_audio, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asset.id,
      asset.sha256,
      asset.name,
      asset.kind,
      asset.url,
      asset.posterUrl ?? null,
      asset.proxyUrl ?? null,
      asset.durationUS,
      asset.width ?? null,
      asset.height ?? null,
      asset.hasAudio ? 1 : 0,
      asset.createdAt ?? new Date().toISOString(),
    );
  }

  return {
    asset: assetRowToDTO(db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id)),
    deduped: false,
  };
}

function addRevision(projectId, title, timeline, createdAt) {
  db.prepare(
    `INSERT INTO project_revisions (project_id, revision, title, timeline_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(projectId, timeline.revision, title, JSON.stringify(timeline), createdAt);
  db.prepare(
    `DELETE FROM project_revisions
     WHERE project_id = ? AND id NOT IN (
       SELECT id FROM project_revisions WHERE project_id = ? ORDER BY id DESC LIMIT 50
     )`,
  ).run(projectId, projectId);
}

function listRevisions(projectId, limit = 20) {
  return db
    .prepare(
      `SELECT id AS history_id, revision, title, created_at
       FROM project_revisions WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(projectId, limit)
    .map((row) => ({
      project_id: projectId,
      history_id: Number(row.history_id),
      revision: Number(row.revision),
      title: row.title,
      created_at: row.created_at,
    }));
}

function getRevision(projectId, historyId) {
  const row = db
    .prepare(
      `SELECT id AS history_id, revision, title, timeline_json, created_at
       FROM project_revisions WHERE project_id = ? AND id = ?`,
    )
    .get(projectId, historyId);
  if (!row) return null;
  let timeline;
  try {
    timeline = JSON.parse(row.timeline_json);
  } catch {
    return null;
  }
  if (!validTimeline(timeline)) return null;
  return {
    project_id: projectId,
    history_id: Number(row.history_id),
    revision: Number(row.revision),
    title: row.title,
    timeline,
    created_at: row.created_at,
  };
}

function summarize(snapshot) {
  const timeline = snapshot.timeline;
  return {
    id: snapshot.project_id,
    title: snapshot.title,
    revision: timeline.revision,
    updatedAt: snapshot.updatedAt,
    duration_us: timeline.duration_us,
    frame_rate: timeline.frame_rate ?? { numerator: 30, denominator: 1 },
    video_segments: timeline.segments.length,
    overlay_count: Array.isArray(timeline.overlays) ? timeline.overlays.length : 0,
    preview_asset_id: timeline.segments?.[0]?.asset_id ?? null,
    clips:
      timeline.segments.length +
      (Array.isArray(timeline.overlays) ? timeline.overlays.length : 0) +
      (Array.isArray(timeline.voiceovers) ? timeline.voiceovers.length : 0) +
      (Array.isArray(timeline.music) ? timeline.music.length : 0) +
      (Array.isArray(timeline.sfx) ? timeline.sfx.length : 0),
  };
}

async function readProjectList(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(validSnapshot) : [];
  } catch {
    return [];
  }
}

function countProjects() {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count);
}

function rowToSnapshot(row) {
  if (!row) return null;
  let timeline;
  try {
    timeline = JSON.parse(row.timeline_json);
  } catch {
    return null;
  }
  if (!validTimeline(timeline) || timeline.revision !== row.revision) return null;
  return {
    project_id: row.project_id,
    title: row.title,
    timeline,
    playhead_us: row.playhead_us,
    updatedAt: row.updated_at,
  };
}

function getProject(projectId) {
  return rowToSnapshot(
    db
      .prepare(
        `SELECT project_id, title, revision, updated_at, playhead_us, timeline_json
         FROM projects WHERE project_id = ?`,
      )
      .get(projectId),
  );
}

function listProjects() {
  return db
    .prepare(
      `SELECT project_id, title, revision, updated_at, playhead_us, timeline_json
       FROM projects
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all()
    .map(rowToSnapshot)
    .filter(Boolean);
}

function latestProject() {
  return rowToSnapshot(
    db
      .prepare(
        `SELECT project_id, title, revision, updated_at, playhead_us, timeline_json
         FROM projects
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get(),
  );
}

/**
 * Import the legacy JSON store once, before the relay starts accepting writes.
 * The JSON file is left untouched as a backup; subsequent reads come from SQLite.
 */
async function importLegacyProjects() {
  if (countProjects() > 0) return;

  let source = legacyDataFile;
  let list = await readProjectList(source);
  if (list.length === 0) {
    source = seedFile;
    list = await readProjectList(source);
  }
  if (list.length === 0) {
    console.log(`[relay] project database is empty: ${dbFile}`);
    return;
  }

  let inserted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(
      `INSERT INTO projects
         (project_id, title, revision, updated_at, playhead_us, timeline_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO NOTHING`,
    );
    const now = new Date().toISOString();
    for (const snapshot of list) {
      const result = insert.run(
        snapshot.project_id,
        snapshot.title,
        snapshot.timeline.revision,
        snapshot.updatedAt,
        Number.isFinite(snapshot.playhead_us) ? snapshot.playhead_us : 0,
        JSON.stringify(snapshot.timeline),
        now,
      );
      if (Number(result.changes) > 0) {
        addRevision(snapshot.project_id, snapshot.title, snapshot.timeline, now);
      }
      inserted += Number(result.changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(
    `[relay] imported ${inserted} project(s) from ${source} into ${dbFile}`,
  );
}

await importLegacyProjects();

function backfillRevisions() {
  const count = Number(
    db.prepare('SELECT COUNT(*) AS count FROM project_revisions').get().count,
  );
  if (count > 0) return;
  const rows = db
    .prepare('SELECT project_id, title, revision, updated_at, timeline_json FROM projects')
    .all();
  if (rows.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      let timeline;
      try {
        timeline = JSON.parse(row.timeline_json);
      } catch {
        continue;
      }
      if (validTimeline(timeline)) {
        addRevision(row.project_id, row.title, timeline, row.updated_at);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

backfillRevisions();

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function handlePublish(response, payload, projectId) {
  if (!validProjectId(projectId)) {
    sendJSON(response, 400, { error: 'invalid project id' });
    return;
  }
  if (!payload || typeof payload !== 'object' || !validTimeline(payload.timeline)) {
    sendJSON(response, 400, { error: 'invalid timeline payload' });
    return;
  }

  const expectedRevision = payload.expected_revision;
  if (
    expectedRevision !== undefined &&
    (!Number.isInteger(expectedRevision) || expectedRevision < 0)
  ) {
    sendJSON(response, 400, { error: 'invalid expected_revision' });
    return;
  }

  const snapshot = {
    project_id: projectId,
    title: typeof payload.title === 'string' ? payload.title : 'Velox Timeline Studio',
    timeline: payload.timeline,
    playhead_us: Number.isFinite(payload.playhead_us) ? payload.playhead_us : 0,
    updatedAt:
      typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString(),
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db
      .prepare('SELECT revision FROM projects WHERE project_id = ?')
      .get(projectId);
    if (
      expectedRevision !== undefined &&
      current &&
      current.revision !== expectedRevision
    ) {
      db.exec('ROLLBACK');
      sendJSON(response, 409, {
        error: 'revision_conflict',
        current_revision: current.revision,
        expected_revision: expectedRevision,
        project_id: projectId,
      });
      return;
    }

    db.prepare(
      `INSERT INTO projects
         (project_id, title, revision, updated_at, playhead_us, timeline_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         title = excluded.title,
         revision = excluded.revision,
         updated_at = excluded.updated_at,
         playhead_us = excluded.playhead_us,
         timeline_json = excluded.timeline_json`,
    ).run(
      projectId,
      snapshot.title,
      snapshot.timeline.revision,
      snapshot.updatedAt,
      snapshot.playhead_us,
      JSON.stringify(snapshot.timeline),
      new Date().toISOString(),
    );
    addRevision(projectId, snapshot.title, snapshot.timeline, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    console.error('[relay] unable to persist project:', error);
    sendJSON(response, 500, { error: 'storage failure' });
    return;
  }

  broadcast(snapshot);
  sendJSON(response, 200, {
    ok: true,
    project_id: projectId,
    revision: snapshot.timeline.revision,
  });
}

async function serveStatic(response, pathname, request, root = distRoot) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = join(root, safe);

  if (!resolved.startsWith(root.endsWith(sep) ? root : root + sep)) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(resolved);
    const headers = {
      'content-type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': resolved.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=3600',
    };

    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        response.writeHead(416, { 'content-range': `bytes */${body.length}` });
        response.end();
        return;
      }
      const [, rawStart, rawEnd] = match;
      let start;
      let end;
      if (rawStart === '') {
        const suffix = Number(rawEnd);
        start = Math.max(0, body.length - suffix);
        end = body.length - 1;
      } else {
        start = Number(rawStart);
        end = rawEnd === '' ? body.length - 1 : Math.min(Number(rawEnd), body.length - 1);
      }
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start > end ||
        start >= body.length
      ) {
        response.writeHead(416, { 'content-range': `bytes */${body.length}` });
        response.end();
        return;
      }
      const slice = body.subarray(start, end + 1);
      response.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': slice.length,
      });
      response.end(slice);
      return;
    }

    response.writeHead(200, { ...headers, 'content-length': body.length });
    response.end(body);
  } catch {
    if (root === distRoot && !extname(requested)) {
      try {
        const index = await readFile(join(distRoot, 'index.html'));
        response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        response.end(index);
        return;
      } catch {
        // Fall through to the build hint below.
      }
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found. Build the app first: npm run build');
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'OPTIONS') {
    applyCors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === '/api/assets' && request.method === 'GET') {
    sendJSON(response, 200, { assets: listAssets() });
    return;
  }

  if (url.pathname === '/api/assets' && request.method === 'POST') {
    if (!requireWriter(response, request)) return;
    try {
      const raw = await readBody(request);
      const payload = JSON.parse(raw);
      const asset = payload?.asset ?? payload;
      if (!validAsset(asset)) {
        sendJSON(response, 400, { error: 'invalid asset metadata' });
        return;
      }
      const registered = registerAsset(asset);
      sendJSON(response, 200, { ok: true, ...registered });
    } catch (error) {
      sendJSON(response, 400, {
        error: error instanceof Error ? error.message : 'bad request',
      });
    }
    return;
  }

  const revisionRoute = /^\/api\/projects\/([^/]+)\/revisions(?:\/(\d+))?$/.exec(
    url.pathname,
  );
  if (revisionRoute && request.method === 'GET') {
    let projectId;
    try {
      projectId = decodeURIComponent(revisionRoute[1]);
    } catch {
      sendJSON(response, 400, { error: 'invalid project id' });
      return;
    }
    if (!validProjectId(projectId) || !getProject(projectId)) {
      sendJSON(response, 404, { error: 'project not found' });
      return;
    }
    if (revisionRoute[2] === undefined) {
      const requested = Number(url.searchParams.get('limit') ?? 20);
      const limit = Number.isInteger(requested) ? Math.min(50, Math.max(1, requested)) : 20;
      sendJSON(response, 200, {
        project_id: projectId,
        revisions: listRevisions(projectId, limit),
      });
      return;
    }
    const revision = getRevision(projectId, Number(revisionRoute[2]));
    if (!revision) {
      sendJSON(response, 404, { error: 'revision not found' });
      return;
    }
    sendJSON(response, 200, revision);
    return;
  }

  if (url.pathname === '/api/projects' && request.method === 'GET') {
    sendJSON(response, 200, { projects: listProjects().map(summarize) });
    return;
  }

  if (url.pathname.startsWith('/api/projects/') && request.method === 'GET') {
    let projectId;
    try {
      projectId = decodeURIComponent(url.pathname.slice('/api/projects/'.length));
    } catch {
      sendJSON(response, 400, { error: 'invalid project id' });
      return;
    }
    if (!validProjectId(projectId)) {
      sendJSON(response, 400, { error: 'invalid project id' });
      return;
    }
    const snapshot = getProject(projectId);
    if (!snapshot) {
      sendJSON(response, 404, { error: 'project not found' });
      return;
    }
    sendJSON(response, 200, snapshot);
    return;
  }

  if (url.pathname.startsWith('/api/projects/') && request.method === 'POST') {
    if (!requireWriter(response, request)) return;
    try {
      let projectId;
      try {
        projectId = decodeURIComponent(url.pathname.slice('/api/projects/'.length));
      } catch {
        sendJSON(response, 400, { error: 'invalid project id' });
        return;
      }
      const raw = await readBody(request);
      const payload = JSON.parse(raw);
      handlePublish(response, payload, projectId);
    } catch (error) {
      sendJSON(response, 400, {
        error: error instanceof Error ? error.message : 'bad request',
      });
    }
    return;
  }

  if (url.pathname === '/api/timeline' && request.method === 'GET') {
    const snapshot = latestProject();
    if (!snapshot) {
      sendJSON(response, 204, null);
      return;
    }
    sendJSON(response, 200, snapshot);
    return;
  }

  if (url.pathname === '/api/timeline' && request.method === 'POST') {
    if (!requireWriter(response, request)) return;
    try {
      const raw = await readBody(request);
      const payload = JSON.parse(raw);
      const projectId =
        typeof payload?.project_id === 'string'
          ? payload.project_id
          : latestProject()?.project_id ?? 'velox-demo';
      handlePublish(response, payload, projectId);
    } catch (error) {
      sendJSON(response, 400, { error: error instanceof Error ? error.message : 'bad request' });
    }
    return;
  }

  if (url.pathname === '/api/events' && request.method === 'GET') {
    applyCors(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 2000\n\n');
    const snapshot = latestProject();
    if (snapshot) response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    clients.add(response);

    const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    request.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(response);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJSON(response, 404, { error: 'unknown api route' });
    return;
  }

  if (url.pathname.startsWith('/media/') && request.method === 'GET') {
    await serveStatic(response, url.pathname, request, mediaRoot);
    return;
  }

  await serveStatic(response, url.pathname, request);
});

server.on('close', () => db.close());

server.listen(port, () => {
  const journal = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? 'unknown';
  console.log(`live relay listening on http://127.0.0.1:${port}`);
  console.log(`serving editor build from ${distRoot}`);
  console.log(`projects database: ${dbFile} (journal=${journal}, rows=${countProjects()})`);
});
