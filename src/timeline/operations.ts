import type {
  TimelineAudioTrack,
  TimelineDocument,
  TimelineOverlay,
  TimelineSegment,
} from './document';
import { MEDIA_ASSETS } from './assets';
import {
  DEFAULT_FRAME_RATE,
  durationFrames,
  frameRateOf,
  validateFrameRate,
  type FrameRate,
} from './timebase';

export type AudioGroup = 'voiceover' | 'music' | 'sfx';
export type ClipGroup = 'video' | 'overlay' | AudioGroup;

export type LocatedClip =
  | { group: 'video'; clip: TimelineSegment }
  | { group: 'overlay'; clip: TimelineOverlay }
  | { group: AudioGroup; clip: TimelineAudioTrack };

const AUDIO_KEY = {
  voiceover: 'voiceovers',
  music: 'music',
  sfx: 'sfx',
} as const;

const GROUP_LABEL: Record<AudioGroup, string> = {
  voiceover: 'voiceover',
  music: 'music',
  sfx: 'sfx',
};

export function secondsToUS(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new Error('time must be a finite number of seconds');
  return Math.round(seconds * 1_000_000);
}

let sequence = 0;

function makeId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function cloneDocument(document: TimelineDocument): TimelineDocument {
  return structuredClone(document);
}

function bumpRevision(document: TimelineDocument): TimelineDocument {
  document.revision += 1;
  return document;
}

function extendDuration(document: TimelineDocument, endUS: number): void {
  document.duration_us = Math.max(document.duration_us, Math.round(endUS));
}

function assertUS(value: number, label: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
}

export function createEmptyDocument(durationSeconds = 15): TimelineDocument {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('duration_s must be positive');
  }
  return {
    revision: 1,
    frame_rate: { ...DEFAULT_FRAME_RATE },
    duration_us: secondsToUS(durationSeconds),
    segments: [],
    overlays: [],
    voiceovers: [],
    music: [],
    sfx: [],
  };
}

function segment(
  id: string,
  assetId: string,
  startUS: number,
  durationUS: number,
): TimelineSegment {
  return {
    segment_id: id,
    asset_id: assetId,
    timeline_start_us: startUS,
    timeline_duration_us: durationUS,
    source_in_us: 0,
    source_duration_us: durationUS,
    audio_enabled: false,
    audio_gain: 1,
  };
}

function audio(
  id: string,
  assetId: string,
  startUS: number,
  durationUS: number,
  gain = 1,
): TimelineAudioTrack {
  return {
    track_id: id,
    asset_id: assetId,
    timeline_start_us: startUS,
    timeline_duration_us: durationUS,
    source_in_us: 0,
    source_duration_us: durationUS,
    gain,
  };
}

/** Deterministic demo project used only when a fresh MCP store is created. */
export function createDemoDocument(): TimelineDocument {
  const document = createEmptyDocument(12.5);
  const videos = MEDIA_ASSETS.filter((asset) => asset.kind === 'video').slice(0, 5);
  document.segments = videos.map((asset, index) =>
    segment(`seg-${String(index + 1).padStart(2, '0')}`, asset.id, index * 2_500_000, 2_500_000),
  );
  document.overlays = [
    {
      overlay_id: 'overlay-market',
      asset_id: 'asset-overlay-market',
      timeline_start_us: 1_000_000,
      timeline_duration_us: 1_750_000,
      source_in_us: 0,
      source_duration_us: 1_750_000,
      opacity: 1,
      blend_mode: 'screen',
    },
    {
      overlay_id: 'overlay-growth',
      asset_id: 'asset-overlay-growth',
      timeline_start_us: 6_500_000,
      timeline_duration_us: 1_916_667,
      source_in_us: 0,
      source_duration_us: 1_916_667,
      opacity: 1,
      blend_mode: 'screen',
    },
  ];
  document.voiceovers = [
    audio('vo-intro', 'asset-voiceover', 400_000, 2_300_000),
    audio('vo-body', 'asset-voiceover-2', 7_200_000, 4_500_000),
  ];
  document.music = [audio('music-main', 'asset-music-bed', 0, 12_500_000, 0.7)];
  document.sfx = [
    audio('sfx-switch-1', 'asset-sfx-whoosh', 2_300_000, 400_000, 0.9),
    audio('sfx-switch-2', 'asset-sfx-riser', 7_000_000, 500_000, 0.9),
  ];
  return document;
}

export function findClip(document: TimelineDocument, clipId: string): LocatedClip | null {
  const video = document.segments.find((item) => item.segment_id === clipId);
  if (video) return { group: 'video', clip: video };

  const overlay = document.overlays?.find((item) => item.overlay_id === clipId);
  if (overlay) return { group: 'overlay', clip: overlay };

  for (const group of ['voiceover', 'music', 'sfx'] as const) {
    const found = document[AUDIO_KEY[group]].find((item) => item.track_id === clipId);
    if (found) return { group, clip: found };
  }
  return null;
}

export interface AddVideoClipUSInput {
  assetId: string;
  startUS: number;
  durationUS: number;
  sourceInUS?: number;
  audioEnabled?: boolean;
  audioGain?: number;
  segmentId?: string;
}

/** Exact-microsecond video insert used by frame-addressed MCP transactions. */
export function addVideoClipUS(
  document: TimelineDocument,
  input: AddVideoClipUSInput,
): { document: TimelineDocument; clip: TimelineSegment } {
  assertUS(input.startUS, 'start_us');
  assertUS(input.durationUS, 'duration_us', false);
  const sourceInUS = input.sourceInUS ?? 0;
  assertUS(sourceInUS, 'source_in_us');

  const next = cloneDocument(document);
  const clip: TimelineSegment = {
    segment_id: input.segmentId ?? makeId('seg'),
    asset_id: input.assetId,
    timeline_start_us: input.startUS,
    timeline_duration_us: input.durationUS,
    source_in_us: sourceInUS,
    source_duration_us: input.durationUS,
    audio_enabled: input.audioEnabled ?? false,
    audio_gain: input.audioGain ?? 1,
  };
  next.segments.push(clip);
  extendDuration(next, clip.timeline_start_us + clip.timeline_duration_us);
  return { document: bumpRevision(next), clip };
}

export interface AddVideoClipInput {
  assetId: string;
  startSeconds: number;
  durationSeconds: number;
  sourceInSeconds?: number;
  audioEnabled?: boolean;
  audioGain?: number;
  segmentId?: string;
}

export function addVideoClip(
  document: TimelineDocument,
  input: AddVideoClipInput,
): { document: TimelineDocument; clip: TimelineSegment } {
  return addVideoClipUS(document, {
    assetId: input.assetId,
    startUS: Math.max(0, secondsToUS(input.startSeconds)),
    durationUS: secondsToUS(input.durationSeconds),
    sourceInUS:
      input.sourceInSeconds === undefined ? undefined : Math.max(0, secondsToUS(input.sourceInSeconds)),
    audioEnabled: input.audioEnabled,
    audioGain: input.audioGain,
    segmentId: input.segmentId,
  });
}

export interface AddAudioClipUSInput {
  kind: AudioGroup;
  assetId: string;
  startUS: number;
  durationUS: number;
  sourceInUS?: number;
  gain?: number;
  clipId?: string;
}

/** Exact-microsecond audio insert used by frame-addressed MCP transactions. */
export function addAudioClipUS(
  document: TimelineDocument,
  input: AddAudioClipUSInput,
): { document: TimelineDocument; clip: TimelineAudioTrack } {
  assertUS(input.startUS, 'start_us');
  assertUS(input.durationUS, 'duration_us', false);
  const sourceInUS = input.sourceInUS ?? 0;
  assertUS(sourceInUS, 'source_in_us');

  const next = cloneDocument(document);
  const clip: TimelineAudioTrack = {
    track_id: input.clipId ?? makeId(GROUP_LABEL[input.kind]),
    asset_id: input.assetId,
    timeline_start_us: input.startUS,
    timeline_duration_us: input.durationUS,
    source_in_us: sourceInUS,
    source_duration_us: input.durationUS,
    gain: input.gain ?? 1,
  };
  next[AUDIO_KEY[input.kind]].push(clip);
  extendDuration(next, clip.timeline_start_us + clip.timeline_duration_us);
  return { document: bumpRevision(next), clip };
}

export interface AddOverlayClipUSInput {
  assetId: string;
  startUS: number;
  durationUS: number;
  sourceInUS?: number;
  opacity?: number;
  blendMode?: 'screen' | 'normal';
  overlayId?: string;
}

/** Exact-microsecond V2 overlay insert used by frame-addressed MCP edits. */
export function addOverlayClipUS(
  document: TimelineDocument,
  input: AddOverlayClipUSInput,
): { document: TimelineDocument; clip: TimelineOverlay } {
  assertUS(input.startUS, 'start_us');
  assertUS(input.durationUS, 'duration_us', false);
  const sourceInUS = input.sourceInUS ?? 0;
  assertUS(sourceInUS, 'source_in_us');
  const opacity = input.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error('opacity must be between 0 and 1');
  }

  const next = cloneDocument(document);
  const clip: TimelineOverlay = {
    overlay_id: input.overlayId ?? makeId('overlay'),
    asset_id: input.assetId,
    timeline_start_us: input.startUS,
    timeline_duration_us: input.durationUS,
    source_in_us: sourceInUS,
    source_duration_us: input.durationUS,
    opacity,
    blend_mode: input.blendMode ?? 'screen',
  };
  next.overlays = [...(next.overlays ?? []), clip];
  extendDuration(next, clip.timeline_start_us + clip.timeline_duration_us);
  return { document: bumpRevision(next), clip };
}

export interface AddAudioClipInput {
  kind: AudioGroup;
  assetId: string;
  startSeconds: number;
  durationSeconds: number;
  sourceInSeconds?: number;
  gain?: number;
  clipId?: string;
}

export function addAudioClip(
  document: TimelineDocument,
  input: AddAudioClipInput,
): { document: TimelineDocument; clip: TimelineAudioTrack } {
  return addAudioClipUS(document, {
    kind: input.kind,
    assetId: input.assetId,
    startUS: Math.max(0, secondsToUS(input.startSeconds)),
    durationUS: secondsToUS(input.durationSeconds),
    sourceInUS:
      input.sourceInSeconds === undefined ? undefined : Math.max(0, secondsToUS(input.sourceInSeconds)),
    gain: input.gain,
    clipId: input.clipId,
  });
}

export function moveClipUS(
  document: TimelineDocument,
  clipId: string,
  startUS: number,
): { document: TimelineDocument; clip: TimelineSegment | TimelineOverlay | TimelineAudioTrack } {
  assertUS(startUS, 'start_us');
  const next = cloneDocument(document);
  const found = findClip(next, clipId);
  if (!found) throw new Error(`clip not found: ${clipId}`);
  found.clip.timeline_start_us = startUS;
  extendDuration(next, found.clip.timeline_start_us + found.clip.timeline_duration_us);
  return { document: bumpRevision(next), clip: found.clip };
}

export function moveClip(
  document: TimelineDocument,
  clipId: string,
  startSeconds: number,
): { document: TimelineDocument; clip: TimelineSegment | TimelineOverlay | TimelineAudioTrack } {
  return moveClipUS(document, clipId, Math.max(0, secondsToUS(startSeconds)));
}

export interface TrimClipUSInput {
  startUS?: number;
  durationUS?: number;
  sourceInUS?: number;
}

export function trimClipUS(
  document: TimelineDocument,
  clipId: string,
  input: TrimClipUSInput,
): { document: TimelineDocument; clip: TimelineSegment | TimelineOverlay | TimelineAudioTrack } {
  const next = cloneDocument(document);
  const found = findClip(next, clipId);
  if (!found) throw new Error(`clip not found: ${clipId}`);
  if (input.startUS !== undefined) {
    assertUS(input.startUS, 'start_us');
    found.clip.timeline_start_us = input.startUS;
  }
  if (input.durationUS !== undefined) {
    assertUS(input.durationUS, 'duration_us', false);
    found.clip.timeline_duration_us = input.durationUS;
    found.clip.source_duration_us = input.durationUS;
  }
  if (input.sourceInUS !== undefined) {
    assertUS(input.sourceInUS, 'source_in_us');
    found.clip.source_in_us = input.sourceInUS;
  }
  extendDuration(next, found.clip.timeline_start_us + found.clip.timeline_duration_us);
  return { document: bumpRevision(next), clip: found.clip };
}

export interface TrimClipInput {
  startSeconds?: number;
  durationSeconds?: number;
  sourceInSeconds?: number;
}

export function trimClip(
  document: TimelineDocument,
  clipId: string,
  input: TrimClipInput,
): { document: TimelineDocument; clip: TimelineSegment | TimelineOverlay | TimelineAudioTrack } {
  return trimClipUS(document, clipId, {
    startUS:
      input.startSeconds === undefined ? undefined : Math.max(0, secondsToUS(input.startSeconds)),
    durationUS:
      input.durationSeconds === undefined ? undefined : secondsToUS(input.durationSeconds),
    sourceInUS:
      input.sourceInSeconds === undefined
        ? undefined
        : Math.max(0, secondsToUS(input.sourceInSeconds)),
  });
}

export function removeClip(
  document: TimelineDocument,
  clipId: string,
): { document: TimelineDocument; removed: LocatedClip } {
  const next = cloneDocument(document);
  const found = findClip(next, clipId);
  if (!found) throw new Error(`clip not found: ${clipId}`);
  if (found.group === 'video') {
    next.segments = next.segments.filter((item) => item.segment_id !== clipId);
  } else if (found.group === 'overlay') {
    next.overlays = (next.overlays ?? []).filter((item) => item.overlay_id !== clipId);
  } else {
    next[AUDIO_KEY[found.group]] = next[AUDIO_KEY[found.group]].filter(
      (item) => item.track_id !== clipId,
    );
  }
  return { document: bumpRevision(next), removed: found };
}

export function setAudioGain(
  document: TimelineDocument,
  clipId: string,
  gain: number,
): { document: TimelineDocument; clip: TimelineAudioTrack } {
  if (!Number.isFinite(gain) || gain < 0) throw new Error('gain must be a non-negative number');
  const next = cloneDocument(document);
  const found = findClip(next, clipId);
  if (!found || found.group === 'video' || found.group === 'overlay') {
    throw new Error(`audio clip not found: ${clipId}`);
  }
  found.clip.gain = gain;
  return { document: bumpRevision(next), clip: found.clip };
}

export function setDurationUS(
  document: TimelineDocument,
  durationUS: number,
): TimelineDocument {
  assertUS(durationUS, 'duration_us', false);
  const next = cloneDocument(document);
  next.duration_us = durationUS;
  return bumpRevision(next);
}

export function setDuration(
  document: TimelineDocument,
  durationSeconds: number,
): TimelineDocument {
  return setDurationUS(document, secondsToUS(durationSeconds));
}

export function setFrameRate(
  document: TimelineDocument,
  frameRate: FrameRate,
): TimelineDocument {
  const errors = validateFrameRate(frameRate);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const next = cloneDocument(document);
  next.frame_rate = { ...frameRate };
  return bumpRevision(next);
}

export interface DocumentSummary {
  revision: number;
  frame_rate: FrameRate;
  duration_us: number;
  duration_s: number;
  duration_frames: number;
  video_segments: number;
  overlays: number;
  voiceovers: number;
  music: number;
  sfx: number;
  clips: number;
}

export function summarizeDocument(document: TimelineDocument): DocumentSummary {
  const frameRate = frameRateOf(document);
  return {
    revision: document.revision,
    frame_rate: frameRate,
    duration_us: document.duration_us,
    duration_s: document.duration_us / 1_000_000,
    duration_frames: durationFrames(document.duration_us, frameRate),
    video_segments: document.segments.length,
    overlays: document.overlays?.length ?? 0,
    voiceovers: document.voiceovers.length,
    music: document.music.length,
    sfx: document.sfx.length,
    clips:
      document.segments.length +
      (document.overlays?.length ?? 0) +
      document.voiceovers.length +
      document.music.length +
      document.sfx.length,
  };
}

function validatePlacement(
  errors: string[],
  path: string,
  id: string,
  assetId: string,
  startUS: number,
  durationUS: number,
  sourceInUS: number,
  sourceDurationUS: number,
  timelineDurationUS: number,
  seen: Set<string>,
): void {
  if (!id.trim()) errors.push(`${path}: identity is required`);
  else if (seen.has(id)) errors.push(`${path}: duplicate id (${id})`);
  else seen.add(id);
  if (!assetId.trim()) errors.push(`${path}: asset_id is required`);
  if (!Number.isInteger(startUS) || startUS < 0) errors.push(`${path}: invalid timeline_start_us`);
  if (!Number.isInteger(durationUS) || durationUS <= 0) errors.push(`${path}: invalid duration`);
  if (!Number.isInteger(sourceInUS) || sourceInUS < 0) errors.push(`${path}: invalid source_in_us`);
  if (!Number.isInteger(sourceDurationUS) || sourceDurationUS <= 0) {
    errors.push(`${path}: invalid source_duration_us`);
  }
  if (startUS >= 0 && durationUS > 0 && startUS + durationUS > timelineDurationUS) {
    errors.push(`${path}: exceeds duration_us`);
  }
}

/** Structural invariants of the editor-owned document. */
export function validateTimeline(timeline: TimelineDocument): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(timeline.revision) || timeline.revision <= 0) {
    errors.push('revision must be a positive integer');
  }
  if (timeline.frame_rate !== undefined) {
    errors.push(...validateFrameRate(timeline.frame_rate));
  }
  if (!Number.isInteger(timeline.duration_us) || timeline.duration_us <= 0) {
    errors.push('duration_us must be a positive integer');
    return errors;
  }

  const segmentIds = new Set<string>();
  timeline.segments.forEach((item, index) => {
    validatePlacement(
      errors,
      `segments[${index}]`,
      item.segment_id,
      item.asset_id,
      item.timeline_start_us,
      item.timeline_duration_us,
      item.source_in_us,
      item.source_duration_us,
      timeline.duration_us,
      segmentIds,
    );
  });

  const overlayIds = new Set<string>();
  (timeline.overlays ?? []).forEach((item, index) => {
    validatePlacement(
      errors,
      `overlays[${index}]`,
      item.overlay_id,
      item.asset_id,
      item.timeline_start_us,
      item.timeline_duration_us,
      item.source_in_us,
      item.source_duration_us,
      timeline.duration_us,
      overlayIds,
    );
    if (!Number.isFinite(item.opacity) || item.opacity < 0 || item.opacity > 1) {
      errors.push(`overlays[${index}]: opacity must be between 0 and 1`);
    }
    if (item.blend_mode !== 'screen' && item.blend_mode !== 'normal') {
      errors.push(`overlays[${index}]: invalid blend_mode`);
    }
  });

  const groups: Array<[string, TimelineAudioTrack[]]> = [
    ['voiceovers', timeline.voiceovers],
    ['music', timeline.music],
    ['sfx', timeline.sfx],
  ];
  for (const [name, tracks] of groups) {
    const ids = new Set<string>();
    tracks.forEach((item, index) => {
      validatePlacement(
        errors,
        `${name}[${index}]`,
        item.track_id,
        item.asset_id,
        item.timeline_start_us,
        item.timeline_duration_us,
        item.source_in_us,
        item.source_duration_us,
        timeline.duration_us,
        ids,
      );
    });
  }
  return errors;
}
