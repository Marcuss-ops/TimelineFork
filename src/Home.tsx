import { useEffect, useState } from 'react';
import { useAssetCatalog } from './live/useAssetCatalog';
import type { MediaAsset } from './timeline/assets';

interface ProjectSummary {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  duration_us: number;
  frame_rate?: { numerator: number; denominator: number };
  video_segments: number;
  overlay_count?: number;
  preview_asset_id?: string | null;
  clips: number;
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.id === 'string' &&
    typeof project.title === 'string' &&
    typeof project.revision === 'number' &&
    typeof project.updatedAt === 'string' &&
    typeof project.duration_us === 'number' &&
    typeof project.video_segments === 'number' &&
    typeof project.clips === 'number'
  );
}

const dateFormatter = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatUpdated(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

function formatDuration(durationUS: number): string {
  return `${(durationUS / 1_000_000).toFixed(1)}s`;
}

function ProjectCard({
  project,
  index,
  active,
  onOpen,
  assets,
}: {
  project: ProjectSummary;
  index: number;
  active: boolean;
  onOpen: (id: string) => void;
  assets: MediaAsset[];
}) {
  const segments = Math.max(1, Math.min(5, project.video_segments));
  const posterUrl = project.preview_asset_id
    ? assets.find((asset) => asset.id === project.preview_asset_id)?.posterUrl
    : undefined;

  return (
    <button
      type="button"
      className={`project-card tone-${index % 4}`}
      onClick={() => onOpen(project.id)}
      aria-label={`Apri il progetto ${project.title}`}
    >
      <span
        className={`project-preview ${posterUrl ? 'has-poster' : ''}`}
        style={
          posterUrl
            ? {
                backgroundImage: `linear-gradient(180deg, rgba(4, 6, 10, 0.06) 10%, rgba(4, 6, 10, 0.78) 100%), url("${posterUrl}")`,
              }
            : undefined
        }
      >
        <span className="project-index">{String(index + 1).padStart(2, '0')}</span>
        {active ? <span className="project-live-badge">LIVE</span> : null}
        {posterUrl ? null : (
          <span className="project-preview-bars" aria-hidden="true">
            {Array.from({ length: segments }, (_, segmentIndex) => (
              <span key={segmentIndex} />
            ))}
          </span>
        )}
        <span className="project-preview-caption">
          <span>V1{(project.overlay_count ?? 0) > 0 ? ' + V2' : ''}</span>
          <span>{formatDuration(project.duration_us)}</span>
        </span>
      </span>
      <span className="project-card-body">
        <strong className="project-title">{project.title}</strong>
        <span className="project-meta">
          <span>rev {project.revision}</span>
          <span>{project.clips} clip</span>
          <span>{project.video_segments} video</span>
          {(project.overlay_count ?? 0) > 0 ? <span>{project.overlay_count} overlay</span> : null}
        </span>          <span className="project-footer">
          <span>{formatUpdated(project.updatedAt)}</span>
          <span className="project-open">Apri ↗</span>
        </span>
      </span>
    </button>
  );
}

export function Home({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const assets = useAssetCatalog();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [projectsResponse, activeResponse] = await Promise.all([
          fetch('/api/projects', { cache: 'no-store' }),
          fetch('/api/timeline', { cache: 'no-store' }),
        ]);
        if (!projectsResponse.ok) {
          throw new Error(`Il relay non risponde (${projectsResponse.status}).`);
        }
        const data: unknown = await projectsResponse.json();
        const list =
          typeof data === 'object' &&
          data !== null &&
          Array.isArray((data as { projects?: unknown }).projects)
            ? (data as { projects: unknown[] }).projects.filter(isProjectSummary)
            : [];
        if (activeResponse.ok && activeResponse.status !== 204) {
          try {
            const active: unknown = await activeResponse.json();
            if (
              typeof active === 'object' &&
              active !== null &&
              typeof (active as { project_id?: unknown }).project_id === 'string'
            ) {
              if (!cancelled) setActiveId((active as { project_id: string }).project_id);
            }
          } catch {
            // The live badge is optional; an empty feed must not hide the library.
          }
        }
        if (!cancelled) {
          setProjects(list);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Impossibile caricare i progetti.',
          );
          setProjects([]);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeProject = projects?.find((project) => project.id === activeId) ?? null;
  const activePoster = activeProject?.preview_asset_id
    ? assets.find((asset) => asset.id === activeProject.preview_asset_id)?.posterUrl
    : undefined;

  return (
    <div className="home-shell">
      <header className="home-topbar">
        <div className="brand">
          <span className="brand-mark">V</span>
          <div className="brand-text">
            <strong>Velox</strong>
            <span>timeline studio</span>
          </div>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <div className="home-hero-copy">
            <span className="home-eyebrow">VELOX / PROJECT LIBRARY</span>
            <h1>Progetti</h1>
          </div>
          {activeProject ? (
            <button
              type="button"
              className={`home-featured ${activePoster ? 'has-poster' : ''}`}
              style={
                activePoster
                  ? {
                      backgroundImage: `linear-gradient(180deg, rgba(7, 7, 7, 0.04) 20%, rgba(7, 7, 7, 0.9) 100%), url("${activePoster}")`,
                    }
                  : undefined
              }
              onClick={() => onOpenProject(activeProject.id)}
              aria-label={`Apri il progetto ${activeProject.title}`}
            >
              <span className="home-featured-kicker">
                <span className="home-featured-dot" /> PROGETTO ATTIVO
              </span>
              <strong className="home-featured-title">{activeProject.title}</strong>
              <span className="home-featured-meta">
                rev {activeProject.revision} · {formatDuration(activeProject.duration_us)} ·{' '}
                {activeProject.clips} clip
              </span>
              <span className="home-featured-open">Apri progetto ↗</span>
            </button>
          ) : (
            <aside className="home-hero-aside">
              <span className="home-eyebrow">PROGETTO ATTIVO</span>
              <strong>Nessun progetto attivo</strong>
              <span className="home-live-hint">Apri un progetto per iniziare.</span>
            </aside>
          )}
        </section>

        {error ? <div className="home-error">{error}</div> : null}

        <section className="home-library" aria-labelledby="home-library-title">
          <div className="home-library-heading">
            <h2 id="home-library-title">Lavori</h2>
            <span>{projects === null ? 'Caricamento…' : `${projects.length} progetti`}</span>
          </div>

          {projects === null ? (
            <div className="project-grid" aria-hidden="true">
              {[0, 1, 2].map((item) => (
                <div key={item} className="project-card project-skeleton">
                  <span className="project-preview" />
                  <span className="project-card-body">
                    <span className="skeleton-line wide" />
                    <span className="skeleton-line" />
                  </span>
                </div>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="home-empty">
              <span className="brand-mark">V</span>
              <h2>Nessun progetto ancora</h2>
              <p>
                Pubblica una timeline dall’MCP o dal relay per farla comparire qui.
              </p>
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  index={index}
                  active={project.id === activeId}
                  onOpen={onOpenProject}
                  assets={assets}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
