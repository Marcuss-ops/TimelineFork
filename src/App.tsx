import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CanvasRenderer,
  Timeline,
  TimelineProvider,
  useTimeline,
} from '@techsquidtv/canvas-timeline';
import { PreviewMonitor } from './components/PreviewMonitor';
import { TimelinePlayheadReadout } from './components/TimelinePlayheadReadout';
import { Transport } from './components/Transport';
import {
  isLiveSnapshot,
  useLivePublisher,
  type LiveSnapshot,
} from './live/useLivePublisher';
import { useLiveProjectStream } from './live/useLiveProjectStream';
import { useAssetCatalog } from './live/useAssetCatalog';
import { Home } from './Home';
import type { TimelineDocument } from './timeline/document';
import type { MediaAsset } from './timeline/assets';
import { documentFromState, createEngine, validateTimeline } from './timeline/project';

function downloadJSON(json: string, filename: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface EditorShellProps {
  projectId: string;
  onHome: () => void;
  project: TimelineDocument;
  assets: MediaAsset[];
  title: string;
  onTitleChange: (title: string) => void;
  error: string | null;
  onError: (message: string | null) => void;
  onRemoteSnapshot: (snapshot: LiveSnapshot) => void;
}

function EditorShell({
  projectId,
  onHome,
  project,
  assets,
  title,
  onTitleChange,
  error,
  onError,
  onRemoteSnapshot,
}: EditorShellProps) {
  const { state } = useTimeline();
  const live = useLivePublisher(state, project, title, projectId);

  useLiveProjectStream({ projectId, project, state, title, onSnapshot: onRemoteSnapshot });
  const titleEditing = useRef(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);

  function handleExport() {
    const timeline = documentFromState(state, project);
    const errors = validateTimeline(timeline);
    if (errors.length > 0) {
      onError(`Export: ${errors[0]}`);
      return;
    }
    onError(null);
    downloadJSON(JSON.stringify(timeline, null, 2), `timeline-r${timeline.revision}.json`);
  }

  function beginTitleEdit() {
    titleEditing.current = true;
    setTitleDraft(title);
    setEditingTitle(true);
  }

  function commitTitle() {
    if (!titleEditing.current) return;
    titleEditing.current = false;
    const nextTitle = titleDraft.trim();
    setEditingTitle(false);
    setTitleDraft(title);
    if (nextTitle.length === 0 || nextTitle === title) return;
    onTitleChange(nextTitle);
  }

  function cancelTitleEdit() {
    if (!titleEditing.current) return;
    titleEditing.current = false;
    setEditingTitle(false);
    setTitleDraft(title);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button
            type="button"
            className="brand-button"
            onClick={onHome}
            title="Torna ai progetti"
            aria-label="Torna ai progetti"
          >
            <span className="brand-mark">V</span>
          </button>
          <span className="brand-text">
            {editingTitle ? (
              <input
                className="brand-title-input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitTitle();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelTitleEdit();
                  }
                }}
                onFocus={(event) => event.currentTarget.select()}
                maxLength={120}
                aria-label="Titolo del progetto"
                autoFocus
              />
            ) : (
              <button
                type="button"
                className="brand-title"
                onClick={beginTitleEdit}
                title="Clicca per rinominare il progetto"
              >
                <strong>{title}</strong>
              </button>
            )}
            <span>Velox Timeline Studio · rev {project.revision}</span>
          </span>
        </div>
        <div className="topbar-actions">
          {live.status === 'conflict' ? (
            <button
              type="button"
              className="button ghost"
              onClick={() => window.location.reload()}
              title="Un'altra sessione ha pubblicato una revisione più recente"
            >
              Ricarica
            </button>
          ) : null}
          <button type="button" className="button primary" onClick={handleExport}>
            Esporta timeline
          </button>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}

      <main className="workspace">
        <section className="monitor-column">
          <PreviewMonitor
            assets={assets}
            timeline={project}
            title={project.revision > 0 ? 'Montaggio corrente' : 'Timeline'}
          />
          <Transport durationUS={project.duration_us} />
        </section>
      </main>

      <section className="timeline-panel">
        <div className="timeline-toolbar">
          <span className="section-label">Timeline</span>
          <div className="timeline-legend" aria-label="Tracce della timeline">
            <span className="timeline-legend-item">
              <span className="legend-dot video" /> V1 video
            </span>
            <span className="timeline-legend-item">
              <span className="legend-dot" style={{ background: '#3f8f7a' }} /> A0 clip audio
            </span>
            <span className="timeline-legend-item">
              <span className="legend-dot overlay" /> V2 overlay
            </span>
            <span className="timeline-legend-item">
              <span className="legend-dot voice" /> A1 voce
            </span>
            <span className="timeline-legend-item">
              <span className="legend-dot music" /> A2 musica
            </span>
            <span className="timeline-legend-item">
              <span className="legend-dot sfx" /> A3 sfx
            </span>
          </div>
          <span className="muted timeline-hint">
            drag = sposta · bordi = trim · playhead = anteprima
          </span>
          <TimelinePlayheadReadout />
        </div>
        <div className="timeline-stage">
          <div className="ts-timeline-root">
            <Timeline.Root className="timeline-root">
              <CanvasRenderer />
              <Timeline.PlayheadArea />
              <Timeline.PlayheadGrabber />
              <Timeline.TrackList>
                {state.tracks.map((track) => (
                  <Timeline.Track key={track.id} trackId={track.id} />
                ))}
              </Timeline.TrackList>
              <Timeline.ClipInteractionLayer />
            </Timeline.Root>
          </div>
        </div>
        <div className="timeline-scrollbar-row">
          <Timeline.ViewportScrollbar>
            <Timeline.ViewportScrollbarThumb>
              <Timeline.ViewportScrollbarHandle side="start" />
              <Timeline.ViewportScrollbarHandle side="end" />
            </Timeline.ViewportScrollbarThumb>
          </Timeline.ViewportScrollbar>
        </div>
      </section>
    </div>
  );
}

function Editor({ projectId, onHome }: { projectId: string; onHome: () => void }) {
  const [project, setProject] = useState<TimelineDocument | null>(null);
  const [projectTitle, setProjectTitle] = useState('Progetto Velox');
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const applyRemoteSnapshot = useCallback((snapshot: LiveSnapshot) => {
    setProject((current) => {
      if (!current || snapshot.timeline.revision <= current.revision) return current;
      return snapshot.timeline;
    });
    setProjectTitle(snapshot.title);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404) throw new Error('Questo progetto non esiste più sul relay.');
        if (!response.ok) throw new Error(`Il relay non risponde (${response.status}).`);
        const data: unknown = await response.json();
        if (!isLiveSnapshot(data)) throw new Error('Lo snapshot del progetto non è valido.');
        return data;
      })
      .then((snapshot) => {
        if (cancelled) return;
        setProjectTitle(snapshot.title);
        setProject(snapshot.timeline);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Impossibile aprire il progetto.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const assets = useAssetCatalog(project?.revision);
  const engine = useMemo(
    () => (project ? createEngine(project, assets) : null),
    [project, assets],
  );

  if (loadError) {
    return (
      <div className="waiting-screen">
        <div className="waiting-card">
          <span className="brand-mark">V</span>
          <h1>Progetto non disponibile</h1>
          <p>{loadError}</p>
          <div className="waiting-actions">
            <button type="button" className="button primary" onClick={onHome}>
              Torna ai progetti
            </button>
            <button type="button" className="button ghost" onClick={() => window.location.reload()}>
              Riprova
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!project || !engine) {
    return (
      <div className="waiting-screen">
        <div className="waiting-card">
          <h1>Carico il progetto…</h1>
          <p>Leggo la revisione dal relay.</p>
        </div>
      </div>
    );
  }

  return (
    <TimelineProvider
      key={`${projectId}:${project.revision}:${project.duration_us}:${assets.length}`}
      engine={engine}
    >
      <EditorShell
        projectId={projectId}
        onHome={onHome}
        project={project}
        assets={assets}
        title={projectTitle}
        onTitleChange={setProjectTitle}
        error={documentError}
        onError={setDocumentError}
        onRemoteSnapshot={applyRemoteSnapshot}
      />
    </TimelineProvider>
  );
}

type AppRoute = { view: 'home' } | { view: 'editor'; projectId: string };

function readRoute(): AppRoute {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project')?.trim();
  if (projectId) return { view: 'editor', projectId };
  return { view: 'home' };
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(readRoute);

  useEffect(() => {
    const handlePopState = () => setRoute(readRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function goHome() {
    const url = new URL(window.location.href);
    url.search = '';
    window.history.pushState({}, '', url.toString());
    setRoute({ view: 'home' });
  }

  function openProject(projectId: string) {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('project', projectId);
    window.history.pushState({}, '', url.toString());
    setRoute({ view: 'editor', projectId });
  }

  if (route.view === 'editor') {
    return <Editor key={route.projectId} projectId={route.projectId} onHome={goHome} />;
  }
  return <Home onOpenProject={openProject} />;
}
