import { formatSeconds, useTimelinePlayheadTime } from '@techsquidtv/canvas-timeline';

/** Compact position indicator that mirrors the red playhead on the canvas. */
export function TimelinePlayheadReadout() {
  const time = useTimelinePlayheadTime();
  return (
    <span className="timeline-playhead-readout" title="Posizione corrente del playhead">
      <span className="timeline-playhead-readout-dot" aria-hidden="true" />
      <span className="timeline-playhead-readout-label">PLAYHEAD</span>
      <strong>{formatSeconds(time, 2)}s</strong>
    </span>
  );
}
