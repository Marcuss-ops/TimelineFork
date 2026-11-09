import type {
  TimelineDocument,
  TimelineOverlay,
  TimelineSegment,
} from '../src/timeline/document';
import { assetById, assetName } from '../src/timeline/assets';
import { durationFrames, frameRateOf, MICROS_PER_SECOND } from '../src/timeline/timebase';

/**
 * OpenTimelineIO-compatible export.
 *
 * OTIO uses RationalTime, so every document microsecond is preserved exactly
 * with rate=MICROS_PER_SECOND. The project frame rate is carried in metadata
 * for consumers that need frame-addressed editing. This adapter is outside
 * the timeline core and does not know how frames are rendered.
 */
type Json = Record<string, unknown>;

function rationalTime(valueUS: number): Json {
  return {
    OTIO_SCHEMA: 'RationalTime.1',
    rate: MICROS_PER_SECOND,
    value: valueUS,
  };
}

function timeRange(startUS: number, durationUS: number): Json {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rationalTime(startUS),
    duration: rationalTime(durationUS),
  };
}

function clip(
  id: string,
  assetId: string,
  name: string,
  startUS: number,
  durationUS: number,
  sourceInUS: number,
  metadata: Json,
): Json {
  const asset = assetById(assetId);
  const mediaReference: Json = {
    OTIO_SCHEMA: 'ExternalReference.1',
    target_url: asset?.url ?? assetId,
    metadata: {
      velox: {
        asset_id: assetId,
        kind: asset?.kind ?? 'unknown',
      },
    },
  };
  if (asset) mediaReference.available_range = timeRange(0, asset.durationUS);

  return {
    OTIO_SCHEMA: 'Clip.1',
    name: name || assetName(assetId),
    media_reference: mediaReference,
    source_range: timeRange(sourceInUS, durationUS),
    metadata: {
      velox: {
        clip_id: id,
        asset_id: assetId,
        timeline_start_us: startUS,
        timeline_duration_us: durationUS,
        source_in_us: sourceInUS,
        ...metadata,
      },
    },
  };
}

function videoClip(segment: TimelineSegment, index: number): Json {
  return clip(
    segment.segment_id,
    segment.asset_id,
    `${index + 1} · ${assetName(segment.asset_id)}`,
    segment.timeline_start_us,
    segment.timeline_duration_us,
    segment.source_in_us,
    {
      audio_enabled: segment.audio_enabled,
      audio_gain: segment.audio_gain,
    },
  );
}

function overlayClip(overlay: TimelineOverlay, index: number): Json {
  return clip(
    overlay.overlay_id,
    overlay.asset_id,
    `V2 · ${index + 1} · ${assetName(overlay.asset_id)}`,
    overlay.timeline_start_us,
    overlay.timeline_duration_us,
    overlay.source_in_us,
    {
      opacity: overlay.opacity,
      blend_mode: overlay.blend_mode,
    },
  );
}

export function timelineToOTIO(title: string, timeline: TimelineDocument): Json {
  const frameRate = frameRateOf(timeline);
  const videoTrack: Json = {
    OTIO_SCHEMA: 'Track.1',
    name: 'V1',
    kind: 'Video',
    metadata: { velox: { role: 'video' } },
    children: [...timeline.segments]
      .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
      .map(videoClip),
  };

  const overlayTrack: Json | null =
    timeline.overlays && timeline.overlays.length > 0
      ? {
          OTIO_SCHEMA: 'Track.1',
          name: 'V2',
          kind: 'Video',
          metadata: { velox: { role: 'overlay' } },
          children: [...timeline.overlays]
            .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
            .map(overlayClip),
        }
      : null;

  const audioGroups = [
    ['A1', 'Voiceover', timeline.voiceovers],
    ['A2', 'Music', timeline.music],
    ['A3', 'SFX', timeline.sfx],
  ] as const;

  const audioTracks: Json[] = audioGroups.map(([name, label, tracks]) => ({
    OTIO_SCHEMA: 'Track.1',
    name,
    kind: 'Audio',
    metadata: { velox: { role: label.toLowerCase() } },
    children: [...tracks]
      .sort((a, b) => a.timeline_start_us - b.timeline_start_us)
      .map((track) =>
        clip(
          track.track_id,
          track.asset_id,
          `${label} · ${assetName(track.asset_id)}`,
          track.timeline_start_us,
          track.timeline_duration_us,
          track.source_in_us,
          { gain: track.gain },
        ),
      ),
  }));

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: title,
    global_start_time: rationalTime(0),
    metadata: {
      velox: {
        revision: timeline.revision,
        frame_rate: frameRate,
        duration_us: timeline.duration_us,
        duration_frames: durationFrames(timeline.duration_us, frameRate),
      },
    },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [videoTrack, ...(overlayTrack ? [overlayTrack] : []), ...audioTracks],
    },
  };
}
