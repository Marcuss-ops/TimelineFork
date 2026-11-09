/**
 * Rational frame/time arithmetic for the editor-owned timeline.
 *
 * The canonical document still stores integer microseconds, so no float is
 * ever accumulated by an edit. Agent-facing frame arguments are converted
 * through BigInt rationals; NTSC rates such as 30000/1001 never lose frames
 * because of binary floating-point rounding.
 */
export interface FrameRate {
  numerator: number;
  denominator: number;
}

export interface Timebase {
  frame_rate: FrameRate;
  duration_us: number;
  duration_frames: number;
}

export const MICROS_PER_SECOND = 1_000_000;
const MICROS = 1_000_000n;

export const DEFAULT_FRAME_RATE: FrameRate = Object.freeze({
  numerator: 30,
  denominator: 1,
});

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isFrameRate(value: unknown): value is FrameRate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { numerator?: unknown; denominator?: unknown };
  return isPositiveInteger(candidate.numerator) && isPositiveInteger(candidate.denominator);
}

export function validateFrameRate(rate: FrameRate): string[] {
  const errors: string[] = [];
  if (!isPositiveInteger(rate.numerator)) {
    errors.push('frame_rate.numerator must be a positive safe integer');
  }
  if (!isPositiveInteger(rate.denominator)) {
    errors.push('frame_rate.denominator must be a positive safe integer');
  }
  return errors;
}

export function resolveFrameRate(rate?: FrameRate | null): FrameRate {
  if (rate === undefined || rate === null) return DEFAULT_FRAME_RATE;
  const errors = validateFrameRate(rate);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return { numerator: rate.numerator, denominator: rate.denominator };
}

/** Resolve the frame rate stored in a timeline-like document. */
export function frameRateOf(document: { frame_rate?: FrameRate | null }): FrameRate {
  return resolveFrameRate(document.frame_rate);
}

function assertFrame(frame: number): void {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error('frame must be a non-negative safe integer');
  }
}

function assertMicroseconds(us: number): void {
  if (!Number.isSafeInteger(us) || us < 0) {
    throw new Error('microseconds must be a non-negative safe integer');
  }
}

/** Convert a frame index to integer microseconds with half-up rounding. */
export function frameToUS(frame: number, rate: FrameRate = DEFAULT_FRAME_RATE): number {
  assertFrame(frame);
  const resolved = resolveFrameRate(rate);
  const numerator = BigInt(frame) * MICROS * BigInt(resolved.denominator);
  const denominator = BigInt(resolved.numerator);
  return Number((numerator + denominator / 2n) / denominator);
}

/** Convert integer microseconds to the nearest frame index. */
export function usToFrame(us: number, rate: FrameRate = DEFAULT_FRAME_RATE): number {
  assertMicroseconds(us);
  const resolved = resolveFrameRate(rate);
  const numerator = BigInt(us) * BigInt(resolved.numerator);
  const denominator = MICROS * BigInt(resolved.denominator);
  return Number((numerator + denominator / 2n) / denominator);
}

/** Convert integer microseconds to the last frame whose start is <= us. */
export function usToFrameFloor(us: number, rate: FrameRate = DEFAULT_FRAME_RATE): number {
  assertMicroseconds(us);
  const resolved = resolveFrameRate(rate);
  const numerator = BigInt(us) * BigInt(resolved.numerator);
  const denominator = MICROS * BigInt(resolved.denominator);
  return Number(numerator / denominator);
}

/** Number of frame slots that fit in a duration (ceil, so the last frame is included). */
export function durationFrames(durationUS: number, rate: FrameRate = DEFAULT_FRAME_RATE): number {
  assertMicroseconds(durationUS);
  const resolved = resolveFrameRate(rate);
  const numerator = BigInt(durationUS) * BigInt(resolved.numerator);
  const denominator = MICROS * BigInt(resolved.denominator);
  return Number((numerator + denominator - 1n) / denominator);
}

export function timebaseOf(durationUS: number, rate?: FrameRate | null): Timebase {
  const resolved = resolveFrameRate(rate);
  return {
    frame_rate: resolved,
    duration_us: durationUS,
    duration_frames: durationFrames(durationUS, resolved),
  };
}

export function formatFrameRate(rate: FrameRate): string {
  const resolved = resolveFrameRate(rate);
  return `${resolved.numerator}/${resolved.denominator}`;
}

/** Distinct frames covering [startUS, startUS + durationUS), as start-frame indices. */
export function framesInRange(
  startUS: number,
  durationUS: number,
  rate: FrameRate = DEFAULT_FRAME_RATE,
): number[] {
  assertMicroseconds(startUS);
  assertMicroseconds(durationUS);
  const resolved = resolveFrameRate(rate);
  if (durationUS === 0) return [];
  const first = usToFrameFloor(startUS, resolved);
  const last = durationFrames(startUS + durationUS, resolved) - 1;
  const count = Math.max(0, last - first + 1);
  return Array.from({ length: count }, (_, index) => first + index);
}
