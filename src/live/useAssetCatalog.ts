import { useEffect, useState } from 'react';
import { allAssets, refreshAssets, type MediaAsset } from '../timeline/assets';

/** Static demo assets immediately, imported relay assets as soon as they load. */
export function useAssetCatalog(): MediaAsset[] {
  const [assets, setAssets] = useState<MediaAsset[]>(() => allAssets());

  useEffect(() => {
    let cancelled = false;
    refreshAssets()
      .then((next) => {
        if (!cancelled) setAssets(next);
      })
      .catch(() => {
        // The static catalog is still usable while the relay is offline.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return assets;
}
