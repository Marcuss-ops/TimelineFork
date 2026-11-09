export type MediaKind = 'video' | 'audio' | 'overlay';

export interface MediaAsset {
  id: string;
  name: string;
  kind: MediaKind;
  /** Resolved preview source. */
  url?: string;
  /** Optional still used by the project gallery. */
  posterUrl?: string;
  /** Preview proxy; the final render keeps using the original URL. */
  proxyUrl?: string;
  durationUS: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  /** Present on imported assets, used for hash deduplication. */
  sha256?: string;
  createdAt?: string;
}

/**
 * The demo media lives entirely in this app. Chronon and its renderer never
 * import this catalogue; an external consumer can read the exported document
 * and resolve the same relative URLs on its own.
 */
export const MEDIA_ASSETS: MediaAsset[] = [
  {
    id: 'asset-documentary',
    name: 'Earth · Blue Marble',
    kind: 'video',
    url: '/media/real/earth-blue-marble.mp4',
    posterUrl: '/media/real/posters/earth-blue-marble.jpg',
    durationUS: 2_500_000,
  },
  {
    id: 'asset-media-card',
    name: 'Natural Earth · Relief',
    kind: 'video',
    url: '/media/real/natural-relief.mp4',
    posterUrl: '/media/real/posters/natural-relief.jpg',
    durationUS: 2_500_000,
  },
  {
    id: 'asset-world-map',
    name: 'Claude Map · Paper',
    kind: 'video',
    url: '/media/real/claude-map.mp4',
    posterUrl: '/media/real/posters/claude-map.jpg',
    durationUS: 2_500_000,
  },
  {
    id: 'asset-device-browser',
    name: 'Paper Texture',
    kind: 'video',
    url: '/media/real/paper-texture.mp4',
    posterUrl: '/media/real/posters/paper-texture.jpg',
    durationUS: 2_500_000,
  },
  {
    id: 'asset-shape-gallery',
    name: 'Retro Stat · 1990s',
    kind: 'video',
    url: '/media/real/retro-stat.mp4',
    posterUrl: '/media/real/posters/retro-stat.jpg',
    durationUS: 2_500_000,
  },
  {
    id: 'asset-overlay-market',
    name: 'Overlay · Il mercato cambia',
    kind: 'overlay',
    url: '/media/real/overlay-market.mp4',
    durationUS: 1_750_000,
  },
  {
    id: 'asset-overlay-growth',
    name: 'Overlay · La crescita continua',
    kind: 'overlay',
    url: '/media/real/overlay-growth.mp4',
    durationUS: 1_916_667,
  },
  {
    id: 'asset-voiceover',
    name: 'Voiceover · Intro',
    kind: 'audio',
    url: '/media/real/voiceover-intro.m4a',
    durationUS: 2_300_000,
  },
  {
    id: 'asset-voiceover-2',
    name: 'Voiceover · Body',
    kind: 'audio',
    url: '/media/real/voiceover-body.m4a',
    durationUS: 4_500_000,
  },
  {
    id: 'asset-music-bed',
    name: 'Music Bed · BGM',
    kind: 'audio',
    url: '/media/real/music-bed.m4a',
    durationUS: 12_500_000,
  },
  {
    id: 'asset-sfx-whoosh',
    name: 'Whoosh SFX',
    kind: 'audio',
    url: '/media/real/whoosh-1.m4a',
    durationUS: 984_000,
  },
  {
    id: 'asset-sfx-riser',
    name: 'Whoosh SFX · Long',
    kind: 'audio',
    url: '/media/real/whoosh-2.m4a',
    durationUS: 1_900_000,
  },
];

let dynamicAssets: MediaAsset[] = [];
let dynamicById = new Map<string, MediaAsset>();
let lastRefreshAt = 0;
let refreshInFlight: Promise<MediaAsset[]> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isMediaAsset(value: unknown): value is MediaAsset {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    (value.kind === 'video' || value.kind === 'audio' || value.kind === 'overlay') &&
    typeof value.durationUS === 'number' &&
    Number.isFinite(value.durationUS) &&
    value.durationUS >= 0 &&
    (value.url === undefined || typeof value.url === 'string') &&
    (value.posterUrl === undefined || typeof value.posterUrl === 'string') &&
    (value.proxyUrl === undefined || typeof value.proxyUrl === 'string')
  );
}

/** Merge the relay's imported assets into the static demo catalog. */
export function setDynamicAssets(assets: MediaAsset[]): void {
  dynamicAssets = assets.filter(isMediaAsset);
  dynamicById = new Map(dynamicAssets.map((asset) => [asset.id, asset]));
}

export function allAssets(): MediaAsset[] {
  const merged = new Map(MEDIA_ASSETS.map((asset) => [asset.id, asset]));
  for (const asset of dynamicAssets) merged.set(asset.id, asset);
  return [...merged.values()];
}

export function assetName(assetId: string): string {
  return assetById(assetId)?.name ?? assetId;
}

export function assetById(assetId: string): MediaAsset | undefined {
  return dynamicById.get(assetId) ?? MEDIA_ASSETS.find((asset) => asset.id === assetId);
}

/**
 * Pull imported assets from the relay. Browser callers pass no base URL; the
 * MCP passes its relay URL. A short cache avoids probing before every frame.
 */
export async function refreshAssets(
  baseUrl = '',
  options: { force?: boolean } = {},
): Promise<MediaAsset[]> {
  if (!options.force && Date.now() - lastRefreshAt < 3_000) return allAssets();
  if (refreshInFlight) return refreshInFlight;

  const prefix = baseUrl.replace(/\/$/, '');
  refreshInFlight = fetch(`${prefix}/api/assets`, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`assets relay ${response.status}`);
      const payload: unknown = await response.json();
      const list = isRecord(payload) && Array.isArray(payload.assets) ? payload.assets : [];
      setDynamicAssets(list.filter(isMediaAsset));
      lastRefreshAt = Date.now();
      return allAssets();
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}
