import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import styles from './Dialogs.module.css';
import {
  clearBrowserStorage,
  deleteSavedProject,
  downloadSavedProject,
  listSavedProjects,
  openProjectFromBrowser,
} from '../../app/actions';
import { setState } from '../../app/editorStore';
import { estimateStorage, type ProjectMeta } from '../../persistence/indexedDb';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface ProjectsDialogProps {
  mode: 'open' | 'manage';
}

/** Saved-projects browser: open/download/delete records stored in IndexedDB. */
export function ProjectsDialog({ mode }: ProjectsDialogProps) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const close = () => setState({ dialog: null });

  const refresh = () => {
    listSavedProjects()
      .then((list) => {
        setProjects(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void estimateStorage().then(setUsage);
  };

  useEffect(refresh, []);

  return (
    <Modal
      title={mode === 'open' ? 'Open Saved Project' : 'Storage & Privacy'}
      onClose={close}
      width={560}
      footer={
        <>
          <button
            className="pf-btn danger"
            onClick={() => {
              if (window.confirm('Delete ALL locally saved projects and autosaves from this browser? This cannot be undone.')) {
                void clearBrowserStorage().then(refresh);
              }
            }}
            disabled={!projects || (projects.length === 0 && !usage)}
            data-testid="clear-storage"
          >
            Clear all local data
          </button>
          <button className="pf-btn" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.info}>
          Projects are stored <strong>only in this browser</strong> on this device — never uploaded.
          Browser data can be erased by clearing site data, private-browsing rules, or browser
          policy, so keep <code>.pixelforge</code> file copies of anything that matters.
        </p>
        {usage ? (
          <p className={styles.note}>
            Storage used by all sites: {formatBytes(usage.usage)} of{' '}
            {formatBytes(usage.quota)} available (browser quota estimate).
          </p>
        ) : null}

        {error ? <p className={styles.error}>{error}</p> : null}

        {projects === null ? (
          <p className={styles.note}>Loading…</p>
        ) : projects.length === 0 ? (
          <p className={styles.note}>No saved projects yet. Use File → Save Project to Browser (Ctrl+S).</p>
        ) : (
          <ul className={styles.projectList} data-testid="project-list">
            {projects.map((p) => (
              <li key={p.id} className={styles.projectRow}>
                <div className={styles.projectMeta}>
                  <span className={styles.projectName} title={p.name}>
                    {p.name}
                  </span>
                  <span className={styles.projectSub}>
                    {p.width}×{p.height} · {p.layerCount} layer{p.layerCount === 1 ? '' : 's'} ·
                    saved {new Date(p.savedAt).toLocaleString()}
                  </span>
                </div>
                <div className={styles.projectActions}>
                  <button
                    className="pf-btn"
                    onClick={() => {
                      close();
                      void openProjectFromBrowser(p.id);
                    }}
                    data-testid={`open-${p.id}`}
                  >
                    Open
                  </button>
                  <button
                    className="pf-btn ghost"
                    onClick={() => void downloadSavedProject(p.id)}
                    title="Download a portable .pixelforge copy"
                  >
                    Download
                  </button>
                  <button
                    className="pf-btn ghost danger"
                    onClick={() => {
                      if (window.confirm(`Delete saved project "${p.name}" from browser storage?`)) {
                        void deleteSavedProject(p.id).then(refresh);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
