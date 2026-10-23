import { useEffect } from 'react';
import styles from './App.module.css';
import { TopBar } from '../components/TopBar/TopBar';
import { OptionsBar } from '../components/OptionsBar/OptionsBar';
import { Toolbar } from '../components/Toolbar/Toolbar';
import { CanvasWorkspace } from '../components/CanvasWorkspace/CanvasWorkspace';
import { RightPanel } from '../components/RightPanel/RightPanel';
import { StatusBar } from '../components/StatusBar/StatusBar';
import { ToastStack } from '../components/ToastStack';
import { ExportDialog } from '../components/dialogs/ExportDialog';
import { FeatherDialog } from '../components/dialogs/FeatherDialog';
import { ImageSizeDialog } from '../components/dialogs/ImageSizeDialog';
import { AboutDialog, ShortcutsDialog } from '../components/dialogs/InfoDialogs';
import { ProjectsDialog } from '../components/dialogs/ProjectsDialog';
import { discardAutosave, loadInspectorPrefs, peekAutosave, recoverAutosave } from './actions';
import { bindShortcuts } from './shortcuts';
import { setState, useEditorStore } from './editorStore';

function RecoveryBar() {
  const recovery = useEditorStore((s) => s.recovery);
  if (!recovery) return null;
  return (
    <div className={styles.recovery} role="alert">
      <span className={styles.recoveryText}>
        Unsaved session found — <strong>{recovery.name}</strong>, autosaved{' '}
        {new Date(recovery.savedAt).toLocaleString()}.
      </span>
      <button
        className="pf-btn primary"
        data-testid="recover-session"
        onClick={() => {
          void recoverAutosave().then(() => setState({ recovery: null }));
        }}
      >
        Recover
      </button>
      <button
        className="pf-btn ghost"
        onClick={() => {
          void discardAutosave();
          setState({ recovery: null });
        }}
      >
        Discard
      </button>
    </div>
  );
}

export default function App() {
  const dialog = useEditorStore((s) => s.dialog);

  useEffect(() => {
    const unbind = bindShortcuts();
    loadInspectorPrefs();
    // The inspector detaches into an overlay on narrow screens
    // (App.module.css), where it would cover the document on every load. Close
    // it for this session only — deliberately *not* via setInspectorOpen,
    // which would persist the choice and surprise the user on desktop later.
    if (window.matchMedia('(max-width: 900px)').matches) setState({ inspectorOpen: false });
    void peekAutosave().then((r) => {
      if (r) setState({ recovery: r });
    });
    // Tell the static loading overlay (editor.astro) that React is live so it
    // can complete its progress bar and animate away.
    document.documentElement.setAttribute('data-pf-app-ready', '');
    window.dispatchEvent(new Event('pf-app-ready'));
    return unbind;
  }, []);

  return (
    <div className={styles.app}>
      <TopBar />
      <OptionsBar />
      <RecoveryBar />
      <div className={styles.main}>
        <Toolbar />
        <CanvasWorkspace />
        <RightPanel />
      </div>
      <StatusBar />
      <ToastStack />

      {dialog === 'export' ? <ExportDialog /> : null}
      {dialog === 'feather' ? <FeatherDialog /> : null}
      {dialog === 'imageSize' ? <ImageSizeDialog /> : null}
      {dialog === 'shortcuts' ? <ShortcutsDialog /> : null}
      {dialog === 'about' ? <AboutDialog /> : null}
      {dialog === 'storage' ? <ProjectsDialog mode="manage" /> : null}
      {dialog === 'openProject' ? <ProjectsDialog mode="open" /> : null}
    </div>
  );
}
