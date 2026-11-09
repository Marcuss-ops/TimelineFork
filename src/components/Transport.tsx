import { useEffect, useRef } from 'react';
import {
  formatSeconds,
  useTimelinePlayback,
  useTimelinePlayheadTime,
} from '@techsquidtv/canvas-timeline';

interface TransportProps {
  durationUS: number;
}

export function Transport({ durationUS }: TransportProps) {
  const time = useTimelinePlayheadTime();
  const playback = useTimelinePlayback();
  const playbackRef = useRef(playback);

  useEffect(() => {
    playbackRef.current = playback;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        playbackRef.current.togglePlayback();
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        playbackRef.current.stepForward(1 / 30);
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        playbackRef.current.stepBackward(1 / 30);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const atEnd = Math.abs(time.v / time.r - durationUS / 1_000_000) < 0.001;

  return (
    <div className="transport">
      <div className="transport-buttons">
        <button
          type="button"
          className="icon-button"
          onClick={() => playback.setPlayheadTime({ v: 0, r: 1_000_000 })}
          aria-label="Torna all'inizio"
          title="Inizio"
        >
          ⏮
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => playback.stepBackward(1 / 30)}
          aria-label="Indietro di un frame"
          title="Frame precedente"
        >
          ◀
        </button>
        <button
          type="button"
          className="play-button"
          onClick={() => playback.togglePlayback()}
          aria-label={playback.playing ? 'Pausa' : 'Riproduci'}
        >
          {playback.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => playback.stepForward(1 / 30)}
          aria-label="Avanti di un frame"
          title="Frame successivo"
        >
          ▶
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => playback.setPlayheadTime({ v: durationUS, r: 1_000_000 })}
          aria-label="Vai alla fine"
          title="Fine"
          disabled={atEnd}
        >
          ⏭
        </button>
      </div>
      <div className="transport-time">
        <span className="mono">{formatSeconds(time, 2)}</span>
        <span className="transport-sep">/</span>
        <span className="mono muted">{(durationUS / 1_000_000).toFixed(2)}s</span>
      </div>
      <div className="transport-hint">SPAZIO play · ← → frame</div>
    </div>
  );
}
