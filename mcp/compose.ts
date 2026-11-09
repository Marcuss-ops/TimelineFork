import type { MediaAsset } from '../src/timeline/assets';
import type { TimelineDocument } from '../src/timeline/document';
import {
  addAudioClipUS,
  addOverlayClipUS,
  addVideoClipUS,
  createEmptyDocument,
  setDurationUS,
} from '../src/timeline/operations';

export type ComposeTone = 'energetic' | 'calm' | 'documentary';
export type ComposePlatform = 'landscape' | 'vertical' | 'square';

export interface ComposeInput {
  brief: string;
  durationUS: number;
  assets: MediaAsset[];
  assetIds?: string[];
  musicAssetId?: string;
  voiceoverAssetId?: string;
  sfxAssetId?: string;
  tone?: ComposeTone;
  platform?: ComposePlatform;
}

export interface ComposeResult {
  document: TimelineDocument;
  notes: {
    brief: string;
    tone: ComposeTone;
    platform: ComposePlatform;
    requested_duration_us: number;
    video_assets: string[];
    overlays: string[];
    music: string | null;
    voiceover: string | null;
    sfx: string | null;
    ducked: boolean;
    warnings: string[];
  };
}

const TONE_SLOT_US: Record<ComposeTone, number> = {
  energetic: 2_000_000,
  calm: 4_000_000,
  documentary: 2_800_000,
};

function keywords(brief: string): string[] {
  return [
    ...new Set(
      brief
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4),
    ),
  ];
}

function scoreAsset(asset: MediaAsset, words: string[]): number {
  const haystack = `${asset.name} ${asset.id}`.toLowerCase();
  return words.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

function chooseVideos(input: ComposeInput, warnings: string[]): MediaAsset[] {
  const allVideos = input.assets.filter((asset) => asset.kind === 'video');
  if (input.assetIds && input.assetIds.length > 0) {
    const requested = input.assetIds
      .map((id) => allVideos.find((asset) => asset.id === id))
      .filter((asset): asset is MediaAsset => Boolean(asset));
    const missing = input.assetIds.filter((id) => !requested.some((asset) => asset.id === id));
    if (missing.length > 0) warnings.push(`video assets not found: ${missing.join(', ')}`);
    if (requested.length > 0) return requested;
  }

  if (allVideos.length === 0) return [];
  const words = keywords(input.brief);
  return [...allVideos].sort((a, b) => {
    const delta = scoreAsset(b, words) - scoreAsset(a, words);
    return delta !== 0 ? delta : allVideos.indexOf(a) - allVideos.indexOf(b);
  });
}

function pickAudio(
  input: ComposeInput,
  explicitId: string | undefined,
  pattern: RegExp,
  warnings: string[],
  label: string,
): MediaAsset | null {
  const audio = input.assets.filter((asset) => asset.kind === 'audio');
  if (explicitId) {
    const found = audio.find((asset) => asset.id === explicitId);
    if (!found) warnings.push(`${label} asset not found: ${explicitId}`);
    return found ?? null;
  }
  return audio.find((asset) => pattern.test(`${asset.name} ${asset.id}`)) ?? null;
}

function clipDuration(asset: MediaAsset, wantedUS: number): number {
  return Math.max(1, Math.min(wantedUS, Math.floor(asset.durationUS)));
}

export function composeDocument(input: ComposeInput): ComposeResult {
  if (!Number.isSafeInteger(input.durationUS) || input.durationUS <= 0) {
    throw new Error('duration must be a positive number of microseconds');
  }
  if (input.durationUS > 300_000_000) {
    throw new Error('duration must not exceed 300 seconds');
  }
  const brief = input.brief.trim();
  if (brief.length === 0) throw new Error('brief must not be empty');

  const tone = input.tone ?? 'documentary';
  const platform = input.platform ?? 'landscape';
  const warnings: string[] = [];
  const videos = chooseVideos(input, warnings);
  if (videos.length === 0) {
    throw new Error('compose needs at least one video asset; import media first');
  }

  const slotUS = TONE_SLOT_US[tone];
  const wantedClips = Math.max(1, Math.ceil(input.durationUS / slotUS));
  const clips = videos.slice(0, Math.min(videos.length, wantedClips));
  const perClipUS = Math.floor(input.durationUS / clips.length);

  let document = createEmptyDocument(input.durationUS / 1_000_000);
  const usedVideos: string[] = [];
  for (const [index, asset] of clips.entries()) {
    const startUS = index * perClipUS;
    const durationUS = clipDuration(asset, perClipUS);
    if (startUS + durationUS > input.durationUS) break;
    document = addVideoClipUS(document, {
      assetId: asset.id,
      startUS,
      durationUS,
      segmentId: `compose-v-${String(index + 1).padStart(2, '0')}`,
    }).document;
    usedVideos.push(asset.name);
  }

  if (usedVideos.length === 0) throw new Error('compose could not place any video clip');

  const totalVideo = clips.reduce(
    (sum, asset) => sum + Math.min(perClipUS, asset.durationUS),
    0,
  );
  if (totalVideo < input.durationUS) {
    warnings.push(
      `source media covers ${(totalVideo / 1_000_000).toFixed(1)}s of ${(input.durationUS / 1_000_000).toFixed(1)}s; the remaining timeline stays black`,
    );
  }

  const overlays = input.assets
    .filter((asset) => asset.kind === 'overlay')
    .slice(0, 2)
    .map((asset, index) => {
      const startUS = Math.floor(input.durationUS * (index === 0 ? 0.16 : 0.62));
      const durationUS = Math.min(2_000_000, asset.durationUS, input.durationUS - startUS);
      return { asset, startUS, durationUS };
    })
    .filter((entry) => entry.durationUS >= 300_000);

  const usedOverlays: string[] = [];
  for (const [index, entry] of overlays.entries()) {
    document = addOverlayClipUS(document, {
      assetId: entry.asset.id,
      startUS: entry.startUS,
      durationUS: entry.durationUS,
      opacity: 0.9,
      blendMode: 'screen',
      overlayId: `compose-overlay-${index + 1}`,
    }).document;
    usedOverlays.push(entry.asset.name);
  }

  const voiceover = pickAudio(
    input,
    input.voiceoverAssetId,
    /voice|vo|narration/i,
    warnings,
    'voiceover',
  );
  let voiceStartUS = 0;
  let voiceEndUS = 0;
  if (voiceover) {
    voiceStartUS = Math.min(400_000, Math.max(0, input.durationUS - 1));
    const durationUS = Math.min(voiceover.durationUS, input.durationUS - voiceStartUS);
    if (durationUS > 0) {
      document = addAudioClipUS(document, {
        kind: 'voiceover',
        assetId: voiceover.id,
        startUS: voiceStartUS,
        durationUS,
        gain: 1,
        clipId: 'compose-voiceover',
      }).document;
      voiceEndUS = voiceStartUS + durationUS;
    }
  }

  const music = pickAudio(input, input.musicAssetId, /music|bed|bgm|theme/i, warnings, 'music');
  let ducked = false;
  if (music) {
    const musicEndUS = Math.min(input.durationUS, music.durationUS);
    const musicSegments =
      voiceover && voiceEndUS > 0 && voiceStartUS < musicEndUS
        ? [
            { startUS: 0, endUS: Math.min(voiceStartUS, musicEndUS), gain: 0.7 },
            {
              startUS: Math.max(0, voiceStartUS),
              endUS: Math.min(voiceEndUS, musicEndUS),
              gain: 0.3,
            },
            {
              startUS: Math.min(voiceEndUS, musicEndUS),
              endUS: musicEndUS,
              gain: 0.7,
            },
          ]
        : [{ startUS: 0, endUS: musicEndUS, gain: 0.7 }];

    for (const [index, segment] of musicSegments.entries()) {
      const durationUS = segment.endUS - segment.startUS;
      if (durationUS <= 0) continue;
      document = addAudioClipUS(document, {
        kind: 'music',
        assetId: music.id,
        startUS: segment.startUS,
        sourceInUS: segment.startUS,
        durationUS,
        gain: segment.gain,
        clipId: `compose-music-${index + 1}`,
      }).document;
      if (segment.gain < 0.7) ducked = true;
    }
    if (musicEndUS < input.durationUS) {
      warnings.push('music is shorter than the timeline and is not looped');
    }
  } else {
    warnings.push('no music asset found');
  }

  if (!voiceover) warnings.push('no voiceover asset found; music is not ducked');

  const sfx =
    pickAudio(input, input.sfxAssetId, /whoosh|sfx|riser|impact/i, warnings, 'sfx') ??
    pickAudio(input, undefined, /whoosh|sfx|riser|impact/i, warnings, 'sfx');
  if (sfx) {
    const cutPoints = [
      ...new Set([
        ...clips.slice(1).map((_, index) => (index + 1) * perClipUS),
        ...overlays.map((entry) => entry.startUS),
      ]),
    ]
      .filter((startUS) => startUS >= 0 && startUS < input.durationUS)
      .sort((a, b) => a - b)
      .slice(0, 8);
    if (cutPoints.length === 0) {
      cutPoints.push(Math.min(500_000, Math.floor(input.durationUS / 2)));
    }
    for (const [index, startUS] of cutPoints.entries()) {
      const durationUS = Math.min(400_000, sfx.durationUS, input.durationUS - startUS);
      if (durationUS <= 0) continue;
      document = addAudioClipUS(document, {
        kind: 'sfx',
        assetId: sfx.id,
        startUS,
        durationUS,
        gain: 0.8,
        clipId: `compose-sfx-${index + 1}`,
      }).document;
    }
  } else {
    warnings.push('no SFX asset found');
  }

  document = setDurationUS(document, input.durationUS);

  return {
    document,
    notes: {
      brief,
      tone,
      platform,
      requested_duration_us: input.durationUS,
      video_assets: usedVideos,
      overlays: usedOverlays,
      music: music?.name ?? null,
      voiceover: voiceover?.name ?? null,
      sfx: sfx?.name ?? null,
      ducked,
      warnings,
    },
  };
}
