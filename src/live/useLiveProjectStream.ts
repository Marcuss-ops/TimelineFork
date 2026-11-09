import { useEffect, useRef } from 'react';
import type { TimelineStateSnapshot } from '@techsquidtv/canvas-timeline';
import type { TimelineDocument } from '../timeline/document';
import { documentFromState } from '../timeline/project';
import {
  editorialSignature,
  isLiveSnapshot,
  type LiveSnapshot,
} from './useLivePublisher';

interface LiveProjectStreamOptions {
  projectId: string;
  project: TimelineDocument;
  state: TimelineStateSnapshot;
  title: string;
  onSnapshot: (snapshot: LiveSnapshot) => void;
}

/**
 * Keeps the editor aligned with the relay without a page reload. Every
 * published snapshot arrives over SSE; snapshots with the same editorial
 * content are our own echo and must not remount the canvas.
 */
export function useLiveProjectStream({
  projectId,
  project,
  state,
  title,
  onSnapshot,
}: LiveProjectStreamOptions): void {
  const projectRef = useRef(project);
  const stateRef = useRef(state);
  const titleRef = useRef(title);
  const onSnapshotRef = useRef(onSnapshot);
  const appliedRevisionRef = useRef(project.revision);

  useEffect(() => {
    projectRef.current = project;
    appliedRevisionRef.current = Math.max(appliedRevisionRef.current, project.revision);
    stateRef.current = state;
    titleRef.current = title;
    onSnapshotRef.current = onSnapshot;
  }, [project, state, title, onSnapshot]);

  useEffect(() => {
    const applySnapshot = (incoming: unknown) => {
      if (!isLiveSnapshot(incoming) || incoming.project_id !== projectId) return;
      if (incoming.timeline.revision <= appliedRevisionRef.current) return;

      const local = documentFromState(stateRef.current, projectRef.current);
      const sameContent =
        editorialSignature(incoming.timeline) === editorialSignature(local);
      const sameTitle = incoming.title === titleRef.current;
      appliedRevisionRef.current = incoming.timeline.revision;
      if (sameContent && sameTitle) return;

      onSnapshotRef.current(incoming);
    };

    let source: EventSource | undefined;
    if (typeof EventSource !== 'undefined') {
      source = new EventSource('/api/events');
      source.onmessage = (event) => {
        let incoming: unknown;
        try {
          incoming = JSON.parse(event.data);
        } catch {
          return;
        }
        applySnapshot(incoming);
      };
    }

    // Cloudflare quick tunnels and some reverse proxies buffer SSE bodies.
    // Polling is a fallback so a remote revision still appears without a
    // manual page reload; EventSource remains the low-latency path when it works.
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}?poll=${Date.now()}`,
          { cache: 'no-store' },
        );
        if (!response.ok) return;
        applySnapshot(await response.json());
      } catch {
        // The relay may be temporarily unavailable; the next tick retries.
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 2000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    const handleFocus = () => {
      void poll();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pageshow', handleFocus);

    return () => {
      source?.close();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handleFocus);
    };
  }, [projectId]);
}
