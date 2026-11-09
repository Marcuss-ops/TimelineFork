import {
  TimelineEngine,
  type Clip,
  type TimelineStateSnapshot,
  type Track,
} from '@techsquidtv/canvas-timeline';
import {
  timeToUS,
  usToTime,
  type TimelineAudioTrack,
  type TimelineDocument,
  type TimelineOverlay,
  type TimelineSegment,
} from './document';
import { allAssets, assetName, type MediaAsset } from './assets';
import { DEFAULT_FRAME_RATE } from './timebase';
import { createDemoDocument } from './operations';

export { MEDIA_ASSETS } from './assets';
export { validateTimeline } from './operations';

export const VIDEO_TRACK_ID = 'track-video';
export const OVERLAY_TRACK_ID = 'track-overlay';
export const VOICEOVER_TRACK_ID = 'track-voiceover';
export const MUSIC_TRACK_ID = 'track-music';
export const SFX_TRACK_ID = 'track-sfx';

const CLIP_COLORS = [
  '#4f7cff',
  '#2fbf9f',
  '#d9a441',
  '#e0644a',
  '#9b6bff',
  '#3aa7e0',
] as const;

export const DEMO_TIMELINE: TimelineDocument = createDemoDocument();

function emptyTrack(id: string, kind: string, name: string): Track {
  return {
    id,
    kind,
    name,
    clips: [],
    selected: false,
    locked: false,
    muted: false,
    visible: true,
    targeted: false,
    height: 58,
  };
}

function assetLabel(assetId: string, assets: MediaAsset[]): string {
  return assets.find((asset) => asset.id === assetId)?.name ?? assetName(assetId);
}

function segmentClip(item: TimelineSegment, index: number, assets: MediaAsset[]): Clip {
  return {
    id: item.segment_id,
    sourceId: item.asset_id,
    timelineStart: usToTime(item.timeline_start_us),
    timelineEnd: usToTime(item.timeline_start_us + item.timeline_duration_us),
    sourceStart: usToTime(item.source_in_us),
    selected: false,
    color: CLIP_COLORS[index % CLIP_COLORS.length],
    label: `${index + 1} · ${assetLabel(item.asset_id, assets)}`,
  };
}

function overlayClip(item: TimelineOverlay, index: number, assets: MediaAsset[]): Clip {
  return {
    id: item.overlay_id,
    sourceId: item.asset_id,
    timelineStart: usToTime(item.timeline_start_us),
    timelineEnd: usToTime(item.timeline_start_us + item.timeline_duration_us),
    sourceStart: usToTime(item.source_in_us),
    selected: false,
    color: '#b56cff',
    label: `V2 · ${index + 1} · ${assetLabel(item.asset_id, assets)}`,
  };
}

function audioClip(item: TimelineAudioTrack, color: string, assets: MediaAsset[]): Clip {
  return {
    id: item.track_id,
    sourceId: item.asset_id,
    timelineStart: usToTime(item.timeline_start_us),
    timelineEnd: usToTime(item.timeline_start_us + item.timeline_duration_us),
    sourceStart: usToTime(item.source_in_us),
    selected: false,
    color,
    label: assetLabel(item.asset_id, assets),
  };
}

/** Build the complete editor lane set from the editor-owned document. */
export function tracksFromTimeline(
  timeline: TimelineDocument,
  assets: MediaAsset[] = allAssets(),
): Track[] {
  const video = emptyTrack(VIDEO_TRACK_ID, 'visual', 'V1 · Video');
  video.targeted = true;
  video.clips = [...timeline.segments]
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
    .map((item, index) => segmentClip(item, index, assets));

  const tracks: Track[] = [video];

  if (timeline.overlays && timeline.overlays.length > 0) {
    const overlay = emptyTrack(OVERLAY_TRACK_ID, 'visual', 'V2 · Overlay');
    overlay.clips = [...timeline.overlays]
      .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
      .map((item, index) => overlayClip(item, index, assets));
    tracks.push(overlay);
  }

  const voiceover = emptyTrack(VOICEOVER_TRACK_ID, 'audio', 'A1 · Voce');
  voiceover.clips = [...timeline.voiceovers]
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
    .map((item) => audioClip(item, '#4a5a78', assets));

  const music = emptyTrack(MUSIC_TRACK_ID, 'audio', 'A2 · Musica');
  music.clips = [...timeline.music]
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
    .map((item) => audioClip(item, '#2f7d6d', assets));

  const sfx = emptyTrack(SFX_TRACK_ID, 'audio', 'A3 · SFX');
  sfx.clips = [...timeline.sfx]
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
    .map((item) => audioClip(item, '#7d5a2f', assets));

  return [...tracks, voiceover, music, sfx];
}

export function createEngine(
  timeline: TimelineDocument,
  assets: MediaAsset[] = allAssets(),
): TimelineEngine {
  return new TimelineEngine({
    duration: usToTime(timeline.duration_us),
    playheadTime: usToTime(0),
    zoomScale: 76,
    tracks: tracksFromTimeline(timeline, assets),
  });
}

function groupFromState(
  state: TimelineStateSnapshot,
  trackId: string,
  base: TimelineAudioTrack[],
): TimelineAudioTrack[] {
  const track = state.tracks.find((candidate) => candidate.id === trackId);
  // During engine hydration a lane can be missing for a render; preserve the
  // document instead of treating it as an intentional deletion.
  if (!track) return base;
  return [...track.clips]
    .sort((a, b) => timeToUS(a.timelineStart) - timeToUS(b.timelineStart))
    .map((clip) => {
      const duration = Math.max(1, timeToUS(clip.timelineEnd) - timeToUS(clip.timelineStart));
      const original = base.find((item) => item.track_id === clip.id);
      return {
        track_id: clip.id,
        asset_id: clip.sourceId,
        timeline_start_us: Math.max(0, timeToUS(clip.timelineStart)),
        timeline_duration_us: duration,
        source_in_us: Math.max(0, timeToUS(clip.sourceStart)),
        source_duration_us: duration,
        gain: original?.gain ?? 1,
      };
    });
}

/**
 * Convert live editor state back into the editor-owned document.
 * No renderer types cross this boundary and nothing here knows how frames
 * will be produced later.
 */
export function documentFromState(
  state: TimelineStateSnapshot,
  base: TimelineDocument,
): TimelineDocument {
  const videoTrack = state.tracks.find((track) => track.id === VIDEO_TRACK_ID);
  const segments: TimelineSegment[] = [...(videoTrack?.clips ?? [])]
    .sort((a, b) => timeToUS(a.timelineStart) - timeToUS(b.timelineStart))
    .map((clip) => {
      const duration = Math.max(1, timeToUS(clip.timelineEnd) - timeToUS(clip.timelineStart));
      const original = base.segments.find((item) => item.segment_id === clip.id);
      return {
        segment_id: clip.id,
        asset_id: clip.sourceId,
        timeline_start_us: Math.max(0, timeToUS(clip.timelineStart)),
        timeline_duration_us: duration,
        source_in_us: Math.max(0, timeToUS(clip.sourceStart)),
        source_duration_us: duration,
        audio_enabled: original?.audio_enabled ?? false,
        audio_gain: original?.audio_gain ?? 1,
      };
    });

  const overlayTrack = state.tracks.find((track) => track.id === OVERLAY_TRACK_ID);
  const overlays: TimelineOverlay[] = overlayTrack
    ? [...overlayTrack.clips]
        .sort((a, b) => timeToUS(a.timelineStart) - timeToUS(b.timelineStart))
        .map((clip) => {
          const duration = Math.max(1, timeToUS(clip.timelineEnd) - timeToUS(clip.timelineStart));
          const original = base.overlays?.find((item) => item.overlay_id === clip.id);
          return {
            overlay_id: clip.id,
            asset_id: clip.sourceId,
            timeline_start_us: Math.max(0, timeToUS(clip.timelineStart)),
            timeline_duration_us: duration,
            source_in_us: Math.max(0, timeToUS(clip.sourceStart)),
            source_duration_us: duration,
            opacity: original?.opacity ?? 1,
            blend_mode: original?.blend_mode ?? 'screen',
          };
        })
    : [...(base.overlays ?? [])];

  const voiceovers = groupFromState(state, VOICEOVER_TRACK_ID, base.voiceovers);
  const music = groupFromState(state, MUSIC_TRACK_ID, base.music);
  const sfx = groupFromState(state, SFX_TRACK_ID, base.sfx);

  const contentEnd = Math.max(
    0,
    ...segments.map((item) => item.timeline_start_us + item.timeline_duration_us),
    ...overlays.map((item) => item.timeline_start_us + item.timeline_duration_us),
    ...voiceovers.map((item) => item.timeline_start_us + item.timeline_duration_us),
    ...music.map((item) => item.timeline_start_us + item.timeline_duration_us),
    ...sfx.map((item) => item.timeline_start_us + item.timeline_duration_us),
  );
  const fixedDuration = state.duration ? timeToUS(state.duration) : base.duration_us;

  return {
    revision: base.revision + 1,
    frame_rate: base.frame_rate ?? { ...DEFAULT_FRAME_RATE },
    duration_us: Math.max(1, fixedDuration, contentEnd),
    segments,
    overlays,
    voiceovers,
    music,
    sfx,
  };
}
