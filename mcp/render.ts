import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimelineDocument, TimelineSegment } from '../src/timeline/document';
import { assetById, refreshAssets } from '../src/timeline/assets';
import {
  durationFrames,
  frameRateOf,
  frameToUS,
  type FrameRate,
} from '../src/timeline/timebase';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const mediaRoot = resolve(
  process.env.TIMELINE_MEDIA_ROOT ?? resolve(here, '../public'),
);
const ffmpegBin = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobeBin = process.env.FFPROBE_PATH ?? 'ffprobe';
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;
const MAX_SHEET_FRAMES = 16;

export interface FrameRenderResult {
  jpeg: Buffer;
  meta: Record<string, unknown>;
}

interface RenderOptions {
  frameRate?: FrameRate;
}

export interface VideoRenderProgress {
  percent: number;
  out_time_us: number;
  fps: number;
  speed: number;
  eta_seconds: number | null;
}

function renderAbortError(): Error {
  const error = new Error('render cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * Run FFmpeg with machine-readable progress on stdout and a stderr tail for
 * failures. Unlike execFile, this can be aborted and reports progress while
 * the encoder is still working.
 */
function runFfmpegWithProgress(
  args: string[],
  durationUS: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: VideoRenderProgress) => void;
  },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(renderAbortError());
      return;
    }

    const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let settled = false;
    let timedOut = false;
    let outTimeUS = 0;
    let fps = 0;
    let speed = 0;
    let lastProgressAt = 0;
    let killTimer: NodeJS.Timeout | undefined;

    const emitProgress = (force: boolean) => {
      if (!options.onProgress) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < 500) return;
      lastProgressAt = now;
      const percent =
        durationUS > 0
          ? Math.min(100, Math.max(0, (outTimeUS / durationUS) * 100))
          : 0;
      const remaining = Math.max(0, durationUS - outTimeUS) / 1_000_000;
      options.onProgress({
        percent: Math.round(percent * 10) / 10,
        out_time_us: outTimeUS,
        fps,
        speed,
        eta_seconds: speed > 0 ? Math.round((remaining / speed) * 10) / 10 : null,
      });
    };

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolvePromise();
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    }, 15 * 60_000);
    timeout.unref();

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key === 'out_time_us') outTimeUS = Number(value) || 0;
        else if (key === 'fps') fps = Number.parseFloat(value) || 0;
        else if (key === 'speed') speed = Number.parseFloat(value.replace(/x$/, '')) || 0;
        else if (key === 'progress' && value === 'end') emitProgress(true);
      }
      emitProgress(false);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-65_536);
    });

    child.on('error', (error) => finish(options.signal?.aborted ? renderAbortError() : error));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (options.signal?.aborted) {
        finish(renderAbortError());
        return;
      }
      if (timedOut) {
        finish(new Error('ffmpeg timed out after 15 minutes'));
        return;
      }
      if (code === 0) {
        outTimeUS = durationUS;
        emitProgress(true);
        finish();
        return;
      }
      const detail = stderr.trim().slice(-1_500);
      finish(
        new Error(
          `ffmpeg failed (${signal ?? code ?? 'unknown'}): ${detail || 'no stderr'}`,
        ),
      );
    });
  });
}

function runFfmpeg(
  args: string[],
  maxBuffer = 32 * 1024 * 1024,
  timeout = 30_000,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      ffmpegBin,
      args,
      { encoding: 'buffer', maxBuffer, timeout },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr)
            ? stderr.toString('utf8')
            : String(stderr ?? '');
          reject(new Error(`ffmpeg failed: ${detail.trim().slice(0, 1_500) || error.message}`));
          return;
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      ffprobeBin,
      args,
      { encoding: 'utf8', timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `ffprobe failed: ${String(stderr ?? '').trim().slice(0, 500) || error.message}`,
            ),
          );
          return;
        }
        resolvePromise(String(stdout ?? '').trim());
      },
    );
  });
}

const audioStreamCache = new Map<string, Promise<boolean>>();

/** Probe once per file so segment audio is mixed only when it exists. */
function hasAudioStream(path: string): Promise<boolean> {
  let cached = audioStreamCache.get(path);
  if (!cached) {
    cached = runFfprobe([
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      path,
    ])
      .then((value) => value.length > 0)
      .catch(() => false);
    audioStreamCache.set(path, cached);
  }
  return cached;
}

async function ensureAssets(): Promise<void> {
  try {
    await refreshAssets(process.env.TIMELINE_RELAY_URL ?? 'http://127.0.0.1:8787');
  } catch {
    // The static catalog is still enough for demo timelines.
  }
}

function assetFilePath(assetId: string): string | null {
  const asset = assetById(assetId);
  if (!asset?.url) return null;
  if (/^https?:\/\//i.test(asset.url)) return asset.url;
  const candidate = resolve(mediaRoot, asset.url.replace(/^\/+/, ''));
  const root = mediaRoot.endsWith(sep) ? mediaRoot : `${mediaRoot}${sep}`;
  if (!candidate.startsWith(root)) return null;
  return candidate;
}

function activeSegment(timeline: TimelineDocument, atUS: number): TimelineSegment | null {
  let active: TimelineSegment | null = null;
  for (const segment of timeline.segments) {
    const end = segment.timeline_start_us + segment.timeline_duration_us;
    if (atUS < segment.timeline_start_us || atUS >= end) continue;
    if (
      !active ||
      segment.timeline_start_us > active.timeline_start_us ||
      (segment.timeline_start_us === active.timeline_start_us &&
        segment.timeline_duration_us > active.timeline_duration_us)
    ) {
      active = segment;
    }
  }
  return active;
}

function drawTextFilter(text: string): string {
  const safe = text
    .replace(/[\\':%]/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .slice(0, 90);
  return `drawtext=text='${safe}':fontcolor=0xdddddd:fontsize=20:x=(w-text_w)/2:y=(h-text_h)/2`;
}

async function syntheticFrame(label: string): Promise<Buffer> {
  const base = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x14141c:s=${FRAME_WIDTH}x${FRAME_HEIGHT}:d=1`,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-q:v',
    '3',
    'pipe:1',
  ];
  try {
    return await runFfmpeg([
      ...base.slice(0, 6),
      '-vf',
      drawTextFilter(label),
      ...base.slice(6),
    ]);
  } catch {
    return runFfmpeg(base);
  }
}

function frameFilter(): string {
  return [
    `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
  ].join(',');
}

function sourceSeconds(us: number): string {
  return (us / 1_000_000).toFixed(6);
}

/**
 * Render exactly one frame of the active video segment.
 *
 * This is inspection only: it reads the timeline, never mutates it, and is
 * not imported by src/timeline. A missing segment or media returns a labelled
 * synthetic frame so an agent still gets deterministic visual feedback.
 */
export async function renderTimelineFrame(
  timeline: TimelineDocument,
  frame: number,
  options: RenderOptions = {},
): Promise<FrameRenderResult> {
  await ensureAssets();
  const rate = options.frameRate ?? frameRateOf(timeline);
  const totalFrames = durationFrames(timeline.duration_us, rate);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= totalFrames) {
    throw new Error(`frame must be between 0 and ${Math.max(0, totalFrames - 1)}`);
  }

  const atUS = frameToUS(frame, rate);
  const segment = activeSegment(timeline, atUS);
  const baseMeta = {
    frame,
    frame_rate: rate,
    at_us: atUS,
    duration_us: timeline.duration_us,
    duration_frames: totalFrames,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
  };

  if (!segment) {
    return {
      jpeg: await syntheticFrame(`No active video at frame ${frame}`),
      meta: { ...baseMeta, status: 'no_active_video' },
    };
  }

  const sourceUS = segment.source_in_us + Math.max(0, atUS - segment.timeline_start_us);
  const clipMeta = {
    segment_id: segment.segment_id,
    asset_id: segment.asset_id,
    source_us: sourceUS,
  };

  const path = assetFilePath(segment.asset_id);
  if (!path) {
    return {
      jpeg: await syntheticFrame(`Missing media: ${segment.asset_id}`),
      meta: { ...baseMeta, ...clipMeta, status: 'missing_media' },
    };
  }

  try {
    const jpeg = await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      sourceSeconds(sourceUS),
      '-i',
      path,
      '-frames:v',
      '1',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      frameFilter(),
      '-q:v',
      '3',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (jpeg.length === 0) throw new Error('ffmpeg returned an empty frame');
    return {
      jpeg,
      meta: { ...baseMeta, ...clipMeta, status: 'ok' },
    };
  } catch (error) {
    return {
      jpeg: await syntheticFrame(`Media error at frame ${frame}`),
      meta: {
        ...baseMeta,
        ...clipMeta,
        status: 'media_error',
        warning: error instanceof Error ? error.message : 'ffmpeg failed',
      },
    };
  }
}

/**
 * Build a grid of frames as a single JPEG. Each tile is rendered from the
 * active video segment, then tiled with FFmpeg's xstack filter.
 */
export async function renderContactSheet(
  timeline: TimelineDocument,
  startFrame: number,
  endFrame: number,
  stepFrames = 1,
  columns = 4,
  options: RenderOptions = {},
): Promise<FrameRenderResult> {
  const rate = options.frameRate ?? frameRateOf(timeline);
  const totalFrames = durationFrames(timeline.duration_us, rate);
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
    throw new Error('start_frame must be a non-negative integer');
  }
  if (!Number.isSafeInteger(endFrame) || endFrame < startFrame) {
    throw new Error('end_frame must be an integer >= start_frame');
  }
  if (endFrame >= totalFrames) {
    throw new Error(`end_frame must be between 0 and ${Math.max(0, totalFrames - 1)}`);
  }
  if (!Number.isSafeInteger(stepFrames) || stepFrames <= 0) {
    throw new Error('step_frames must be a positive integer');
  }
  if (!Number.isInteger(columns) || columns < 1 || columns > 4) {
    throw new Error('columns must be between 1 and 4');
  }

  const frames: number[] = [];
  for (let frame = startFrame; frame <= endFrame; frame += stepFrames) {
    frames.push(frame);
    if (frames.length > MAX_SHEET_FRAMES) {
      throw new Error(`contact sheet is limited to ${MAX_SHEET_FRAMES} frames; increase step_frames`);
    }
  }

  const rendered: FrameRenderResult[] = [];
  for (const frame of frames) {
    rendered.push(await renderTimelineFrame(timeline, frame, { frameRate: rate }));
  }

  const dir = await mkdtemp(join(tmpdir(), 'velox-sheet-'));
  try {
    const files: string[] = [];
    for (const [index, result] of rendered.entries()) {
      const file = join(dir, `frame-${String(index).padStart(2, '0')}.jpg`);
      await writeFile(file, result.jpeg);
      files.push(file);
    }

    const n = files.length;
    if (n === 1) {
      return {
        jpeg: rendered[0].jpeg,
        meta: {
          status: 'contact_sheet',
          frame_rate: rate,
          start_frame: startFrame,
          end_frame: endFrame,
          step_frames: stepFrames,
          columns: 1,
          count: 1,
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          frames: rendered.map((item) => item.meta),
        },
      };
    }

    const tileWidth = 320;
    const tileHeight = 180;
    const filterParts: string[] = [];
    for (let index = 0; index < n; index += 1) {
      filterParts.push(
        `[${index}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,` +
          `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=black[v${index}]`,
      );
    }
    const stack = Array.from({ length: n }, (_, index) => `[v${index}]`).join('');
    const layout = Array.from({ length: n }, (_, index) => {
      const x = (index % columns) * tileWidth;
      const y = Math.floor(index / columns) * tileHeight;
      return `${x}_${y}`;
    }).join('|');
    filterParts.push(
      `${stack}xstack=inputs=${n}:layout=${layout}:fill=black[out]`,
    );

    const sheet = await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      ...files.flatMap((file) => ['-i', file]),
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      '[out]',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);

    const rows = Math.ceil(n / columns);
    return {
      jpeg: sheet,
      meta: {
        status: 'contact_sheet',
        frame_rate: rate,
        start_frame: startFrame,
        end_frame: endFrame,
        step_frames: stepFrames,
        columns,
        count: n,
        width: columns * tileWidth,
        height: rows * tileHeight,
        frames: rendered.map((item) => item.meta),
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface VideoRenderOptions {
  projectId?: string;
  outputPath?: string;
  width?: number;
  height?: number;
  crf?: number;
  signal?: AbortSignal;
  onProgress?: (progress: VideoRenderProgress) => void;
}

export function resolveRenderOutputPath(
  projectId: string,
  revision: number,
  outputPath?: string,
): string {
  if (!outputPath) {
    return resolve(projectRoot, 'renders', `${projectId}-r${revision}.mp4`);
  }
  return isAbsolute(outputPath) ? outputPath : resolve(projectRoot, outputPath);
}

export interface VideoRenderResult {
  status: 'rendered';
  path: string;
  bytes: number;
  width: number;
  height: number;
  fps: string;
  duration_us: number;
  duration_s: number;
  crf: number;
  video_segments: number;
  overlays: number;
  audio_tracks: number;
  warnings: string[];
  elapsed_ms: number;
}

function seconds(us: number): string {
  return (us / 1_000_000).toFixed(6);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Composite the complete editorial document into one MP4.
 *
 * V1 segments are placed on a black base at their exact timeline positions;
 * V2 overlays are composited with screen or alpha blending and per-clip
 * opacity; voiceover, music, SFX and optional segment audio are mixed with
 * their gains and offsets. This is an external producer, not part of React
 * or the timeline core. The editor has no render button: an agent calls the
 * MCP tool that wraps this function.
 */
export async function renderTimelineVideo(
  timeline: TimelineDocument,
  options: VideoRenderOptions = {},
): Promise<VideoRenderResult> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const crf = options.crf ?? 18;

  if (!Number.isInteger(width) || width < 320 || width > 3840 || width % 2 !== 0) {
    throw new Error('width must be an even integer between 320 and 3840');
  }
  if (!Number.isInteger(height) || height < 180 || height > 2160 || height % 2 !== 0) {
    throw new Error('height must be an even integer between 180 and 2160');
  }
  if (!Number.isInteger(crf) || crf < 0 || crf > 51) {
    throw new Error('crf must be an integer between 0 and 51');
  }
  if (timeline.duration_us <= 0) {
    throw new Error('timeline duration must be positive');
  }
  if (timeline.segments.length === 0) {
    throw new Error('timeline has no video segments to render');
  }

  await ensureAssets();
  const rate = frameRateOf(timeline);
  const fps = `${rate.numerator}/${rate.denominator}`;
  const totalSeconds = seconds(timeline.duration_us);
  const projectId = options.projectId ?? 'timeline';
  const outputPath = resolveRenderOutputPath(
    projectId,
    timeline.revision,
    options.outputPath,
  );

  if (options.signal?.aborted) throw renderAbortError();

  const segments = [...timeline.segments].sort(
    (a, b) => a.timeline_start_us - b.timeline_start_us || a.timeline_duration_us - b.timeline_duration_us,
  );
  const overlays = timeline.overlays ?? [];
  const warnings: string[] = [];
  const inputs: string[] = [
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${width}x${height}:r=${fps}:d=${totalSeconds}`,
  ];
  const filters: string[] = [`[0:v]format=rgba[base0]`];
  let visual = 'base0';
  let inputIndex = 1;

  const segmentInputs: number[] = [];
  for (const [index, segment] of segments.entries()) {
    const path = assetFilePath(segment.asset_id);
    if (!path) throw new Error(`missing local media for ${segment.asset_id}`);
    inputs.push(
      '-ss',
      seconds(segment.source_in_us),
      '-t',
      seconds(segment.timeline_duration_us),
      '-i',
      path,
    );
    const sourceInput = inputIndex;
    segmentInputs.push(sourceInput);
    inputIndex += 1;

    const start = seconds(segment.timeline_start_us);
    const duration = seconds(segment.timeline_duration_us);
    const end = seconds(segment.timeline_start_us + segment.timeline_duration_us);
    filters.push(
      `[${sourceInput}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=0.25,trim=duration=${duration},` +
        `setpts=PTS-STARTPTS+${start}/TB,format=rgba[seg${index}]`,
    );
    filters.push(
      `[${visual}][seg${index}]overlay=0:0:eof_action=pass:` +
        `enable='between(t,${start},${end})'[base${index + 1}]`,
    );
    visual = `base${index + 1}`;
  }

  for (const [index, overlay] of overlays.entries()) {
    const path = assetFilePath(overlay.asset_id);
    if (!path) throw new Error(`missing local media for ${overlay.asset_id}`);
    inputs.push(
      '-ss',
      seconds(overlay.source_in_us),
      '-t',
      seconds(overlay.timeline_duration_us),
      '-i',
      path,
    );
    const sourceInput = inputIndex;
    inputIndex += 1;

    const start = seconds(overlay.timeline_start_us);
    const end = seconds(overlay.timeline_start_us + overlay.timeline_duration_us);
    const duration = seconds(overlay.timeline_duration_us);
    const opacity = clamp(overlay.opacity, 0, 1);
    const scale =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},` +
      `trim=duration=${duration}`;

    if (overlay.blend_mode === 'screen') {
      const tail = Math.max(
        0,
        timeline.duration_us -
          overlay.timeline_start_us -
          overlay.timeline_duration_us,
      );
      filters.push(
        `[${sourceInput}:v]${scale},setpts=PTS-STARTPTS,format=gbrp,` +
          `tpad=start_duration=${start}:start_mode=add:color=black:` +
          `stop_duration=${seconds(tail)}:stop_mode=add:color=black[ov${index}]`,
      );
      filters.push(`[${visual}]format=gbrp[vis${index}]`);
      filters.push(
        `[vis${index}][ov${index}]blend=all_mode=screen:all_opacity=${opacity}[mix${index}]`,
      );
    } else {
      filters.push(
        `[${sourceInput}:v]${scale},setpts=PTS-STARTPTS+${start}/TB,` +
          `format=rgba,colorchannelmixer=aa=${opacity}[ov${index}]`,
      );
      filters.push(`[${visual}]format=rgba[vis${index}]`);
      filters.push(
        `[vis${index}][ov${index}]overlay=0:0:eof_action=pass:` +
          `enable='between(t,${start},${end})'[mix${index}]`,
      );
    }
    visual = `mix${index}`;
  }

  filters.push(
    `[${visual}]format=yuv420p,fps=${fps},` +
      `tpad=stop_mode=clone:stop_duration=0.25,trim=duration=${totalSeconds},` +
      `setpts=PTS-STARTPTS[vout]`,
  );

  const audioChains: string[] = [];
  const audioGroups = [
    ...timeline.voiceovers.map((track) => ({ track, group: 'voiceover' })),
    ...timeline.music.map((track) => ({ track, group: 'music' })),
    ...timeline.sfx.map((track) => ({ track, group: 'sfx' })),
  ];

  function pushAudioChain(
    input: number,
    durationUS: number,
    startUS: number,
    gain: number,
    label: string,
  ): void {
    const delayMs = Math.max(0, Math.round(startUS / 1_000));
    const volume = clamp(gain, 0, 4);
    const chain =
      `[${input}:a]atrim=start=0:duration=${seconds(durationUS)},asetpts=PTS-STARTPTS,` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `volume=${volume}` +
      (delayMs > 0 ? `,adelay=${delayMs}:all=1` : '') +
      `[${label}]`;
    filters.push(chain);
    audioChains.push(label);
  }

  for (const [index, segment] of segments.entries()) {
    if (!segment.audio_enabled) continue;
    const path = assetFilePath(segment.asset_id);
    if (!path || !(await hasAudioStream(path))) {
      warnings.push(`segment ${segment.segment_id} has audio_enabled but no audio stream`);
      continue;
    }
    pushAudioChain(
      segmentInputs[index],
      segment.timeline_duration_us,
      segment.timeline_start_us,
      segment.audio_gain,
      `segaudio${index}`,
    );
  }

  for (const [index, entry] of audioGroups.entries()) {
    const path = assetFilePath(entry.track.asset_id);
    if (!path) throw new Error(`missing local media for ${entry.track.asset_id}`);
    if (!(await hasAudioStream(path))) {
      warnings.push(`${entry.group} ${entry.track.track_id} has no audio stream and was skipped`);
      continue;
    }
    inputs.push(
      '-ss',
      seconds(entry.track.source_in_us),
      '-t',
      seconds(entry.track.timeline_duration_us),
      '-i',
      path,
    );
    const sourceInput = inputIndex;
    inputIndex += 1;
    pushAudioChain(
      sourceInput,
      entry.track.timeline_duration_us,
      entry.track.timeline_start_us,
      entry.track.gain,
      `aud${index}`,
    );
  }

  if (audioChains.length > 0) {
    filters.push(
      `${audioChains.map((label) => `[${label}]`).join('')}` +
        `amix=inputs=${audioChains.length}:duration=longest:normalize=0,` +
        `alimiter=limit=0.95:level=false,atrim=duration=${totalSeconds},` +
        `asetpts=PTS-STARTPTS[aout]`,
    );
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-progress',
    'pipe:1',
    '-nostats',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    ...(audioChains.length > 0
      ? [
          '-map',
          '[aout]',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          '48000',
          '-ac',
          '2',
        ]
      : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-r',
    fps,
    '-t',
    totalSeconds,
    '-movflags',
    '+faststart',
    '-map_metadata',
    '-1',
    '-f',
    'mp4',
    outputPath,
  ];

  const startedAt = Date.now();
  await mkdir(dirname(outputPath), { recursive: true });
  await runFfmpegWithProgress(args, timeline.duration_us, options);
  const info = await stat(outputPath);

  return {
    status: 'rendered',
    path: outputPath,
    bytes: info.size,
    width,
    height,
    fps,
    duration_us: timeline.duration_us,
    duration_s: timeline.duration_us / 1_000_000,
    crf,
    video_segments: segments.length,
    overlays: overlays.length,
    audio_tracks: audioChains.length,
    warnings,
    elapsed_ms: Date.now() - startedAt,
  };
}
