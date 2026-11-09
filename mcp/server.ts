#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allAssets, assetById, refreshAssets } from '../src/timeline/assets';
import { isTimelineDocument, type TimelineDocument } from '../src/timeline/document';
import {
  addAudioClipUS,
  addOverlayClipUS,
  addVideoClipUS,
  createDemoDocument,
  createEmptyDocument,
  moveClipUS,
  removeClip,
  setAudioGain,
  setDurationUS,
  setFrameRate,
  summarizeDocument,
  trimClipUS,
  validateTimeline,
  secondsToUS,
} from '../src/timeline/operations';
import {
  durationFrames,
  frameRateOf,
  frameToUS,
  usToFrame,
  validateFrameRate,
  type FrameRate,
} from '../src/timeline/timebase';
import { renderContactSheet, renderTimelineFrame, type FrameRenderResult } from './render';
import {
  cancelRenderJob,
  enqueueRender,
  getRenderJob,
  listRenderJobs,
  renderQueueStats,
} from './render-queue';
import { timelineToOTIO } from './otio';
import { composeDocument } from './compose';

interface StoreState {
  projectId?: string;
  title: string;
  document: TimelineDocument;
  updatedAt: string;
}

const DEFAULT_PROJECT_ID = 'velox-demo';

function normalizeProjectId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw new Error(
      'project_id must start with a letter or number and contain only letters, numbers, _ or - (max 64 chars)',
    );
  }
  return id;
}

function slugifyProjectId(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalizeProjectId(slug || DEFAULT_PROJECT_ID);
}

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const mediaRoot = resolve(process.env.TIMELINE_MEDIA_ROOT ?? resolve(projectRoot, 'public'));
const importedRoot = resolve(mediaRoot, 'media/imported');
const ffmpegBin = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobeBin = process.env.FFPROBE_PATH ?? 'ffprobe';
const stateFile = process.env.TIMELINE_STATE_FILE ?? resolve(here, '../.mcp/project.json');
const relayUrl = (process.env.TIMELINE_RELAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const publicBase = (process.env.TIMELINE_PUBLIC_URL ?? relayUrl).replace(/\/$/, '');

function relayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    ...(process.env.TIMELINE_RELAY_TOKEN
      ? { 'x-live-token': process.env.TIMELINE_RELAY_TOKEN }
      : {}),
  };
}

async function ensureAssets(force = false): Promise<void> {
  try {
    await refreshAssets(relayUrl, { force });
  } catch {
    // Static demo assets remain usable while the relay is offline.
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolveCommand(String(stdout));
    });
  });
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

interface ProbeInfo {
  durationUS: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

async function probeMedia(path: string): Promise<ProbeInfo> {
  const raw = await runCommand(ffprobeBin, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height',
    '-of',
    'json',
    path,
  ]);
  const parsed = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
  const seconds = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('ffprobe returned no usable duration');
  }
  return {
    durationUS: Math.round(seconds * 1_000_000),
    width: video?.width,
    height: video?.height,
    hasAudio,
    hasVideo: Boolean(video),
  };
}

function projectPublicUrl(projectId: string): string {
  const url = new URL(publicBase);
  url.searchParams.delete('view');
  url.searchParams.set('project', projectId);
  return url.toString();
}

type PublishOutcome =
  | { status: 'published'; url: string; revision: number }
  | { status: 'conflict'; url: string; currentRevision?: number; error: string }
  | { status: 'offline'; url: string; error: string }
  | { status: 'rejected'; url: string; error: string; statusCode: number };

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function failure(error: string, details: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error, ...details }),
      },
    ],
    isError: true as const,
  };
}

function imageResult(result: FrameRenderResult) {
  return {
    content: [
      {
        type: 'image' as const,
        data: result.jpeg.toString('base64'),
        mimeType: 'image/jpeg',
      },
      {
        type: 'text' as const,
        text: JSON.stringify(result.meta, null, 2),
      },
    ],
  };
}

function revisionGuard(expectedRevision?: number) {
  if (expectedRevision === undefined || expectedRevision === state.document.revision) {
    return null;
  }
  return failure('revision_mismatch', {
    expected_revision: expectedRevision,
    current_revision: state.document.revision,
    hint: 'Call timeline_load_project to sync the relay revision, then retry; no changes were applied.',
  });
}

function publishPayload(outcome: PublishOutcome) {
  if (outcome.status === 'published') {
    return { ok: true, url: outcome.url, revision: outcome.revision };
  }
  return {
    ok: false,
    url: outcome.url,
    error: outcome.error,
    ...(outcome.status === 'conflict' && outcome.currentRevision !== undefined
      ? { current_revision: outcome.currentRevision }
      : {}),
    ...(outcome.status === 'rejected' ? { status_code: outcome.statusCode } : {}),
  };
}

async function loadState(): Promise<StoreState> {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as StoreState).title === 'string' &&
      isTimelineDocument((parsed as StoreState).document)
    ) {
      const record = parsed as StoreState;
      return {
        ...record,
        projectId:
          typeof record.projectId === 'string' && record.projectId.length > 0
            ? normalizeProjectId(record.projectId)
            : DEFAULT_PROJECT_ID,
      };
    }
  } catch {
    // First run or a stale file: fall back to the deterministic demo.
  }
  return {
    projectId: DEFAULT_PROJECT_ID,
    title: 'Velox Timeline Studio',
    document: createDemoDocument(),
    updatedAt: new Date().toISOString(),
  };
}

let state = await loadState();

async function saveState(): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, stateFile);
}

function currentProjectView() {
  const frameRate = frameRateOf(state.document);
  return {
    project_id: state.projectId ?? DEFAULT_PROJECT_ID,
    title: state.title,
    updatedAt: state.updatedAt,
    summary: summarizeDocument(state.document),
    timebase: {
      frame_rate: frameRate,
      duration_us: state.document.duration_us,
      duration_frames: durationFrames(state.document.duration_us, frameRate),
    },
    document: state.document,
  };
}

async function publishSnapshot(
  title: string,
  document: TimelineDocument,
  expectedRevision: number | undefined,
  projectId: string,
): Promise<PublishOutcome> {
  try {
    const response = await fetch(`${relayUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: relayHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        project_id: projectId,
        title,
        timeline: document,
        playhead_us: 0,
        updatedAt: new Date().toISOString(),
        ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      }),
    });

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // The relay may legitimately return an empty body.
    }

    if (response.status === 409) {
      const record =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { current_revision?: unknown })
          : {};
      return {
        status: 'conflict',
        url: projectPublicUrl(projectId),
        currentRevision:
          typeof record.current_revision === 'number' ? record.current_revision : undefined,
        error: 'revision_conflict: another writer published a newer revision',
      };
    }

    if (!response.ok) {
      const record =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { error?: unknown })
          : {};
      const message =
        typeof record.error === 'string' ? record.error : `relay responded ${response.status}`;
      if (response.status >= 500) {
        return { status: 'offline', url: projectPublicUrl(projectId), error: message };
      }
      return {
        status: 'rejected',
        url: projectPublicUrl(projectId),
        error: message,
        statusCode: response.status,
      };
    }

    return { status: 'published', url: projectPublicUrl(projectId), revision: document.revision };
  } catch (error) {
    return {
      status: 'offline',
      url: projectPublicUrl(projectId),
      error: error instanceof Error ? error.message : 'relay publish failed',
    };
  }
}

interface CommitOptions {
  expectedRevision?: number;
  force?: boolean;
}

async function commit(
  next: TimelineDocument,
  extra: Record<string, unknown> = {},
  options: CommitOptions = {},
) {
  const normalized: TimelineDocument =
    next.revision > state.document.revision
      ? next
      : { ...next, revision: state.document.revision + 1 };
  const errors = validateTimeline(normalized);
  if (errors.length > 0) return failure(errors.join('\n'));

  const expected = options.force
    ? undefined
    : (options.expectedRevision ?? state.document.revision);
  const outcome = await publishSnapshot(
    state.title,
    normalized,
    expected,
    state.projectId ?? DEFAULT_PROJECT_ID,
  );

  if (outcome.status === 'conflict' || outcome.status === 'rejected') {
    return failure(outcome.status === 'conflict' ? 'revision_conflict' : 'relay_rejected', {
      expected_revision: expected,
      current_revision:
        outcome.status === 'conflict' ? outcome.currentRevision : state.document.revision,
      relay: outcome.error,
      hint: 'No local state was changed. Call timeline_load_project to sync the relay revision, then retry.',
    });
  }

  const previous = state;
  state = {
    ...previous,
    document: normalized,
    updatedAt: new Date().toISOString(),
  };
  await saveState();
  return textResult({
    title: state.title,
    summary: summarizeDocument(state.document),
    ...extra,
    published: publishPayload(outcome),
  });
}

async function withEdit(
  expectedRevision: number | undefined,
  action: (document: TimelineDocument) => {
    document: TimelineDocument;
    extra?: Record<string, unknown>;
  },
) {
  const guard = revisionGuard(expectedRevision);
  if (guard) return guard;
  try {
    const result = action(state.document);
    return await commit(result.document, result.extra ?? {}, {
      expectedRevision: expectedRevision ?? state.document.revision,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'edit failed');
  }
}

function resolveUS(
  document: TimelineDocument,
  frame: number | undefined,
  seconds: number | undefined,
  label: string,
): number | undefined {
  if (frame !== undefined && seconds !== undefined) {
    throw new Error(`use either ${label}_frame or ${label}_s, not both`);
  }
  if (frame !== undefined) return frameToUS(frame, frameRateOf(document));
  if (seconds !== undefined) return Math.max(0, secondsToUS(seconds));
  return undefined;
}

function requireUS(
  document: TimelineDocument,
  frame: number | undefined,
  seconds: number | undefined,
  label: string,
): number {
  const value = resolveUS(document, frame, seconds, label);
  if (value === undefined) throw new Error(`${label}_frame or ${label}_s is required`);
  return value;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

const expectedRevisionSchema = z.number().int().positive().optional();

const startFields = {
  start_s: z.number().nonnegative().optional(),
  start_frame: z.number().int().nonnegative().optional(),
};

const durationFields = {
  duration_s: z.number().positive().optional(),
  duration_frames: z.number().int().positive().optional(),
};

const sourceInFields = {
  source_in_s: z.number().nonnegative().optional(),
  source_in_frame: z.number().int().nonnegative().optional(),
};

const transactionOperationSchema = z.object({
  type: z.enum(['add_video', 'add_audio', 'move', 'trim', 'set_gain', 'remove', 'set_duration']),
  asset_id: z.string().min(1).optional(),
  kind: z.enum(['voiceover', 'music', 'sfx']).optional(),
  clip_id: z.string().min(1).optional(),
  segment_id: z.string().min(1).optional(),
  start_s: z.number().nonnegative().optional(),
  start_frame: z.number().int().nonnegative().optional(),
  duration_s: z.number().positive().optional(),
  duration_frames: z.number().int().positive().optional(),
  source_in_s: z.number().nonnegative().optional(),
  source_in_frame: z.number().int().nonnegative().optional(),
  gain: z.number().nonnegative().optional(),
  audio_enabled: z.boolean().optional(),
  audio_gain: z.number().nonnegative().optional(),
});

function operationTime(
  document: TimelineDocument,
  op: z.infer<typeof transactionOperationSchema>,
  prefix: 'start' | 'duration' | 'source_in',
): number | undefined {
  if (prefix === 'start') {
    return resolveUS(document, op.start_frame, op.start_s, 'start');
  }
  if (prefix === 'duration') {
    return resolveUS(document, op.duration_frames, op.duration_s, 'duration');
  }
  return resolveUS(document, op.source_in_frame, op.source_in_s, 'source_in');
}

const server = new McpServer(
  { name: 'velox-timeline', version: '0.3.0' },
  {
    instructions:
      'Edit the renderer-agnostic editorial timeline. Prefer frame arguments (start_frame, duration_frames) over seconds when precision matters. Every mutation accepts expected_revision for optimistic concurrency and timeline_apply_transaction is atomic. Frame images are inspection only: the timeline core never invokes Chronon or any renderer. timeline_render queues the full timeline as an MP4 (V1, V2 overlays and the audio mix) and returns a job_id immediately; poll timeline_render_status for progress and use timeline_render_cancel to stop it. Agents call these tools, there is no render button. Read the current project before editing, and use revision-safe retries on conflicts.',
  },
);

server.registerTool(
  'timeline_create_project',
  {
    title: 'Create timeline project',
    description:
      'Create and publish a new timeline document. Use seed_demo=true for a ready-made five-clip demo. fps_num/fps_den default to 30/1.',
    inputSchema: {
      title: z.string().min(1).optional(),
      project_id: z.string().min(1).optional(),
      duration_s: z.number().positive().optional(),
      seed_demo: z.boolean().optional(),
      fps_num: z.number().int().positive().optional(),
      fps_den: z.number().int().positive().optional(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) => {
    const guard = revisionGuard(args.expected_revision);
    if (guard) return guard;
    const frameRate: FrameRate = {
      numerator: args.fps_num ?? 30,
      denominator: args.fps_den ?? 1,
    };
    const frameRateErrors = validateFrameRate(frameRate);
    if (frameRateErrors.length > 0) return failure(frameRateErrors.join('; '));

    const document = args.seed_demo
      ? createDemoDocument()
      : createEmptyDocument(args.duration_s ?? 15);
    document.frame_rate = { ...frameRate };

    let projectId: string;
    try {
      projectId = normalizeProjectId(
        args.project_id ??
          (args.title ? slugifyProjectId(args.title) : DEFAULT_PROJECT_ID),
      );
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'invalid project_id');
    }

    const title = args.title ?? 'Velox Timeline Studio';
    const outcome = await publishSnapshot(
      title,
      document,
      args.expected_revision,
      projectId,
    );
    if (outcome.status === 'conflict' || outcome.status === 'rejected') {
      return failure(outcome.status === 'conflict' ? 'revision_conflict' : 'relay_rejected', {
        expected_revision: args.expected_revision,
        current_revision:
          outcome.status === 'conflict' ? outcome.currentRevision : state.document.revision,
        relay: outcome.error,
      });
    }
    state = {
      projectId,
      title,
      document,
      updatedAt: new Date().toISOString(),
    };
    await saveState();
    return textResult({
      project_id: state.projectId,
      title: state.title,
      summary: summarizeDocument(state.document),
      published: publishPayload(outcome),
    });
  },
);

server.registerTool(
  'timeline_get_project',
  {
    title: 'Get timeline project',
    description:
      'Return the title, frame timebase, summary and full timeline document from local MCP state. Call timeline_load_project first when another agent or the editor may have changed the relay revision.',
    inputSchema: {},
  },
  async () => textResult(currentProjectView()),
);

server.registerTool(
  'timeline_load_project',
  {
    title: 'Load project from relay',
    description:
      'Replace the local MCP state with the latest snapshot for a project from the relay. Use this before editing an existing project from a second agent, or to recover after a revision conflict.',
    inputSchema: {
      project_id: z.string().min(1).optional(),
    },
  },
  async (args) => {
    let projectId: string;
    try {
      projectId = normalizeProjectId(args.project_id ?? state.projectId ?? DEFAULT_PROJECT_ID);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'invalid project_id');
    }

    try {
      const response = await fetch(`${relayUrl}/api/projects/${encodeURIComponent(projectId)}`, {
        headers: {
          ...(process.env.TIMELINE_RELAY_TOKEN
            ? { 'x-live-token': process.env.TIMELINE_RELAY_TOKEN }
            : {}),
        },
      });
      if (response.status === 404) {
        return failure('project_not_found', { project_id: projectId });
      }
      if (!response.ok) {
        return failure(`relay responded ${response.status}`, { project_id: projectId });
      }
      const snapshot: unknown = await response.json();
      if (
        typeof snapshot !== 'object' ||
        snapshot === null ||
        typeof (snapshot as { project_id?: unknown }).project_id !== 'string' ||
        typeof (snapshot as { title?: unknown }).title !== 'string' ||
        typeof (snapshot as { updatedAt?: unknown }).updatedAt !== 'string' ||
        !isTimelineDocument((snapshot as { timeline?: unknown }).timeline)
      ) {
        return failure('invalid project snapshot', { project_id: projectId });
      }
      const record = snapshot as {
        project_id: string;
        title: string;
        updatedAt: string;
        timeline: TimelineDocument;
      };
      const errors = validateTimeline(record.timeline);
      if (errors.length > 0) {
        return failure(`relay project is invalid: ${errors[0]}`, { project_id: projectId });
      }
      state = {
        projectId: normalizeProjectId(record.project_id),
        title: record.title,
        document: record.timeline,
        updatedAt: record.updatedAt,
      };
      await saveState();
      return textResult({ ...currentProjectView(), source: 'relay' });
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'relay load failed', {
        project_id: projectId,
      });
    }
  },
);

server.registerTool(
  'timeline_list_assets',
  {
    title: 'List timeline assets',
    description:
      'List the app-owned media catalog. Asset IDs are the only media references stored in the timeline.',
    inputSchema: {},
  },
  async () => {
    await ensureAssets(true);
    return textResult({ assets: allAssets() });
  },
);

server.registerTool(
  'timeline_import_asset',
  {
    title: 'Import media asset',
    description:
      'Import a local media file into the project catalog. Computes SHA-256, probes duration/codec/resolution with FFprobe, generates a poster (and optional proxy), deduplicates by hash, then registers the asset with the relay. The final render uses the original file, never the proxy.',
    inputSchema: {
      source_path: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      kind: z.enum(['video', 'audio', 'overlay']).optional(),
      poster_at_s: z.number().nonnegative().optional(),
      proxy: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const source = isAbsolute(args.source_path)
        ? args.source_path
        : resolve(projectRoot, args.source_path);
      const sourceInfo = await stat(source);
      if (!sourceInfo.isFile()) throw new Error('source_path is not a file');

      const hash = await sha256File(source);
      await ensureAssets(true);
      const existing = allAssets().find((asset) => asset.sha256 === hash);
      if (existing) return textResult({ asset: existing, deduped: true, warnings: [] });

      const probe = await probeMedia(source);
      const kind =
        args.kind ?? (probe.hasVideo ? 'video' : probe.hasAudio ? 'audio' : undefined);
      if (!kind) throw new Error('could not infer media kind: file has no video or audio stream');

      const rawExtension = extname(source).toLowerCase();
      const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension)
        ? rawExtension
        : kind === 'audio'
          ? '.m4a'
          : '.mp4';
      await mkdir(importedRoot, { recursive: true });
      const filename = `${hash}${extension}`;
      const destination = resolve(importedRoot, filename);
      if (destination !== source) {
        try {
          await stat(destination);
        } catch {
          await copyFile(source, destination);
        }
      }

      const warnings: string[] = [];
      let posterUrl: string | undefined;
      if (probe.hasVideo && kind !== 'audio') {
        const posterName = `${hash}.jpg`;
        const posterPath = resolve(importedRoot, posterName);
        const at = Math.max(
          0,
          Math.min(
            args.poster_at_s ?? 1,
            Math.max(0, probe.durationUS / 1_000_000 - 0.05),
          ),
        );
        try {
          await runCommand(ffmpegBin, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            at.toFixed(3),
            '-i',
            source,
            '-frames:v',
            '1',
            '-vf',
            'scale=640:-2',
            '-q:v',
            '3',
            '-y',
            posterPath,
          ]);
          posterUrl = `/media/imported/${posterName}`;
        } catch (error) {
          warnings.push(
            `poster generation failed: ${error instanceof Error ? error.message : 'ffmpeg error'}`,
          );
        }
      }

      let proxyUrl: string | undefined;
      if (args.proxy && probe.hasVideo) {
        const proxyName = `${hash}-proxy.mp4`;
        const proxyPath = resolve(importedRoot, proxyName);
        try {
          await runCommand(ffmpegBin, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            source,
            '-vf',
            'scale=960:-2',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '28',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            '-y',
            proxyPath,
          ]);
          proxyUrl = `/media/imported/${proxyName}`;
        } catch (error) {
          warnings.push(
            `proxy generation failed: ${error instanceof Error ? error.message : 'ffmpeg error'}`,
          );
        }
      }

      const asset = {
        id: `asset-${hash.slice(0, 12)}`,
        name: args.name?.trim() || basename(source, extname(source)),
        kind,
        url: `/media/imported/${filename}`,
        posterUrl,
        proxyUrl,
        durationUS: probe.durationUS,
        width: probe.width,
        height: probe.height,
        hasAudio: probe.hasAudio,
        sha256: hash,
        createdAt: new Date().toISOString(),
      };

      const response = await fetch(`${relayUrl}/api/assets`, {
        method: 'POST',
        headers: relayHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(asset),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof payload === 'object' && payload !== null && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : `relay responded ${response.status}`;
        throw new Error(`asset registration failed: ${message}`);
      }
      await ensureAssets(true);
      return textResult({
        asset:
          typeof payload === 'object' && payload !== null && 'asset' in payload
            ? (payload as { asset: unknown }).asset
            : asset,
        deduped:
          typeof payload === 'object' && payload !== null && 'deduped' in payload
            ? Boolean((payload as { deduped: unknown }).deduped)
            : false,
        warnings,
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'asset import failed');
    }
  },
);

async function relayGet(path: string): Promise<unknown> {
  const response = await fetch(`${relayUrl}${path}`, { headers: relayHeaders() });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `relay responded ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

server.registerTool(
  'timeline_list_revisions',
  {
    title: 'List project revisions',
    description:
      'List recent snapshots for a project. Every publish creates a snapshot in the same SQLite transaction; the latest 50 are retained.',
    inputSchema: {
      project_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async (args) => {
    try {
      const projectId = args.project_id
        ? normalizeProjectId(args.project_id)
        : state.projectId ?? DEFAULT_PROJECT_ID;
      const data = await relayGet(
        `/api/projects/${encodeURIComponent(projectId)}/revisions?limit=${args.limit ?? 20}`,
      );
      return textResult(data);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'revision list failed');
    }
  },
);

server.registerTool(
  'timeline_get_revision',
  {
    title: 'Get project revision',
    description:
      'Read one historical snapshot by history_id, including its full timeline document. Use timeline_list_revisions first.',
    inputSchema: {
      history_id: z.number().int().positive(),
      project_id: z.string().min(1).optional(),
    },
  },
  async (args) => {
    try {
      const projectId = args.project_id
        ? normalizeProjectId(args.project_id)
        : state.projectId ?? DEFAULT_PROJECT_ID;
      const data = await relayGet(
        `/api/projects/${encodeURIComponent(projectId)}/revisions/${args.history_id}`,
      );
      if (
        typeof data !== 'object' ||
        data === null ||
        !isTimelineDocument((data as { timeline?: unknown }).timeline)
      ) {
        throw new Error('relay returned an invalid revision');
      }
      return textResult(data);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'revision load failed');
    }
  },
);

server.registerTool(
  'timeline_restore_revision',
  {
    title: 'Restore project revision',
    description:
      'Restore an earlier snapshot by publishing it as a new revision. History is append-only: this never deletes or rewinds the revision log. expected_revision protects concurrent edits.',
    inputSchema: {
      history_id: z.number().int().positive(),
      project_id: z.string().min(1).optional(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) => {
    const guard = revisionGuard(args.expected_revision);
    if (guard) return guard;
    try {
      const projectId = args.project_id
        ? normalizeProjectId(args.project_id)
        : state.projectId ?? DEFAULT_PROJECT_ID;
      const data = await relayGet(
        `/api/projects/${encodeURIComponent(projectId)}/revisions/${args.history_id}`,
      );
      if (
        typeof data !== 'object' ||
        data === null ||
        !isTimelineDocument((data as { timeline?: unknown }).timeline)
      ) {
        throw new Error('relay returned an invalid revision');
      }
      const record = data as {
        history_id?: unknown;
        revision?: unknown;
        title?: unknown;
        timeline: TimelineDocument;
      };
      const title =
        typeof record.title === 'string' && record.title.length > 0
          ? record.title
          : state.title;
      const restored: TimelineDocument = {
        ...structuredClone(record.timeline),
        revision: state.document.revision + 1,
      };
      const expected = args.expected_revision ?? state.document.revision;
      const outcome = await publishSnapshot(title, restored, expected, projectId);
      if (outcome.status !== 'published') {
        return failure(
          outcome.status === 'conflict' ? 'revision_conflict' : 'relay_rejected',
          {
            expected_revision: expected,
            current_revision:
              outcome.status === 'conflict'
                ? outcome.currentRevision
                : state.document.revision,
            relay: outcome.error,
            hint: 'No local state was changed. Call timeline_load_project to sync the relay revision, then retry.',
          },
        );
      }
      state = {
        projectId,
        title,
        document: restored,
        updatedAt: new Date().toISOString(),
      };
      await saveState();
      return textResult({
        restored_from_history_id: args.history_id,
        restored_from_revision: record.revision,
        project_id: projectId,
        title,
        summary: summarizeDocument(restored),
        published: publishPayload(outcome),
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'revision restore failed');
    }
  },
);

server.registerTool(
  'timeline_compose',
  {
    title: 'Compose timeline from brief',
    description:
      'Build a validated timeline from a brief: select video assets by keyword, fill V1 slots, add available overlays, auto-selected voiceover, music with ducking under the voice and SFX on cuts. Deterministic and rule-based, not generative. platform controls render dimensions when render=true. Set render=true to enqueue the composed result immediately.',
    inputSchema: {
      brief: z.string().min(3).max(2_000),
      duration_s: z.number().positive().max(300).optional(),
      asset_ids: z.array(z.string().min(1)).max(20).optional(),
      music_asset_id: z.string().min(1).optional(),
      voiceover_asset_id: z.string().min(1).optional(),
      sfx_asset_id: z.string().min(1).optional(),
      tone: z.enum(['energetic', 'calm', 'documentary']).optional(),
      platform: z.enum(['landscape', 'vertical', 'square']).optional(),
      render: z.boolean().optional(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) => {
    await ensureAssets(true);
    try {
      const result = composeDocument({
        brief: args.brief,
        durationUS:
          args.duration_s === undefined
            ? state.document.duration_us
            : secondsToUS(args.duration_s),
        assets: allAssets(),
        assetIds: args.asset_ids,
        musicAssetId: args.music_asset_id,
        voiceoverAssetId: args.voiceover_asset_id,
        sfxAssetId: args.sfx_asset_id,
        tone: args.tone,
        platform: args.platform,
      });
      const committed = await commit(
        result.document,
        { composition: result.notes },
        { expectedRevision: args.expected_revision },
      );
      if ('isError' in committed && committed.isError) return committed;

      if (args.render) {
        try {
          const platform = args.platform ?? 'landscape';
          const job = await enqueueRender({
            timeline: state.document,
            projectId: state.projectId ?? DEFAULT_PROJECT_ID,
            title: state.title,
            width: platform === 'vertical' ? 720 : platform === 'square' ? 1080 : 1280,
            height: platform === 'vertical' ? 1280 : platform === 'square' ? 1080 : 720,
          });
          return textResult({
            project_id: state.projectId,
            title: state.title,
            composition: result.notes,
            summary: summarizeDocument(state.document),
            render: job,
            queue: renderQueueStats(),
          });
        } catch (error) {
          return failure('timeline composed but render enqueue failed', {
            project_id: state.projectId,
            composition: result.notes,
            error: error instanceof Error ? error.message : 'render enqueue failed',
          });
        }
      }

      return textResult({
        project_id: state.projectId,
        title: state.title,
        composition: result.notes,
        summary: summarizeDocument(state.document),
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'compose failed');
    }
  },
);

server.registerTool(
  'timeline_add_video_clip',
  {
    title: 'Add video clip',
    description:
      'Append a video segment. Use start_frame/duration_frames for exact frame positions or start_s/duration_s for seconds. expected_revision prevents overwriting a newer edit.',
    inputSchema: {
      asset_id: z.string().min(1),
      ...startFields,
      ...durationFields,
      ...sourceInFields,
      audio_enabled: z.boolean().optional(),
      audio_gain: z.number().nonnegative().optional(),
      segment_id: z.string().min(1).optional(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const startUS = requireUS(document, args.start_frame, args.start_s, 'start');
      const durationUS = requireUS(document, args.duration_frames, args.duration_s, 'duration');
      const sourceInUS = resolveUS(document, args.source_in_frame, args.source_in_s, 'source_in');
      const result = addVideoClipUS(document, {
        assetId: args.asset_id,
        startUS,
        durationUS,
        sourceInUS,
        audioEnabled: args.audio_enabled,
        audioGain: args.audio_gain,
        segmentId: args.segment_id,
      });
      return { document: result.document, extra: { clip: result.clip } };
    }),
);

server.registerTool(
  'timeline_add_audio_clip',
  {
    title: 'Add audio clip',
    description:
      'Add a voiceover, music or SFX placement to its canonical track. Use frame or second arguments; expected_revision protects concurrent edits.',
    inputSchema: {
      kind: z.enum(['voiceover', 'music', 'sfx']),
      asset_id: z.string().min(1),
      ...startFields,
      ...durationFields,
      ...sourceInFields,
      gain: z.number().nonnegative().optional(),
      clip_id: z.string().min(1).optional(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const startUS = requireUS(document, args.start_frame, args.start_s, 'start');
      const durationUS = requireUS(document, args.duration_frames, args.duration_s, 'duration');
      const sourceInUS = resolveUS(document, args.source_in_frame, args.source_in_s, 'source_in');
      const result = addAudioClipUS(document, {
        kind: args.kind,
        assetId: args.asset_id,
        startUS,
        durationUS,
        sourceInUS,
        gain: args.gain,
        clipId: args.clip_id,
      });
      return { document: result.document, extra: { clip: result.clip } };
    }),
);

server.registerTool(
  'timeline_add_overlay_clip',
  {
    title: 'Add overlay clip',
    description:
      'Add a V2 visual overlay above the main video. The overlay is composited with screen or normal blend; use frame or second arguments and expected_revision for concurrency.',
    inputSchema: {
      asset_id: z.string().min(1),
      ...startFields,
      ...durationFields,
      ...sourceInFields,
      opacity: z.number().min(0).max(1).optional(),
      blend_mode: z.enum(['screen', 'normal']).optional(),
      overlay_id: z.string().min(1).optional(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) => {
    await ensureAssets();
    return withEdit(args.expected_revision, (document) => {
      const asset = assetById(args.asset_id);
      if (!asset || asset.kind !== 'overlay') {
        throw new Error(`overlay asset not found: ${args.asset_id}`);
      }
      const startUS = requireUS(document, args.start_frame, args.start_s, 'start');
      const durationUS = requireUS(document, args.duration_frames, args.duration_s, 'duration');
      const sourceInUS = resolveUS(document, args.source_in_frame, args.source_in_s, 'source_in');
      const result = addOverlayClipUS(document, {
        assetId: args.asset_id,
        startUS,
        durationUS,
        sourceInUS,
        opacity: args.opacity,
        blendMode: args.blend_mode,
        overlayId: args.overlay_id,
      });
      return { document: result.document, extra: { clip: result.clip } };
    });
  },
);

server.registerTool(
  'timeline_move_clip',
  {
    title: 'Move clip',
    description:
      'Move a video or audio clip to a new absolute timeline start. Use start_frame for exact placement; expected_revision guards concurrency.',
    inputSchema: {
      clip_id: z.string().min(1),
      ...startFields,
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const startUS = requireUS(document, args.start_frame, args.start_s, 'start');
      const result = moveClipUS(document, args.clip_id, startUS);
      return { document: result.document, extra: { clip: result.clip } };
    }),
);

server.registerTool(
  'timeline_trim_clip',
  {
    title: 'Trim clip',
    description:
      'Trim a clip start, duration and/or source-in point. Frame arguments are exact; duration updates the source window.',
    inputSchema: {
      clip_id: z.string().min(1),
      ...startFields,
      ...durationFields,
      ...sourceInFields,
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const startUS = resolveUS(document, args.start_frame, args.start_s, 'start');
      const durationUS = resolveUS(document, args.duration_frames, args.duration_s, 'duration');
      const sourceInUS = resolveUS(document, args.source_in_frame, args.source_in_s, 'source_in');
      if (startUS === undefined && durationUS === undefined && sourceInUS === undefined) {
        throw new Error('at least one of start, duration or source_in is required');
      }
      const result = trimClipUS(document, args.clip_id, { startUS, durationUS, sourceInUS });
      return { document: result.document, extra: { clip: result.clip } };
    }),
);

server.registerTool(
  'timeline_set_audio_gain',
  {
    title: 'Set audio gain',
    description: 'Set the gain of a voiceover, music or SFX clip.',
    inputSchema: {
      clip_id: z.string().min(1),
      gain: z.number().nonnegative(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const result = setAudioGain(document, args.clip_id, args.gain);
      return { document: result.document, extra: { clip: result.clip } };
    }),
);

server.registerTool(
  'timeline_remove_clip',
  {
    title: 'Remove clip',
    description: 'Remove a video segment or audio clip by id.',
    inputSchema: {
      clip_id: z.string().min(1),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const result = removeClip(document, args.clip_id);
      return {
        document: result.document,
        extra: { removed: { group: result.removed.group, clip: result.removed.clip } },
      };
    }),
);

server.registerTool(
  'timeline_set_duration',
  {
    title: 'Set timeline duration',
    description: 'Set the sequence duration. Use duration_frames or duration_s; clips must fit inside it.',
    inputSchema: {
      ...durationFields,
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const durationUS = requireUS(document, args.duration_frames, args.duration_s, 'duration');
      return { document: setDurationUS(document, durationUS) };
    }),
);

server.registerTool(
  'timeline_set_frame_rate',
  {
    title: 'Set timeline frame rate',
    description:
      'Set the exact rational frame rate used by frame arguments and OTIO metadata, e.g. 30000/1001 for NTSC. Clip times do not move.',
    inputSchema: {
      numerator: z.number().int().positive(),
      denominator: z.number().int().positive(),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      const frameRate: FrameRate = {
        numerator: args.numerator,
        denominator: args.denominator,
      };
      return {
        document: setFrameRate(document, frameRate),
        extra: { frame_rate: frameRate },
      };
    }),
);

server.registerTool(
  'timeline_set_title',
  {
    title: 'Set project title',
    description: 'Change the title shown by the editor and the project library.',
    inputSchema: {
      title: z.string().min(1),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) => {
    const guard = revisionGuard(args.expected_revision);
    if (guard) return guard;
    const outcome = await publishSnapshot(
      args.title,
      state.document,
      args.expected_revision ?? state.document.revision,
      state.projectId ?? DEFAULT_PROJECT_ID,
    );
    if (outcome.status === 'conflict' || outcome.status === 'rejected') {
      return failure(outcome.status === 'conflict' ? 'revision_conflict' : 'relay_rejected', {
        expected_revision: args.expected_revision,
        current_revision:
          outcome.status === 'conflict' ? outcome.currentRevision : state.document.revision,
        relay: outcome.error,
        hint: 'The title was not changed locally. Call timeline_load_project to sync the relay revision, then retry.',
      });
    }
    state = { ...state, title: args.title, updatedAt: new Date().toISOString() };
    await saveState();
    return textResult({
      title: state.title,
      summary: summarizeDocument(state.document),
      published: publishPayload(outcome),
    });
  },
);

server.registerTool(
  'timeline_replace_document',
  {
    title: 'Replace timeline document',
    description:
      'Replace the whole project from a JSON string. The document is validated before publishing; expected_revision prevents overwriting concurrent work.',
    inputSchema: {
      json: z.string().min(2),
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) => {
    try {
      const parsed: unknown = JSON.parse(args.json);
      if (!isTimelineDocument(parsed)) return failure('invalid timeline document shape');
      return await withEdit(args.expected_revision, () => ({ document: parsed }));
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'invalid JSON');
    }
  },
);

server.registerTool(
  'timeline_apply_transaction',
  {
    title: 'Apply atomic timeline transaction',
    description:
      'Apply an ordered list of edits atomically as one revision. If any operation fails, or expected_revision is stale, no local or relay state is changed.',
    inputSchema: {
      expected_revision: expectedRevisionSchema,
      operations: z.array(transactionOperationSchema).min(1).max(100),
    },
  },
  async (args) =>
    withEdit(args.expected_revision, (document) => {
      let draft = document;
      const applied: Array<Record<string, unknown>> = [];

      args.operations.forEach((operation, index) => {
        try {
          switch (operation.type) {
            case 'add_video': {
              const startUS = requireUS(draft, operation.start_frame, operation.start_s, 'start');
              const durationUS = requireUS(
                draft,
                operation.duration_frames,
                operation.duration_s,
                'duration',
              );
              const sourceInUS = operationTime(draft, operation, 'source_in');
              const result = addVideoClipUS(draft, {
                assetId: requireString(operation.asset_id, 'asset_id'),
                startUS,
                durationUS,
                sourceInUS,
                audioEnabled: operation.audio_enabled,
                audioGain: operation.audio_gain,
                segmentId: operation.segment_id,
              });
              draft = result.document;
              applied.push({
                index,
                type: operation.type,
                clip_id: result.clip.segment_id,
                start_us: result.clip.timeline_start_us,
                duration_us: result.clip.timeline_duration_us,
              });
              break;
            }
            case 'add_audio': {
              const startUS = requireUS(draft, operation.start_frame, operation.start_s, 'start');
              const durationUS = requireUS(
                draft,
                operation.duration_frames,
                operation.duration_s,
                'duration',
              );
              const sourceInUS = operationTime(draft, operation, 'source_in');
              const result = addAudioClipUS(draft, {
                kind:
                  operation.kind ??
                  (() => {
                    throw new Error('kind is required for add_audio');
                  })(),
                assetId: requireString(operation.asset_id, 'asset_id'),
                startUS,
                durationUS,
                sourceInUS,
                gain: operation.gain,
                clipId: operation.clip_id,
              });
              draft = result.document;
              applied.push({
                index,
                type: operation.type,
                clip_id: result.clip.track_id,
                start_us: result.clip.timeline_start_us,
                duration_us: result.clip.timeline_duration_us,
              });
              break;
            }
            case 'move': {
              const startUS = requireUS(draft, operation.start_frame, operation.start_s, 'start');
              const result = moveClipUS(
                draft,
                requireString(operation.clip_id, 'clip_id'),
                startUS,
              );
              draft = result.document;
              applied.push({ index, type: operation.type, clip_id: operation.clip_id, start_us: startUS });
              break;
            }
            case 'trim': {
              const startUS = resolveUS(draft, operation.start_frame, operation.start_s, 'start');
              const durationUS = resolveUS(
                draft,
                operation.duration_frames,
                operation.duration_s,
                'duration',
              );
              const sourceInUS = operationTime(draft, operation, 'source_in');
              if (startUS === undefined && durationUS === undefined && sourceInUS === undefined) {
                throw new Error('trim requires start, duration or source_in');
              }
              const result = trimClipUS(
                draft,
                requireString(operation.clip_id, 'clip_id'),
                { startUS, durationUS, sourceInUS },
              );
              draft = result.document;
              applied.push({ index, type: operation.type, clip_id: operation.clip_id });
              break;
            }
            case 'set_gain': {
              const result = setAudioGain(
                draft,
                requireString(operation.clip_id, 'clip_id'),
                operation.gain ?? 1,
              );
              draft = result.document;
              applied.push({
                index,
                type: operation.type,
                clip_id: operation.clip_id,
                gain: result.clip.gain,
              });
              break;
            }
            case 'remove': {
              const result = removeClip(
                draft,
                requireString(operation.clip_id, 'clip_id'),
              );
              draft = result.document;
              applied.push({
                index,
                type: operation.type,
                removed: { group: result.removed.group, clip: result.removed.clip },
              });
              break;
            }
            case 'set_duration': {
              const durationUS = requireUS(
                draft,
                operation.duration_frames,
                operation.duration_s,
                'duration',
              );
              draft = setDurationUS(draft, durationUS);
              applied.push({ index, type: operation.type, duration_us: durationUS });
              break;
            }
          }
        } catch (error) {
          throw new Error(
            `operations[${index}] ${operation.type}: ${
              error instanceof Error ? error.message : 'failed'
            }`,
          );
        }
      });

      draft = { ...draft, revision: document.revision + 1 };
      return { document: draft, extra: { applied_operations: applied } };
    }),
);

server.registerTool(
  'timeline_validate',
  {
    title: 'Validate timeline',
    description: 'Run structural validation and return every violation plus a summary.',
    inputSchema: {},
  },
  async () => {
    const errors = validateTimeline(state.document);
    return textResult({
      valid: errors.length === 0,
      errors,
      summary: summarizeDocument(state.document),
    });
  },
);

server.registerTool(
  'timeline_convert_time',
  {
    title: 'Convert timeline time',
    description:
      'Convert once between frame index, integer microseconds and seconds using the project rational frame rate.',
    inputSchema: {
      frame: z.number().int().nonnegative().optional(),
      us: z.number().int().nonnegative().optional(),
      seconds: z.number().nonnegative().optional(),
    },
  },
  async (args) => {
    const supplied = [args.frame, args.us, args.seconds].filter(
      (value) => value !== undefined,
    ).length;
    if (supplied !== 1) return failure('provide exactly one of frame, us or seconds');
    const frameRate = frameRateOf(state.document);
    const frame =
      args.frame ??
      (args.us !== undefined
        ? usToFrame(args.us, frameRate)
        : usToFrame(secondsToUS(args.seconds ?? 0), frameRate));
    const us =
      args.us ??
      (args.frame !== undefined ? frameToUS(args.frame, frameRate) : secondsToUS(args.seconds ?? 0));
    return textResult({
      frame_rate: frameRate,
      frame,
      us,
      seconds: us / 1_000_000,
      duration_frames: durationFrames(state.document.duration_us, frameRate),
      duration_us: state.document.duration_us,
    });
  },
);

server.registerTool(
  'timeline_get_frame',
  {
    title: 'Inspect rendered frame',
    description:
      'Render the active video frame at a frame index (or at_s) through the external frame inspector and return a JPEG image plus metadata. This does not modify the timeline.',
    inputSchema: {
      frame: z.number().int().nonnegative().optional(),
      at_s: z.number().nonnegative().optional(),
    },
  },
  async (args) => {
    if (args.frame !== undefined && args.at_s !== undefined) {
      return failure('use either frame or at_s, not both');
    }
    if (args.frame === undefined && args.at_s === undefined) {
      return failure('frame or at_s is required');
    }
    try {
      const frameRate = frameRateOf(state.document);
      const frame =
        args.frame ??
        usToFrame(secondsToUS(args.at_s ?? 0), frameRate);
      const result = await renderTimelineFrame(state.document, frame, { frameRate });
      return imageResult(result);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'frame render failed');
    }
  },
);

server.registerTool(
  'timeline_get_contact_sheet',
  {
    title: 'Inspect contact sheet',
    description:
      'Render a JPEG grid of active video frames between start_frame and end_frame. The sheet is capped at 16 frames; increase step_frames to cover a longer range.',
    inputSchema: {
      start_frame: z.number().int().nonnegative(),
      end_frame: z.number().int().nonnegative(),
      step_frames: z.number().int().positive().optional(),
      columns: z.number().int().min(1).max(4).optional(),
    },
  },
  async (args) => {
    try {
      const frameRate = frameRateOf(state.document);
      const result = await renderContactSheet(
        state.document,
        args.start_frame,
        args.end_frame,
        args.step_frames ?? 1,
        args.columns ?? 4,
        { frameRate },
      );
      return imageResult(result);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'contact sheet render failed');
    }
  },
);

server.registerTool(
  'timeline_render',
  {
    title: 'Queue complete timeline render',
    description:
      'Queue the complete timeline as one MP4: V1 video, V2 overlays with opacity and screen/normal blend, and a mix of voiceover, music, SFX and segment audio. Returns { job_id, status: "queued" } immediately; poll timeline_render_status for progress and completion. One FIFO worker prevents overlapping encodes. Defaults to 1280x720, the timeline frame rate, CRF 18 and renders/<project>-r<revision>.mp4. Agents call this tool; the editor has no render button.',
    inputSchema: {
      output_path: z.string().min(1).optional(),
      width: z.number().int().min(320).max(3840).optional(),
      height: z.number().int().min(180).max(2160).optional(),
      crf: z.number().int().min(0).max(51).optional(),
    },
  },
  async (args) => {
    const errors = validateTimeline(state.document);
    if (errors.length > 0) return failure(errors.join('; '));
    try {
      const job = await enqueueRender({
        timeline: state.document,
        projectId: state.projectId ?? DEFAULT_PROJECT_ID,
        title: state.title,
        outputPath: args.output_path,
        width: args.width,
        height: args.height,
        crf: args.crf,
      });
      return textResult({
        ...job,
        poll_with: 'timeline_render_status',
        cancel_with: 'timeline_render_cancel',
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'video render queue failed');
    }
  },
);

server.registerTool(
  'timeline_render_status',
  {
    title: 'Get render job status',
    description:
      'Read one render job by job_id, or list the latest jobs for the current project. Includes status, progress percent, fps, speed, ETA, output path, result or error. Poll this after timeline_render.',
    inputSchema: {
      job_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      all_projects: z.boolean().optional(),
    },
  },
  async (args) => {
    const queue = renderQueueStats();
    if (args.job_id) {
      const job = getRenderJob(args.job_id);
      if (!job) return failure('render_job_not_found', { job_id: args.job_id });
      return textResult({ job, queue });
    }
    return textResult({
      jobs: listRenderJobs({
        projectId: args.all_projects
          ? undefined
          : (state.projectId ?? DEFAULT_PROJECT_ID),
        limit: args.limit ?? 10,
      }),
      queue,
    });
  },
);

server.registerTool(
  'timeline_render_cancel',
  {
    title: 'Cancel render job',
    description:
      'Cancel a queued or running render job. A running FFmpeg process is terminated and its partial output is removed; the worker then continues with the next job.',
    inputSchema: { job_id: z.string().min(1) },
  },
  async (args) => {
    const result = await cancelRenderJob(args.job_id);
    if (!result) return failure('render_job_not_found', { job_id: args.job_id });
    return textResult({
      ...result,
      queue: renderQueueStats(),
      message: result.cancelled ? 'cancellation requested' : 'job already finished',
    });
  },
);

server.registerTool(
  'timeline_export',
  {
    title: 'Export timeline JSON',
    description:
      'Return the renderer-agnostic JSON document. It contains no renderer-specific fields.',
    inputSchema: {},
  },
  async () => textResult(JSON.stringify(state.document, null, 2)),
);

server.registerTool(
  'timeline_export_otio',
  {
    title: 'Export OpenTimelineIO',
    description:
      'Return an OpenTimelineIO-compatible Timeline JSON with V1, optional V2 overlay, A1, A2 and A3 tracks. Times use integer microseconds as OTIO RationalTime.',
    inputSchema: {},
  },
  async () => {
    await ensureAssets();
    return textResult(timelineToOTIO(state.title, state.document));
  },
);

server.registerTool(
  'timeline_publish',
  {
    title: 'Publish timeline',
    description:
      'Publish the current document to the relay used by the project editor and library. Uses the current revision as expected_revision.',
    inputSchema: {
      expected_revision: expectedRevisionSchema,
    },
  },
  async (args) => {
    const expected = args.expected_revision ?? state.document.revision;
    const outcome = await publishSnapshot(
      state.title,
      state.document,
      expected,
      state.projectId ?? DEFAULT_PROJECT_ID,
    );
    if (outcome.status === 'published') {
      state = { ...state, updatedAt: new Date().toISOString() };
      await saveState();
    }
    return textResult(publishPayload(outcome));
  },
);

server.registerResource(
  'current-timeline',
  'timeline://current',
  {
    title: 'Current timeline document',
    description: 'The renderer-agnostic document currently owned by this MCP server.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(state.document, null, 2),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[timeline-mcp] ready — state=${stateFile} relay=${relayUrl} public=${publicBase}`,
);
