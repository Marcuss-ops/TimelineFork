import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimelineDocument } from '../src/timeline/document';
import {
  renderTimelineVideo,
  resolveRenderOutputPath,
  type VideoRenderProgress,
  type VideoRenderResult,
} from './render';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const jobsDir = process.env.TIMELINE_RENDER_JOBS_DIR
  ? resolve(process.env.TIMELINE_RENDER_JOBS_DIR)
  : resolve(projectRoot, '.data/render-jobs');
const MAX_PENDING = 8;
const MAX_JOB_HISTORY = 50;

export type RenderJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RenderJobView {
  job_id: string;
  project_id: string;
  title: string;
  revision: number;
  status: RenderJobStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  output_path: string;
  width: number;
  height: number;
  crf: number;
  progress: VideoRenderProgress;
  result?: VideoRenderResult;
  error?: string;
  warnings?: string[];
}

export interface EnqueuedRenderJob extends RenderJobView {
  /** Jobs that must finish before this one starts. */
  queued_ahead: number;
}

interface RenderJobRecord {
  job_id: string;
  project_id: string;
  title: string;
  revision: number;
  status: RenderJobStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  output_path: string;
  temp_path?: string;
  width: number;
  height: number;
  crf: number;
  progress: VideoRenderProgress;
  result?: VideoRenderResult;
  error?: string;
  warnings?: string[];
  /** Kept in memory only: a restarted server marks unfinished jobs failed. */
  timeline?: TimelineDocument;
}

export interface EnqueueRenderInput {
  timeline: TimelineDocument;
  projectId: string;
  title: string;
  outputPath?: string;
  width?: number;
  height?: number;
  crf?: number;
}

const jobs = new Map<string, RenderJobRecord>();
const pending: string[] = [];
const controllers = new Map<string, AbortController>();
const persistChains = new Map<string, Promise<void>>();
let runningJobId: string | null = null;
let working = false;

function cancellationRequested(
  job: RenderJobRecord,
  controller: AbortController,
): boolean {
  return controller.signal.aborted || job.status === 'cancelled';
}

function emptyProgress(): VideoRenderProgress {
  return {
    percent: 0,
    out_time_us: 0,
    fps: 0,
    speed: 0,
    eta_seconds: null,
  };
}

function jobPath(jobId: string): string {
  return join(jobsDir, `${jobId}.json`);
}

function serializeJob(job: RenderJobRecord): Omit<RenderJobRecord, 'timeline'> {
  const record: RenderJobRecord = { ...job };
  delete record.timeline;
  return record;
}

async function writeJobSnapshot(job: RenderJobRecord): Promise<void> {
  await mkdir(jobsDir, { recursive: true });
  const target = jobPath(job.job_id);
  const temp = join(jobsDir, `.${job.job_id}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temp, `${JSON.stringify(serializeJob(job), null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

/** Serialize writes per job so a late progress update cannot overwrite completion. */
function persistJob(job: RenderJobRecord): Promise<void> {
  const previous = persistChains.get(job.job_id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => writeJobSnapshot(job));
  persistChains.set(job.job_id, next);
  return next.finally(() => {
    if (persistChains.get(job.job_id) === next) {
      persistChains.delete(job.job_id);
    }
  });
}

function toView(job: RenderJobRecord): RenderJobView {
  return {
    job_id: job.job_id,
    project_id: job.project_id,
    title: job.title,
    revision: job.revision,
    status: job.status,
    created_at: job.created_at,
    ...(job.started_at ? { started_at: job.started_at } : {}),
    ...(job.finished_at ? { finished_at: job.finished_at } : {}),
    output_path: job.output_path,
    width: job.width,
    height: job.height,
    crf: job.crf,
    progress: { ...job.progress },
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.warnings ? { warnings: job.warnings } : {}),
  };
}

function isStatus(value: unknown): value is RenderJobStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function normalizeProgress(value: unknown): VideoRenderProgress {
  if (typeof value !== 'object' || value === null) return emptyProgress();
  const record = value as Partial<VideoRenderProgress>;
  return {
    percent: typeof record.percent === 'number' ? record.percent : 0,
    out_time_us: typeof record.out_time_us === 'number' ? record.out_time_us : 0,
    fps: typeof record.fps === 'number' ? record.fps : 0,
    speed: typeof record.speed === 'number' ? record.speed : 0,
    eta_seconds:
      typeof record.eta_seconds === 'number' ? record.eta_seconds : null,
  };
}

function parseJob(value: unknown): RenderJobRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<RenderJobRecord>;
  if (
    typeof record.job_id !== 'string' ||
    typeof record.project_id !== 'string' ||
    typeof record.output_path !== 'string' ||
    typeof record.created_at !== 'string' ||
    !isStatus(record.status)
  ) {
    return null;
  }
  return {
    job_id: record.job_id,
    project_id: record.project_id,
    title: typeof record.title === 'string' ? record.title : '',
    revision: typeof record.revision === 'number' ? record.revision : 1,
    status: record.status,
    created_at: record.created_at,
    started_at: typeof record.started_at === 'string' ? record.started_at : undefined,
    finished_at: typeof record.finished_at === 'string' ? record.finished_at : undefined,
    output_path: record.output_path,
    temp_path: typeof record.temp_path === 'string' ? record.temp_path : undefined,
    width: typeof record.width === 'number' ? record.width : 1280,
    height: typeof record.height === 'number' ? record.height : 720,
    crf: typeof record.crf === 'number' ? record.crf : 18,
    progress: normalizeProgress(record.progress),
    result: record.result,
    error: typeof record.error === 'string' ? record.error : undefined,
    warnings: Array.isArray(record.warnings)
      ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
      : undefined,
  };
}

function compareCreatedAt(a: RenderJobRecord, b: RenderJobRecord): number {
  const left = Date.parse(a.created_at);
  const right = Date.parse(b.created_at);
  return (Number.isNaN(right) ? 0 : right) - (Number.isNaN(left) ? 0 : left);
}

async function trimHistory(): Promise<void> {
  const sorted = [...jobs.values()].sort(compareCreatedAt);
  for (const job of sorted.slice(MAX_JOB_HISTORY)) {
    if (job.status === 'queued' || job.status === 'running') continue;
    jobs.delete(job.job_id);
    await rm(jobPath(job.job_id), { force: true }).catch(() => undefined);
  }
}

async function loadJobs(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(jobsDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = parseJob(
        JSON.parse(await readFile(join(jobsDir, entry), 'utf8')) as unknown,
      );
      if (!parsed) continue;
      if (parsed.status === 'queued' || parsed.status === 'running') {
        parsed.status = 'failed';
        parsed.error = 'render interrupted by MCP server restart';
        parsed.finished_at = new Date().toISOString();
        if (parsed.temp_path) {
          await rm(parsed.temp_path, { force: true }).catch(() => undefined);
        }
        parsed.temp_path = undefined;
        await persistJob(parsed).catch(() => undefined);
      }
      jobs.set(parsed.job_id, parsed);
    } catch {
      // A corrupt job file must not prevent the MCP server from starting.
    }
  }

  await trimHistory();
}

function validateInput(input: EnqueueRenderInput): void {
  if (input.timeline.duration_us <= 0) {
    throw new Error('timeline duration must be positive');
  }
  if (input.timeline.segments.length === 0) {
    throw new Error('timeline has no video segments to render');
  }
  const width = input.width ?? 1280;
  const height = input.height ?? 720;
  const crf = input.crf ?? 18;
  if (!Number.isInteger(width) || width < 320 || width > 3840 || width % 2 !== 0) {
    throw new Error('width must be an even integer between 320 and 3840');
  }
  if (!Number.isInteger(height) || height < 180 || height > 2160 || height % 2 !== 0) {
    throw new Error('height must be an even integer between 180 and 2160');
  }
  if (!Number.isInteger(crf) || crf < 0 || crf > 51) {
    throw new Error('crf must be an integer between 0 and 51');
  }
}

export async function enqueueRender(
  input: EnqueueRenderInput,
): Promise<EnqueuedRenderJob> {
  if (pending.length >= MAX_PENDING) {
    throw new Error(`render queue is full (${MAX_PENDING} pending jobs)`);
  }
  validateInput(input);

  const jobId = `render-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const outputPath = resolveRenderOutputPath(
    input.projectId,
    input.timeline.revision,
    input.outputPath,
  );
  const job: RenderJobRecord = {
    job_id: jobId,
    project_id: input.projectId,
    title: input.title,
    revision: input.timeline.revision,
    status: 'queued',
    created_at: new Date().toISOString(),
    output_path: outputPath,
    temp_path: `${outputPath}.part-${jobId}.mp4`,
    width: input.width ?? 1280,
    height: input.height ?? 720,
    crf: input.crf ?? 18,
    progress: emptyProgress(),
    timeline: structuredClone(input.timeline),
  };

  const queuedAhead = pending.length + (runningJobId ? 1 : 0);
  jobs.set(jobId, job);
  pending.push(jobId);
  try {
    await persistJob(job);
  } catch (error) {
    pending.pop();
    jobs.delete(jobId);
    throw error;
  }

  const view = toView(job);
  void pump();
  void trimHistory().catch(() => undefined);
  return { ...view, queued_ahead: queuedAhead };
}

async function pump(): Promise<void> {
  if (working) return;

  const jobId = pending.shift();
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') {
    void pump();
    return;
  }

  working = true;
  runningJobId = jobId;
  const controller = new AbortController();
  controllers.set(jobId, controller);
  job.status = 'running';
  job.started_at = new Date().toISOString();
  job.finished_at = undefined;
  job.error = undefined;
  let lastProgressPersist = 0;

  try {
    await persistJob(job);
    const result = await renderTimelineVideo(job.timeline!, {
      projectId: job.project_id,
      outputPath: job.temp_path!,
      width: job.width,
      height: job.height,
      crf: job.crf,
      signal: controller.signal,
      onProgress: (progress) => {
        job.progress = progress;
        const now = Date.now();
        if (now - lastProgressPersist >= 1_000) {
          lastProgressPersist = now;
          void persistJob(job).catch(() => undefined);
        }
      },
    });

    if (cancellationRequested(job, controller)) {
      await rm(job.temp_path!, { force: true }).catch(() => undefined);
      job.status = 'cancelled';
      job.error = 'cancelled by agent';
    } else {
      await rename(job.temp_path!, job.output_path);
      if (cancellationRequested(job, controller)) {
        await rm(job.output_path, { force: true }).catch(() => undefined);
        job.status = 'cancelled';
        job.error = 'cancelled by agent';
      } else {
        job.status = 'completed';
        job.result = { ...result, path: job.output_path };
        job.warnings = result.warnings;
        job.progress = {
          ...job.progress,
          percent: 100,
          out_time_us: result.duration_us,
          eta_seconds: 0,
        };
      }
    }
  } catch (error) {
    await rm(job.temp_path!, { force: true }).catch(() => undefined);
    if (cancellationRequested(job, controller)) {
      job.status = 'cancelled';
      job.error = 'cancelled by agent';
    } else {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'video render failed';
    }
  } finally {
    job.finished_at = new Date().toISOString();
    delete job.timeline;
    job.temp_path = undefined;
    controllers.delete(jobId);
    runningJobId = null;
    working = false;
    await persistJob(job).catch(() => undefined);
    void trimHistory().catch(() => undefined);
    void pump();
  }
}

export function getRenderJob(jobId: string): RenderJobView | null {
  const job = jobs.get(jobId);
  return job ? toView(job) : null;
}

export function listRenderJobs(options: {
  projectId?: string;
  limit?: number;
} = {}): RenderJobView[] {
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  return [...jobs.values()]
    .filter((job) => !options.projectId || job.project_id === options.projectId)
    .sort(compareCreatedAt)
    .slice(0, limit)
    .map(toView);
}

export function renderQueueStats(): {
  pending: number;
  running: boolean;
  jobs: number;
  concurrency: number;
  max_pending: number;
} {
  return {
    pending: pending.length,
    running: runningJobId !== null,
    jobs: jobs.size,
    concurrency: 1,
    max_pending: MAX_PENDING,
  };
}

export async function cancelRenderJob(
  jobId: string,
): Promise<{ job: RenderJobView; cancelled: boolean } | null> {
  const job = jobs.get(jobId);
  if (!job) return null;

  if (job.status === 'queued') {
    const index = pending.indexOf(jobId);
    if (index >= 0) pending.splice(index, 1);
    job.status = 'cancelled';
    job.error = 'cancelled by agent';
    job.finished_at = new Date().toISOString();
    delete job.timeline;
    await persistJob(job).catch(() => undefined);
    return { job: toView(job), cancelled: true };
  }

  if (job.status === 'running') {
    job.status = 'cancelled';
    job.error = 'cancelled by agent';
    controllers.get(jobId)?.abort();
    await persistJob(job).catch(() => undefined);
    return { job: toView(job), cancelled: true };
  }

  return { job: toView(job), cancelled: false };
}

function abortRunningJobs(): void {
  for (const controller of controllers.values()) controller.abort();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    abortRunningJobs();
    setTimeout(() => process.exit(0), 500);
  });
}

await loadJobs();
