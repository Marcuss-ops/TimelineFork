import { useEffect, useRef, useState } from 'react';
import type { TimelineStateSnapshot } from '@techsquidtv/canvas-timeline';
import { timeToUS, type TimelineDocument } from '../timeline/document';
import { documentFromState } from '../timeline/project';
import { relayAuthHeaders } from './relayAuth';

export type LiveStatus = 'idle' | 'publishing' | 'offline' | 'conflict';

export interface LivePayload {
  project_id?: string;
  title: string;
  timeline: TimelineDocument;
  playhead_us: number;
  updatedAt: string;
  /** Base revision the writer read before creating timeline.revision + 1. */
  expected_revision?: number;
}

export interface LiveSnapshot extends LivePayload {}

export function isLiveSnapshot(value: unknown): value is LiveSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const timeline = candidate.timeline;
  return (
    (candidate.project_id === undefined || typeof candidate.project_id === 'string') &&
    typeof candidate.title === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.playhead_us === 'number' &&
    typeof timeline === 'object' &&
    timeline !== null &&
    Array.isArray((timeline as { segments?: unknown }).segments)
  );
}

/** Revision and selection are not editorial content: ignore them when deciding whether to save. */
function editorialSignature(document: TimelineDocument): string {
  return JSON.stringify({
    frame_rate: document.frame_rate,
    duration_us: document.duration_us,
    segments: document.segments,
    overlays: document.overlays ?? [],
    voiceovers: document.voiceovers,
    music: document.music,
    sfx: document.sfx,
  });
}

/**
 * The relay is only a fan-out pipe: no editing, no rendering, no media.
 * Publishing is keyed by contentRevision so playback does not spam the room.
 *
 * The writer sends expected_revision so a newer MCP edit is never silently
 * overwritten. A 409 is surfaced as CONFLICT and the local view stays intact.
 */
export function useLivePublisher(
  state: TimelineStateSnapshot,
  project: TimelineDocument,
  title: string,
  projectId: string,
): { status: LiveStatus; lastPublished: string | null } {
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [lastPublished, setLastPublished] = useState<string | null>(null);

  const scheduledRevision = useRef<number | null>(state.contentRevision);
  const publishedRevision = useRef<number>(project.revision);
  const publishedSignature = useRef<string>(editorialSignature(project));
  const publishedTitle = useRef<string>(title);
  const observedTitle = useRef<string>(title);
  const projectRef = useRef(project);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (projectRef.current === project) return;
    projectRef.current = project;
    publishedRevision.current = project.revision;
    publishedSignature.current = editorialSignature(project);
    publishedTitle.current = title;
    observedTitle.current = title;
  }, [project, title]);

  useEffect(() => {
    const titleChanged = observedTitle.current !== title;
    if (!titleChanged && scheduledRevision.current === state.contentRevision) return;
    observedTitle.current = title;
    scheduledRevision.current = state.contentRevision;

    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const expectedRevision = publishedRevision.current;
      const timeline = documentFromState(state, project);
      timeline.revision = expectedRevision + 1;
      // Hydration and playhead moves bump contentRevision but must not rewrite
      // the relay. Compare with the last published snapshot, not the original
      // project, so undoing an edit is published too.
      const signature = editorialSignature(timeline);
      if (title === publishedTitle.current && signature === publishedSignature.current) return;
      const payload: LivePayload = {
        project_id: projectId,
        title,
        timeline,
        playhead_us: timeToUS(state.playheadTime),
        updatedAt: new Date().toISOString(),
        expected_revision: expectedRevision,
      };
      fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...relayAuthHeaders() },
        body: JSON.stringify(payload),
      })
        .then((response) => {
          if (response.status === 409) {
            setStatus('conflict');
            return;
          }
          if (!response.ok) throw new Error(`relay ${response.status}`);
          publishedRevision.current = timeline.revision;
          publishedSignature.current = signature;
          publishedTitle.current = title;
          setStatus('publishing');
          setLastPublished(new Date().toLocaleTimeString());
        })
        .catch(() => setStatus('offline'));
    }, 350);
  }, [state, project, title, projectId]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { status, lastPublished };
}
