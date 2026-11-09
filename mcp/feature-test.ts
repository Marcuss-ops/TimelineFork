import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = `/tmp/velox-feature-${process.pid}`;
const relayPort = 8793;
const relayUrl = `http://127.0.0.1:${relayPort}`;
const token = 'feature-test-token';

interface ToolResult {
  content?: unknown;
  isError?: boolean;
}

function parseText(result: ToolResult): any {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find(
    (item): item is { type: 'text'; text: string } =>
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string',
  )?.text;
  if (result.isError) throw new Error(text ?? 'MCP tool failed');
  return text ? JSON.parse(text) : null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForRelay(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${relayUrl}/api/projects`);
      if (response.ok) return;
    } catch {
      // Retry while the process opens SQLite.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('relay did not start');
}

async function main() {
  await rm(temp, { recursive: true, force: true });
  await mkdir(resolve(temp, 'media'), { recursive: true });

  const relay = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', resolve(root, 'server/live-server.mjs')],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(relayPort),
        TIMELINE_DB_FILE: resolve(temp, 'projects.sqlite'),
        TIMELINE_PROJECTS_FILE: resolve(temp, 'missing-legacy.json'),
        TIMELINE_MEDIA_ROOT: resolve(temp, 'media'),
        TIMELINE_RELAY_TOKEN: token,
        TIMELINE_WRITE_RATE_LIMIT: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let relayError = '';
  relay.stderr?.setEncoding('utf8');
  relay.stderr?.on('data', (chunk: string) => {
    relayError += chunk;
  });

  let client: Client | null = null;
  try {
    await waitForRelay();

    const unauthorized = await fetch(`${relayUrl}/api/projects/auth-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'probe',
        timeline: { revision: 1, duration_us: 1_000_000, segments: [] },
      }),
    });
    assert(unauthorized.status === 401, `expected 401, got ${unauthorized.status}`);

    const publicAssets = await fetch(`${relayUrl}/api/assets`);
    assert(publicAssets.status === 200, 'assets endpoint should be public');

    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const transport = new StdioClientTransport({
      command: resolve(root, 'node_modules/.bin/tsx'),
      args: [resolve(root, 'mcp/server.ts')],
      cwd: root,
      env: {
        ...env,
        TIMELINE_RELAY_URL: relayUrl,
        TIMELINE_PUBLIC_URL: relayUrl,
        TIMELINE_RELAY_TOKEN: token,
        TIMELINE_STATE_FILE: resolve(temp, 'mcp-state.json'),
        TIMELINE_MEDIA_ROOT: resolve(temp, 'media'),
        TIMELINE_RENDER_JOBS_DIR: resolve(temp, 'render-jobs'),
      },
      stderr: 'inherit',
    });
    client = new Client({ name: 'velox-feature-test', version: '0.1.0' });
    await client.connect(transport);

    async function call(name: string, args: Record<string, unknown>): Promise<any> {
      return parseText((await client!.callTool({ name, arguments: args })) as ToolResult);
    }

    const tools = await client.listTools();
    for (const name of [
      'timeline_import_asset',
      'timeline_list_revisions',
      'timeline_get_revision',
      'timeline_restore_revision',
      'timeline_compose',
    ]) {
      assert(tools.tools.some((tool) => tool.name === name), `${name} not registered`);
    }

    await call('timeline_create_project', {
      project_id: 'feature-test',
      title: 'Feature Test',
      duration_s: 8,
    });

    const source = resolve(root, 'public/media/real/earth-blue-marble.mp4');
    await stat(source);
    const imported = await call('timeline_import_asset', {
      source_path: source,
      name: 'Imported Earth',
      poster_at_s: 0.5,
      proxy: true,
    });
    assert(imported.asset?.sha256?.length === 64, 'import did not return a SHA-256');
    assert(imported.asset?.posterUrl, 'import did not generate a poster');
    assert(imported.asset?.proxyUrl, 'import did not generate a proxy');

    const mediaResponse = await fetch(`${relayUrl}${imported.asset.url}`);
    assert(mediaResponse.status === 200, `relay did not serve imported media (${mediaResponse.status})`);
    assert(
      Number(mediaResponse.headers.get('content-length') ?? 0) > 1000,
      'imported media response is empty',
    );

    const proxyResponse = await fetch(`${relayUrl}${imported.asset.proxyUrl}`);
    assert(proxyResponse.status === 200, 'relay did not serve the proxy');

    const duplicate = await call('timeline_import_asset', {
      source_path: source,
      name: 'Imported Earth duplicate',
    });
    assert(duplicate.deduped === true, 'second import was not deduplicated');
    assert(duplicate.asset.id === imported.asset.id, 'dedupe returned a different asset');

    await call('timeline_add_video_clip', {
      asset_id: imported.asset.id,
      start_s: 0,
      duration_s: 2.5,
      segment_id: 'feature-segment',
    });

    const frameResult = (await client.callTool({
      name: 'timeline_get_frame',
      arguments: { frame: 15 },
    })) as ToolResult;
    const frameImage = Array.isArray(frameResult.content)
      ? frameResult.content.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'image',
        )
      : null;
    assert(frameImage, 'frame inspector did not return an image');

    const render = await call('timeline_render', {
      output_path: resolve(temp, 'render.mp4'),
      width: 320,
      height: 180,
      crf: 30,
    });
    let renderJob = render;
    const renderDeadline = Date.now() + 60_000;
    while (Date.now() < renderDeadline) {
      renderJob = await call('timeline_render_status', { job_id: render.job_id });
      if (renderJob.job.status === 'completed') break;
      if (renderJob.job.status === 'failed' || renderJob.job.status === 'cancelled') {
        throw new Error(`render ended ${renderJob.job.status}: ${renderJob.job.error ?? ''}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    assert(renderJob.job.status === 'completed', 'render did not complete');
    const rendered = await stat(resolve(temp, 'render.mp4'));
    assert(rendered.size > 1_000, 'render output is empty');

    const revisions = await call('timeline_list_revisions', { limit: 20 });
    assert(revisions.revisions.length >= 2, 'history did not record both publishes');
    const beforeClip = revisions.revisions[revisions.revisions.length - 1];
    const loaded = await call('timeline_get_revision', { history_id: beforeClip.history_id });
    assert(loaded.timeline.segments.length === 0, 'old revision should have no clips');

    const restored = await call('timeline_restore_revision', {
      history_id: beforeClip.history_id,
    });
    assert(
      restored.summary.video_segments === 0,
      'restore did not apply the historical snapshot',
    );

    const composed = await call('timeline_compose', {
      brief: 'earth ocean and maps, measured documentary rhythm',
      duration_s: 5,
      asset_ids: [imported.asset.id],
      tone: 'documentary',
      platform: 'vertical',
    });
    assert(composed.summary.video_segments >= 1, 'compose placed no video');
    assert(composed.composition.music, 'compose did not choose music');
    assert(composed.composition.voiceover, 'compose did not choose voiceover');
    assert(composed.composition.ducked === true, 'music was not ducked under voiceover');
    assert(composed.composition.platform === 'vertical', 'compose ignored platform');
    assert(composed.summary.sfx >= 1, 'compose placed no SFX');

    const afterCompose = await call('timeline_get_project', {});
    assert(afterCompose.document.segments[0].asset_id === imported.asset.id, 'compose did not use imported asset');

    console.log(
      JSON.stringify(
        {
          result: 'FEATURE_TEST_OK',
          imported_asset: imported.asset.id,
          poster: imported.asset.posterUrl,
          render_bytes: rendered.size,
          revisions: revisions.revisions.length,
          restored_revision: restored.published.revision,
          composed: composed.summary,
          warnings: composed.composition.warnings,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await client?.close();
    } catch {
      // Best effort.
    }
    relay.kill('SIGTERM');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    if (relayError) console.error(relayError.trim());
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
