import type { RationalTime } from '@techsquidtv/canvas-timeline';
import { isFrameRate, type FrameRate } from './timebase';

/**
 * Producer-owned editorial document for this editor.
 *
 * Time is integer microseconds. This document is self-contained and knows
 * nothing about any renderer: no renderer types, adapters or stubs live here.
 * A separate producer outside this codebase may consume the exported JSON on
 * its own terms.
 */
export interface TimelineDocument {
  revision: number;
  /** Optional for backward compatibility; absent means 30/1. */
  frame_rate?: FrameRate;
  duration_us: number;
  segments: TimelineSegment[];
  /** Optional visual layers composited above V1. */
  overlays?: TimelineOverlay[];
  voiceovers: TimelineAudioTrack[];
  music: TimelineAudioTrack[];
  sfx: TimelineAudioTrack[];
}

export interface TimelineSegment {
  segment_id: string;
  asset_id: string;
  timeline_start_us: number;
  timeline_duration_us: number;
  source_in_us: number;
  source_duration_us: number;
  audio_enabled: boolean;
  audio_gain: number;
}

export interface TimelineOverlay {
  overlay_id: string;
  asset_id: string;
  timeline_start_us: number;
  timeline_duration_us: number;
  source_in_us: number;
  source_duration_us: number;
  opacity: number;
  blend_mode: 'screen' | 'normal';
}

export interface TimelineAudioTrack {
  track_id: string;
  asset_id: string;
  timeline_start_us: number;
  timeline_duration_us: number;
  source_in_us: number;
  source_duration_us: number;
  gain: number;
}

export const MICROS_PER_SECOND = 1_000_000;

/**
 * Canvas Timeline stores time as integer ticks. Using 1_000_000 ticks per
 * second keeps the microsecond document exact with no float drift.
 */
export function usToTime(us: number): RationalTime {
  return { v: Math.round(us), r: MICROS_PER_SECOND };
}

export function timeToUS(time: RationalTime): number {
  return Math.round((time.v * MICROS_PER_SECOND) / time.r);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural gate for imported project files. Semantic validation lives in
 * validateTimeline() so callers can show every violation, not only the first.
 */
export function isTimelineDocument(value: unknown): value is TimelineDocument {
  if (!isObject(value)) return false;
  return (
    typeof value.revision === 'number' &&
    (value.frame_rate === undefined || isFrameRate(value.frame_rate)) &&
    typeof value.duration_us === 'number' &&
    Array.isArray(value.segments) &&
    (value.overlays === undefined || Array.isArray(value.overlays)) &&
    Array.isArray(value.voiceovers) &&
    Array.isArray(value.music) &&
    Array.isArray(value.sfx)
  );
}
