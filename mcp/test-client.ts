import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_ASSETS } from '../src/timeline/assets';
import type { TimelineDocument } from '../src/timeline/document';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relayUrl = (process.env.TIMELINE_RELAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

interface ToolResult {
  content?: unknown;
  isError?: boolean;
}

interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

interface ProjectView {
  project_id: string;
  title: string;
  summary: { revision: number; frame_rate: { numerator: number; denominator: number } };
  timebase: {
    frame_rate: { numerator: number; denominator: number };
    duration_us: number;
    duration_frames: number;
  };
  document: TimelineDocument;
}

interface RenderJobView {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  output_path: string;
  progress: { percent: number; eta_seconds: number | null };
  result?: {
    bytes: number;
    overlays: number;
    audio_tracks: number;
    path: string;
  };
  error?: string;
}

function parseText(result: ToolResult): unknown {
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

function isJpeg(data: string): boolean {
  const bytes = Buffer.from(data, 'base64');
  return (
    bytes.length > 1_000 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function imageContent(result: ToolResult): ImageContent | null {
  const content = Array.isArray(result.content) ? result.content : [];
  return (
    (content.find(
      (item): item is ImageContent =>
        typeof item === 'object' &&
        item !== null &&
        (item as { type?: unknown }).type === 'image' &&
        typeof (item as { data?: unknown }).data === 'string',
    ) as ImageContent | undefined) ?? null
  );
}

async function main() {
  const jobsDir = `/tmp/velox-mcp-render-jobs-${process.pid}`;
  await rm(jobsDir, { recursive: true, force: true });
  process.env.TIMELINE_RENDER_JOBS_DIR = jobsDir;
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const transport = new StdioClientTransport({
    command: resolve(root, 'node_modules/.bin/tsx'),
    args: [resolve(root, 'mcp/server.ts')],
    cwd: root,
    env: childEnv,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'timeline-mcp-test', version: '0.1.0' });
  await client.connect(transport);

  const listed = await client.listTools();
  const requiredTools = [
    'timeline_create_project',
    'timeline_load_project',
    'timeline_add_overlay_clip',
    'timeline_apply_transaction',
    'timeline_convert_time',
    'timeline_get_frame',
    'timeline_get_contact_sheet',
    'timeline_render',
    'timeline_render_status',
    'timeline_render_cancel',
    'timeline_export_otio',
    'timeline_import_asset',
    'timeline_list_revisions',
    'timeline_get_revision',
    'timeline_restore_revision',
    'timeline_compose',
  ];
  for (const tool of requiredTools) {
    if (!listed.tools.some((candidate) => candidate.name === tool)) {
      throw new Error(`${tool} not registered`);
    }
  }

  async function raw(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return parseText(await raw(name, args));
  }

  async function project(): Promise<ProjectView> {
    return (await call('timeline_get_project', {})) as ProjectView;
  }

  async function currentRevision(): Promise<number> {
    return (await project()).summary.revision;
  }

  async function expectFailure(
    name: string,
    args: Record<string, unknown>,
    label: string,
  ): Promise<string> {
    try {
      await call(name, args);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`${label} unexpectedly succeeded`);
  }

  async function renderStatus(jobId: string): Promise<RenderJobView> {
    const response = (await call('timeline_render_status', { job_id: jobId })) as {
      job: RenderJobView;
    };
    return response.job;
  }

  async function waitForRender(
    jobId: string,
    expected: RenderJobView['status'][],
    timeoutMs = 60_000,
  ): Promise<RenderJobView> {
    const deadline = Date.now() + timeoutMs;
    let last: RenderJobView | null = null;
    while (Date.now() < deadline) {
      last = await renderStatus(jobId);
      if (expected.includes(last.status)) return last;
      if (last.status === 'failed' || last.status === 'cancelled') {
        throw new Error(`render ${jobId} ended ${last.status}: ${last.error ?? ''}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`timed out waiting for ${jobId}: ${last?.status ?? 'unknown'}`);
  }

  const created = (await call('timeline_create_project', {
    project_id: 'velox-demo',
    title: 'Velox · montaggio demo MCP',
    duration_s: 12.5,
    fps_num: 30,
    fps_den: 1,
  })) as { project_id?: string };
  if (created.project_id !== 'velox-demo') {
    throw new Error(`expected project_id velox-demo, got ${String(created.project_id)}`);
  }

  const videos = MEDIA_ASSETS.filter((asset) => asset.kind === 'video').slice(0, 5);
  for (const [index, asset] of videos.entries()) {
    await call('timeline_add_video_clip', {
      asset_id: asset.id,
      start_frame: index * 75,
      duration_frames: 75,
      segment_id: `mcp-seg-${String(index + 1).padStart(2, '0')}`,
    });
  }

  await call('timeline_add_audio_clip', {
    kind: 'voiceover',
    asset_id: 'asset-voiceover',
    start_s: 0.4,
    duration_s: 2.3,
    clip_id: 'mcp-vo-intro',
  });
  await call('timeline_add_audio_clip', {
    kind: 'voiceover',
    asset_id: 'asset-voiceover-2',
    start_s: 7.2,
    duration_s: 4.5,
    clip_id: 'mcp-vo-body',
  });
  await call('timeline_add_overlay_clip', {
    asset_id: 'asset-overlay-market',
    start_s: 1,
    duration_s: 1.75,
    overlay_id: 'mcp-overlay-1',
  });
  await call('timeline_add_audio_clip', {
    kind: 'music',
    asset_id: 'asset-music-bed',
    start_s: 0,
    duration_s: 12.5,
    gain: 0.7,
    clip_id: 'mcp-music-main',
  });
  await call('timeline_add_audio_clip', {
    kind: 'sfx',
    asset_id: 'asset-sfx-whoosh',
    start_s: 2.3,
    duration_s: 0.4,
    gain: 0.9,
    clip_id: 'mcp-sfx-1',
  });
  await call('timeline_add_audio_clip', {
    kind: 'sfx',
    asset_id: 'asset-sfx-whoosh',
    start_s: 7,
    duration_s: 0.5,
    gain: 0.9,
    clip_id: 'mcp-sfx-2',
  });

  const validation = (await call('timeline_validate', {})) as {
    valid: boolean;
    errors: string[];
    summary: {
      video_segments: number;
      overlays: number;
      voiceovers: number;
      music: number;
      sfx: number;
    };
  };
  if (!validation.valid) throw new Error(`validation failed: ${validation.errors.join('; ')}`);
  if (
    validation.summary.video_segments !== 5 ||
    validation.summary.overlays !== 1 ||
    validation.summary.voiceovers !== 2 ||
    validation.summary.music !== 1 ||
    validation.summary.sfx !== 2
  ) {
    throw new Error(`unexpected summary: ${JSON.stringify(validation.summary)}`);
  }

  // Exact rational frame rate: 30 frames at 30000/1001 is exactly 1.001s.
  let revision = await currentRevision();
  await call('timeline_set_frame_rate', {
    numerator: 30000,
    denominator: 1001,
    expected_revision: revision,
  });
  const conversion = (await call('timeline_convert_time', { frame: 30 })) as {
    us: number;
    seconds: number;
    frame_rate: { numerator: number; denominator: number };
  };
  if (conversion.us !== 1_001_000 || conversion.seconds !== 1.001) {
    throw new Error(`NTSC conversion is not exact: ${JSON.stringify(conversion)}`);
  }
  revision = await currentRevision();
  await call('timeline_set_frame_rate', {
    numerator: 30,
    denominator: 1,
    expected_revision: revision,
  });

  // One successful atomic transaction.
  revision = await currentRevision();
  const transaction = (await call('timeline_apply_transaction', {
    expected_revision: revision,
    operations: [{ type: 'move', clip_id: 'mcp-sfx-2', start_frame: 210 }],
  })) as { summary: { revision: number } };
  if (transaction.summary.revision !== revision + 1) {
    throw new Error(`transaction revision mismatch: ${JSON.stringify(transaction.summary)}`);
  }

  // A failing transaction must leave both revision and earlier operations untouched.
  revision = await currentRevision();
  const failed = await expectFailure(
    'timeline_apply_transaction',
    {
      expected_revision: revision,
      operations: [
        { type: 'move', clip_id: 'mcp-sfx-2', start_frame: 211 },
        { type: 'remove', clip_id: 'clip-that-does-not-exist' },
      ],
    },
    'failing transaction',
  );
  if (!failed.includes('operations[1]')) {
    throw new Error(`unexpected transaction error: ${failed}`);
  }
  const afterFailure = await project();
  if (afterFailure.summary.revision !== revision) {
    throw new Error('failed transaction changed the revision');
  }
  const sfx = afterFailure.document.sfx.find((clip) => clip.track_id === 'mcp-sfx-2');
  if (!sfx || sfx.timeline_start_us !== 7_000_000) {
    throw new Error('failed transaction leaked a partial move');
  }

  // Stale revision must be rejected without changing state.
  await expectFailure(
    'timeline_move_clip',
    { clip_id: 'mcp-sfx-2', start_frame: 211, expected_revision: 1 },
    'stale revision edit',
  );
  if ((await currentRevision()) !== revision) {
    throw new Error('stale revision changed the project');
  }

  const frameResult = await raw('timeline_get_frame', { frame: 0 });
  const frameMeta = parseText(frameResult) as { status: string; frame: number };
  const frameImage = imageContent(frameResult);
  if (frameMeta.status !== 'ok' || frameMeta.frame !== 0 || !frameImage) {
    throw new Error(`unexpected frame result: ${JSON.stringify(frameMeta)}`);
  }
  if (!isJpeg(frameImage.data)) {
    throw new Error('frame is not a valid JPEG');
  }

  const sheetResult = await raw('timeline_get_contact_sheet', {
    start_frame: 0,
    end_frame: 300,
    step_frames: 75,
    columns: 4,
  });
  const sheetMeta = parseText(sheetResult) as { status: string; count: number };
  const sheetImage = imageContent(sheetResult);
  if (sheetMeta.status !== 'contact_sheet' || sheetMeta.count !== 5 || !sheetImage) {
    throw new Error(`unexpected contact sheet: ${JSON.stringify(sheetMeta)}`);
  }
  if (!isJpeg(sheetImage.data)) {
    throw new Error('contact sheet is not a valid JPEG');
  }

  const renderPath = '/tmp/velox-mcp-test-render.mp4';
  const cancelPath = '/tmp/velox-mcp-test-render-cancel.mp4';
  const secondRenderPath = '/tmp/velox-mcp-test-render-2.mp4';
  const queuedCancelPath = '/tmp/velox-mcp-test-render-queued.mp4';
  for (const path of [renderPath, cancelPath, secondRenderPath, queuedCancelPath]) {
    await rm(path, { force: true }).catch(() => undefined);
  }

  const first = (await call('timeline_render', {
    width: 640,
    height: 360,
    crf: 30,
    output_path: renderPath,
  })) as RenderJobView;
  if (first.status !== 'queued' || first.output_path !== renderPath) {
    throw new Error(`unexpected first queue result: ${JSON.stringify(first)}`);
  }

  const second = (await call('timeline_render', {
    width: 1280,
    height: 720,
    crf: 28,
    output_path: cancelPath,
  })) as RenderJobView;
  if (second.status !== 'queued') {
    throw new Error(`unexpected second queue result: ${JSON.stringify(second)}`);
  }

  const queuedList = (await call('timeline_render_status', { limit: 10 })) as {
    jobs: RenderJobView[];
    queue: { pending: number; running: boolean; concurrency: number };
  };
  if (
    queuedList.jobs.length < 2 ||
    !queuedList.jobs.some((job) => job.job_id === first.job_id) ||
    !queuedList.jobs.some((job) => job.job_id === second.job_id) ||
    queuedList.queue.concurrency !== 1
  ) {
    throw new Error(`render queue listing is incomplete: ${JSON.stringify(queuedList)}`);
  }

  const firstDone = await waitForRender(first.job_id, ['completed']);
  if (
    !firstDone.result ||
    firstDone.result.bytes < 10_000 ||
    firstDone.result.overlays !== 1 ||
    firstDone.result.audio_tracks !== 5 ||
    firstDone.result.path !== renderPath ||
    firstDone.progress.percent !== 100
  ) {
    throw new Error(`unexpected first render: ${JSON.stringify(firstDone)}`);
  }
  const firstStat = await stat(renderPath);
  if (firstStat.size !== firstDone.result.bytes) {
    throw new Error('first render byte count does not match the file');
  }

  // The second job must wait for the first; cancel it while FFmpeg is running.
  await waitForRender(second.job_id, ['running']);
  const cancelled = (await call('timeline_render_cancel', {
    job_id: second.job_id,
  })) as { cancelled: boolean; job: RenderJobView };
  if (!cancelled.cancelled || cancelled.job.status !== 'cancelled') {
    throw new Error(`running render was not cancelled: ${JSON.stringify(cancelled)}`);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  let cancelledOutputExists = true;
  try {
    await stat(cancelPath);
  } catch {
    cancelledOutputExists = false;
  }
  if (cancelledOutputExists) {
    throw new Error('cancelled render left a final MP4');
  }

  const third = (await call('timeline_render', {
    width: 640,
    height: 360,
    crf: 30,
    output_path: secondRenderPath,
  })) as RenderJobView;
  const fourth = (await call('timeline_render', {
    width: 320,
    height: 180,
    crf: 35,
    output_path: queuedCancelPath,
  })) as RenderJobView;
  const queuedCancelled = (await call('timeline_render_cancel', {
    job_id: fourth.job_id,
  })) as { cancelled: boolean; job: RenderJobView };
  if (!queuedCancelled.cancelled || queuedCancelled.job.status !== 'cancelled') {
    throw new Error(`queued render was not cancelled: ${JSON.stringify(queuedCancelled)}`);
  }

  const thirdDone = await waitForRender(third.job_id, ['completed']);
  if (
    !thirdDone.result ||
    thirdDone.result.bytes < 10_000 ||
    thirdDone.result.path !== secondRenderPath
  ) {
    throw new Error(`unexpected third render: ${JSON.stringify(thirdDone)}`);
  }

  for (const path of [renderPath, cancelPath, secondRenderPath, queuedCancelPath]) {
    await rm(path, { force: true }).catch(() => undefined);
  }
  await rm(jobsDir, { recursive: true, force: true }).catch(() => undefined);

  const otio = (await call('timeline_export_otio', {})) as {
    OTIO_SCHEMA: string;
    tracks: { children: unknown[] };
  };
  if (otio.OTIO_SCHEMA !== 'Timeline.1' || otio.tracks.children.length !== 5) {
    throw new Error('OTIO export has the wrong shape');
  }

  const published = (await call('timeline_publish', {})) as {
    ok: boolean;
    url: string;
    error?: string;
  };
  if (!published.ok) throw new Error(`publish failed: ${published.error}`);
  if (!published.url.includes('project=')) {
    throw new Error(`unexpected public URL: ${published.url}`);
  }

  // Simulate a second client publishing the same project, then verify that the
  // local MCP state can detect the conflict and resync explicitly from the relay.
  const remoteSnapshotResponse = await fetch(`${relayUrl}/api/projects/velox-demo`);
  if (!remoteSnapshotResponse.ok) {
    throw new Error(`unable to read relay project: ${remoteSnapshotResponse.status}`);
  }
  const remoteSnapshot = (await remoteSnapshotResponse.json()) as {
    title: string;
    timeline: TimelineDocument;
  };
  const remoteRevision = remoteSnapshot.timeline.revision;
  const remoteTitle = `${remoteSnapshot.title} · remote`;
  const remotePublish = await fetch(`${relayUrl}/api/projects/velox-demo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: 'velox-demo',
      title: remoteTitle,
      timeline: { ...remoteSnapshot.timeline, revision: remoteRevision + 1 },
      playhead_us: 0,
      updatedAt: new Date().toISOString(),
      expected_revision: remoteRevision,
    }),
  });
  if (!remotePublish.ok) {
    throw new Error(`unable to simulate remote edit: ${remotePublish.status}`);
  }

  const staleTitle = await expectFailure(
    'timeline_set_title',
    { title: 'stale title', expected_revision: remoteRevision },
    'stale title after remote edit',
  );
  if (!staleTitle.includes('revision_conflict')) {
    throw new Error(`unexpected remote-conflict error: ${staleTitle}`);
  }

  const loaded = (await call('timeline_load_project', {
    project_id: 'velox-demo',
  })) as ProjectView;
  if (loaded.title !== remoteTitle || loaded.summary.revision !== remoteRevision + 1) {
    throw new Error(`relay load did not sync: ${JSON.stringify(loaded)}`);
  }

  await call('timeline_set_title', {
    title: remoteSnapshot.title,
    expected_revision: loaded.summary.revision,
  });

  const finalProject = await project();
  if (
    finalProject.summary.frame_rate.numerator !== 30 ||
    finalProject.summary.frame_rate.denominator !== 1
  ) {
    throw new Error(`unexpected final frame rate: ${JSON.stringify(finalProject.summary.frame_rate)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      tools: listed.tools.map((tool) => tool.name),
      validation,
      final_revision: finalProject.summary.revision,
      frame_bytes: Buffer.from(frameImage.data, 'base64').length,
      sheet_bytes: Buffer.from(sheetImage.data, 'base64').length,
      render_bytes: firstDone.result.bytes,
      render_jobs: queuedList.jobs.length,
      cancelled_job: cancelled.job.status,
      queued_cancel: queuedCancelled.job.status,
      otio_tracks: otio.tracks.children.length,
    }),
  );
  await client.close();
  console.log('MCP_TEST_OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
