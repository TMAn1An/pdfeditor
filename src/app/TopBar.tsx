import { useState } from 'react';
import { CheckCircle2, CircleAlert, Cloud, Download, Eye, FileDown, FolderOpen, Loader2, Redo2, Save, Shield, Type as TypeIcon, Undo2, X } from 'lucide-react';
import { useWorkspace, type Step } from './workspace';

interface TopBarProps {
  onExportProject: () => void;
  onOpenFonts: () => void;
  onOpenStorage: () => void;
  onClose: () => void;
}

const STEPS: { id: Step; label: string }[] = [
  { id: 'design', label: '1 Design' },
  { id: 'data', label: '2 Data' },
  { id: 'images', label: '3 Images' },
  { id: 'preview', label: '4 Preview & export' },
];

export function TopBar({ onExportProject, onOpenFonts, onOpenStorage, onClose }: TopBarProps) {
  const ws = useWorkspace();
  const project = ws.project!;
  const [editingName, setEditingName] = useState(false);
  const s = ws.saveState;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close project and go to start screen" title="Close project">
          <X size={18} />
        </button>
        {editingName ? (
          <input
            className="name-input"
            autoFocus
            aria-label="Project name"
            defaultValue={project.name}
            maxLength={200}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== project.name) ws.update((p) => ({ ...p, name: v }));
              setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditingName(false);
            }}
          />
        ) : (
          <button type="button" className="project-name" onClick={() => setEditingName(true)} title="Rename project">
            {project.name}
          </button>
        )}
        <span className={`save-status save-${s.status}`} role="status" title={s.message}>
          {s.status === 'saved' && (
            <>
              <CheckCircle2 size={14} aria-hidden /> Saved in this browser
            </>
          )}
          {s.status === 'unsaved' && (
            <>
              <Cloud size={14} aria-hidden /> Unsaved changes
            </>
          )}
          {s.status === 'saving' && (
            <>
              <Loader2 size={14} className="spin" aria-hidden /> Saving…
            </>
          )}
          {s.status === 'error' && (
            <>
              <CircleAlert size={14} aria-hidden /> Not saved
            </>
          )}
        </span>
      </div>

      <nav className="steps" aria-label="Workflow steps">
        {STEPS.map((st) => (
          <button key={st.id} type="button" className={`step${ws.step === st.id ? ' active' : ''}`} aria-current={ws.step === st.id ? 'step' : undefined} onClick={() => ws.setStep(st.id)}>
            {st.label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <button type="button" className="icon-btn" onClick={ws.undo} disabled={!ws.canUndo} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)">
          <Undo2 size={18} />
        </button>
        <button type="button" className="icon-btn" onClick={ws.redo} disabled={!ws.canRedo} aria-label="Redo (Ctrl+Y)" title="Redo (Ctrl+Y)">
          <Redo2 size={18} />
        </button>
        <button type="button" className="icon-btn" onClick={() => void ws.saveNow()} aria-label="Save now (Ctrl+S)" title="Save now in this browser (Ctrl+S)">
          <Save size={18} />
        </button>
        <button type="button" className="icon-btn" onClick={onExportProject} aria-label="Export project file" title="Export project file (.pdftemplate) — includes the PDF, layout and fonts">
          <Download size={18} />
        </button>
        <button type="button" className="icon-btn" onClick={onOpenFonts} aria-label="Fonts" title="Fonts">
          <TypeIcon size={18} />
        </button>
        <button type="button" className="icon-btn" onClick={onOpenStorage} aria-label="Privacy and storage" title="Privacy and storage">
          <Shield size={18} />
        </button>
        <button type="button" className="btn" onClick={() => ws.setStep('preview')}>
          <Eye size={16} /> Preview
        </button>
        <button type="button" className="btn btn-primary" onClick={() => {
            ws.setStep('preview');
            ws.setDialog('export');
          }}>
          <FileDown size={16} /> Export
        </button>
      </div>
      {s.status === 'error' && (
        <div className="save-error" role="alert">
          <CircleAlert size={16} aria-hidden /> {s.message}{' '}
          <button type="button" className="link-btn" onClick={onExportProject}>
            <FolderOpen size={14} aria-hidden /> Export project file
          </button>
        </div>
      )}
    </header>
  );
}
