import { useEffect, useRef, useState } from 'react';
import { allAssets, refreshAssets, type MediaAsset } from '../timeline/assets';

function catalogSignature(assets: MediaAsset[]): string {
  return assets
    .map(
      (asset) =>
        `${asset.id}|${asset.name}|${asset.url ?? ''}|${asset.posterUrl ?? ''}|${asset.durationUS}`,
    )
    .join('\n');
}

/**
 * Static demo assets immediately, imported relay assets as soon as they load.
 * A live project revision can reference media imported after this tab opened,
 * so the catalog is refreshed with the document and polled as a fallback.
 */
export function useAssetCatalog(refreshKey?: number): MediaAsset[] {
  const [assets, setAssets] = useState<MediaAsset[]>(() => allAssets());
  const signatureRef = useRef(catalogSignature(assets));

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      refreshAssets('', { force: true })
        .then((next) => {
          if (cancelled) return;
          const nextSignature = catalogSignature(next);
          if (nextSignature === signatureRef.current) return;
          signatureRef.current = nextSignature;
          setAssets(next);
        })
        .catch(() => {
          // The current catalog stays usable while the relay is offline.
        });
    };

    void load();
    const interval = window.setInterval(load, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshKey]);

  return assets;
}
