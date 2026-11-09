import { useEffect, useRef, type CSSProperties } from 'react';
import {
  toSeconds,
  useTimeline,
  useTimelinePlayback,
  useTimelinePlayheadTime,
  type Clip,
  type TimelineReadonly,
  type TimelineStateSnapshot,
} from '@techsquidtv/canvas-timeline';
import type { MediaAsset } from '../timeline/assets';
import type { TimelineDocument } from '../timeline/document';
import {
  MUSIC_TRACK_ID,
  OVERLAY_TRACK_ID,
  SFX_TRACK_ID,
  VIDEO_TRACK_ID,
  VOICEOVER_TRACK_ID,
} from '../timeline/project';

interface PreviewMonitorProps {
  assets: MediaAsset[];
  timeline: TimelineDocument;
  title: string;
}

type Tracks = TimelineStateSnapshot['tracks'];
type AudioGroup = 'voiceovers' | 'music' | 'sfx';

interface ActiveAudio {
  trackId: string;
  group: AudioGroup;
  clip: TimelineReadonly<Clip>;
  asset: MediaAsset;
  gain: number;
}

function findActiveClip(
  tracks: Tracks,
  trackId: string,
  seconds: number,
): TimelineReadonly<Clip> | null {
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (!track || !track.visible) return null;
  return (
    [...track.clips]
      .reverse()
      .find(
        (clip) =>
          !clip.disabled &&
          seconds >= toSeconds(clip.timelineStart) &&
          seconds < toSeconds(clip.timelineEnd),
      ) ?? null
  );
}

function ActiveVideo({
  clip,
  asset,
  seconds,
  playing,
  className,
  style,
}: {
  clip: TimelineReadonly<Clip> | null;
  asset: MediaAsset | undefined;
  seconds: number;
  playing: boolean;
  className: string;
  style?: CSSProperties;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const currentClipId = useRef<string | null>(null);

  const clipId = clip?.id ?? null;
  const assetUrl = asset?.proxyUrl ?? asset?.url ?? null;
  const clipTimelineStart = clip ? toSeconds(clip.timelineStart) : 0;
  const clipSourceStart = clip ? toSeconds(clip.sourceStart) : 0;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!clipId || !assetUrl) {
      video.pause();
      return;
    }

    const desired = Math.max(0, clipSourceStart + (seconds - clipTimelineStart));

    if (currentClipId.current !== clipId) {
      currentClipId.current = clipId;
      video.src = assetUrl;
      video.load();
      pendingSeek.current = desired;
    } else if (video.readyState >= 1) {
      const drift = Math.abs(video.currentTime - desired);
      if (drift > (playing ? 0.3 : 0.05)) video.currentTime = desired;
    } else {
      pendingSeek.current = desired;
    }

    if (playing) {
      if (video.paused) void video.play().catch(() => undefined);
    } else if (!video.paused) {
      video.pause();
    }
  }, [assetUrl, clipId, clipSourceStart, clipTimelineStart, playing, seconds]);

  return (
    <video
      ref={videoRef}
      className={className}
      style={style}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={() => {
        const video = videoRef.current;
        if (!video) return;
        if (pendingSeek.current !== null) {
          video.currentTime = pendingSeek.current;
          pendingSeek.current = null;
        }
        if (playing) void video.play().catch(() => undefined);
      }}
    />
  );
}

function ActiveAudioChannel({
  clip,
  asset,
  gain,
  seconds,
  playing,
}: {
  clip: TimelineReadonly<Clip>;
  asset: MediaAsset;
  gain: number;
  seconds: number;
  playing: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeek = useRef<number | null>(null);

  const clipTimelineStart = toSeconds(clip.timelineStart);
  const clipSourceStart = toSeconds(clip.sourceStart);
  const desired = Math.max(0, clipSourceStart + (seconds - clipTimelineStart));

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.volume = Math.max(0, Math.min(1, gain));

    if (audio.readyState >= 1) {
      const drift = Math.abs(audio.currentTime - desired);
      if (!playing || drift > 0.3) audio.currentTime = desired;
    } else {
      pendingSeek.current = desired;
    }

    if (playing) {
      if (audio.paused) void audio.play().catch(() => undefined);
    } else if (!audio.paused) {
      audio.pause();
    }
  }, [desired, gain, playing]);

  return (
    <audio
      ref={audioRef}
      src={asset.proxyUrl ?? asset.url}
      preload="auto"
      onLoadedMetadata={() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (pendingSeek.current !== null) {
          audio.currentTime = pendingSeek.current;
          pendingSeek.current = null;
        }
        if (playing) void audio.play().catch(() => undefined);
      }}
    />
  );
}

function findActiveAudio(
  tracks: Tracks,
  group: AudioGroup,
  trackId: string,
  timeline: TimelineDocument,
  assets: MediaAsset[],
  seconds: number,
): ActiveAudio | null {
  const clip = findActiveClip(tracks, trackId, seconds);
  if (!clip) return null;
  const asset = assets.find((candidate) => candidate.id === clip.sourceId);
  if (!asset?.url) return null;
  const source = timeline[group].find((candidate) => candidate.track_id === clip.id);
  return {
    trackId,
    group,
    clip,
    asset,
    gain: source?.gain ?? 1,
  };
}

/**
 * Product-owned preview. It plays the real sources referenced by the
 * timeline document: V1 video, V2 overlay with screen blend, and the three
 * audio lanes. It is a picture/sound monitor, not a final renderer.
 */
export function PreviewMonitor({ assets, timeline, title }: PreviewMonitorProps) {
  const { state } = useTimeline();
  const playhead = useTimelinePlayheadTime();
  const { playing } = useTimelinePlayback();
  const seconds = toSeconds(playhead);

  const mainClip = findActiveClip(state.tracks, VIDEO_TRACK_ID, seconds);
  const overlayClip = findActiveClip(state.tracks, OVERLAY_TRACK_ID, seconds);
  const mainAsset = mainClip
    ? assets.find((candidate) => candidate.id === mainClip.sourceId)
    : undefined;
  const overlayAsset = overlayClip
    ? assets.find((candidate) => candidate.id === overlayClip.sourceId)
    : undefined;
  const overlaySpec = overlayClip
    ? timeline.overlays?.find((overlay) => overlay.overlay_id === overlayClip.id)
    : undefined;

  const activeAudio = [
    findActiveAudio(
      state.tracks,
      'voiceovers',
      VOICEOVER_TRACK_ID,
      timeline,
      assets,
      seconds,
    ),
    findActiveAudio(state.tracks, 'music', MUSIC_TRACK_ID, timeline, assets, seconds),
    findActiveAudio(state.tracks, 'sfx', SFX_TRACK_ID, timeline, assets, seconds),
  ].filter((item): item is ActiveAudio => item !== null);

  const overlayStyle: CSSProperties | undefined = overlaySpec
    ? {
        opacity: overlaySpec.opacity,
        mixBlendMode: overlaySpec.blend_mode,
      }
    : undefined;

  return (
    <div className="monitor">
      <ActiveVideo
        clip={mainClip}
        asset={mainAsset}
        seconds={seconds}
        playing={playing}
        className={mainClip && mainAsset ? 'monitor-video' : 'monitor-video is-idle'}
      />
      {overlayClip && overlayAsset ? (
        <ActiveVideo
          clip={overlayClip}
          asset={overlayAsset}
          seconds={seconds}
          playing={playing}
          className="monitor-overlay-video"
          style={overlayStyle}
        />
      ) : null}
      <div className="monitor-topline">
        <span className="monitor-title">{title}</span>
        <span className={`monitor-live ${playing ? 'is-playing' : ''}`}>
          {playing ? 'PLAYING' : 'PREVIEW'}
          {activeAudio.length > 0 ? ` · ${activeAudio.length} AUDIO` : ''}
        </span>
      </div>
      {mainClip ? (
        <div className="monitor-caption">
          <strong>{mainClip.label ?? mainClip.id}</strong>
          <span>{mainAsset?.name ?? mainClip.sourceId}</span>
          {overlayClip ? (
            <span className="monitor-overlay-label">
              V2 · {overlayAsset?.name ?? overlayClip.sourceId}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="monitor-empty">
          <strong>Nessun clip video sotto il playhead</strong>
          <span>Sposta il playhead su un segmento per vedere l&apos;anteprima.</span>
        </div>
      )}
      <div className="monitor-audio" aria-hidden="true">
        {activeAudio.map((audio) => (
          <ActiveAudioChannel
            key={`${audio.group}:${audio.clip.id}`}
            clip={audio.clip}
            asset={audio.asset}
            gain={audio.gain}
            seconds={seconds}
            playing={playing}
          />
        ))}
      </div>
      <div className="monitor-footnote">
        anteprima video/audio · sorgenti reali · render completo via MCP
      </div>
    </div>
  );
}
