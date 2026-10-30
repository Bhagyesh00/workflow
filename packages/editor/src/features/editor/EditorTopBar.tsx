/** Editor header: name, tags, save state, Doctor/History/Settings, activation, save. */
import {
  ArrowLeft,
  Copy,
  Download,
  History,
  Keyboard,
  MoreHorizontal,
  Settings2,
  Stethoscope,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button, IconButton } from '../../components/ui/Button';
import { cx } from '../../components/ui/cx';
import { Dialog } from '../../components/ui/Dialog';
import { Switch } from '../../components/ui/Field';
import { Menu } from '../../components/ui/Menu';
import { Kbd } from '../../components/ui/misc';
import { TagsEditor } from '../../components/workflow/TagsEditor';
import type { DoctorIssue } from '../../lib/doctor';
import { downloadJson, safeFileName } from '../../lib/format';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { SHORTCUTS } from './useEditorShortcuts';

export function EditorTopBar({
  issues,
  saving,
  onSave,
  onToggleActive,
  onDuplicate,
  onDelete,
  activating,
}: {
  issues: DoctorIssue[];
  saving: boolean;
  onSave: () => void;
  onToggleActive: (active: boolean) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  activating: boolean;
}) {
  const meta = useWorkflowStore((s) => s.meta);
  const dirty = useWorkflowStore((s) => s.dirty);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const setName = useWorkflowStore((s) => s.setName);
  const setTags = useWorkflowStore((s) => s.setTags);
  const sidePanel = useUiStore((s) => s.sidePanel);
  const setSidePanel = useUiStore((s) => s.setSidePanel);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [name, setDraftName] = useState(meta.name);
  useEffect(() => setDraftName(meta.name), [meta.name]);

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const exportWorkflow = () => {
    const s = useWorkflowStore.getState();
    downloadJson(`${safeFileName(s.meta.name)}.json`, {
      name: s.meta.name,
      nodes: s.nodes,
      connections: s.connections,
      settings: s.meta.settings,
      pinData: s.pinData,
      stickyNotes: s.stickyNotes,
    });
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <Link
        to="/workflows"
        aria-label="Back to workflows"
        className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-3 hover:text-ink"
      >
        <ArrowLeft size={16} />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <input
          aria-label="Workflow name"
          className="min-w-24 max-w-[40ch] flex-shrink rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-display text-lg font-semibold hover:border-line focus:border-brand focus:outline-none"
          style={{ width: `${Math.max(8, name.length + 2)}ch` }}
          value={name}
          readOnly={readOnly}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (next && next !== meta.name) setName(next);
            else setDraftName(meta.name);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setDraftName(meta.name);
          }}
        />
        <div className="hidden min-w-0 sm:flex">
          <TagsEditor value={meta.tags} onChange={setTags} readOnly={readOnly} />
        </div>
      </div>
      <span className={cx('hidden text-xs md:inline', dirty ? 'text-warn' : 'text-ink-3')} aria-live="polite">
        {saving ? 'Saving…' : dirty ? 'Unsaved changes' : meta.id ? 'Saved' : 'Not saved yet'}
      </span>
      <button
        type="button"
        onClick={() => setSidePanel(sidePanel === 'doctor' ? null : 'doctor')}
        aria-pressed={sidePanel === 'doctor'}
        className={cx(
          'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold',
          sidePanel === 'doctor'
            ? 'bg-brand-soft text-brand'
            : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        )}
        title="Workflow Doctor"
      >
        <Stethoscope size={15} />
        <span className="hidden lg:inline">Doctor</span>
        {errors + warnings > 0 && (
          <span
            className={cx('rounded-full px-1.5 text-2xs font-bold text-white', errors ? 'bg-err' : 'bg-warn')}
          >
            {errors + warnings}
          </span>
        )}
      </button>
      <IconButton
        label="Version history"
        className="max-sm:hidden"
        active={sidePanel === 'versions'}
        onClick={() => setSidePanel(sidePanel === 'versions' ? null : 'versions')}
      >
        <History size={16} />
      </IconButton>
      <IconButton label="Workflow settings" className="max-sm:hidden" onClick={() => setSettingsOpen(true)}>
        <Settings2 size={16} />
      </IconButton>
      <Menu
        trigger={(t) => (
          <IconButton
            label="More actions"
            onClick={t.toggle}
            aria-expanded={t['aria-expanded']}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={16} />
          </IconButton>
        )}
        items={[
          {
            key: 'export',
            label: 'Download as JSON',
            icon: <Download size={14} />,
            onSelect: exportWorkflow,
          },
          {
            key: 'history',
            label: 'Version history',
            icon: <History size={14} />,
            onSelect: () => setSidePanel('versions'),
          },
          {
            key: 'settings',
            label: 'Workflow settings',
            icon: <Settings2 size={14} />,
            onSelect: () => setSettingsOpen(true),
          },
          {
            key: 'shortcuts',
            label: 'Keyboard shortcuts',
            icon: <Keyboard size={14} />,
            hint: '?',
            onSelect: () => useUiStore.getState().setShortcutsOpen(true),
          },
          {
            key: 'duplicate',
            label: 'Duplicate',
            icon: <Copy size={14} />,
            onSelect: onDuplicate,
            disabled: readOnly,
          },
          'separator',
          {
            key: 'delete',
            label: 'Delete workflow',
            icon: <Trash2 size={14} />,
            onSelect: onDelete,
            danger: true,
            disabled: readOnly || !meta.id,
          },
        ]}
      />
      <div className="mx-1 h-6 w-px bg-line" />
      <span className="flex items-center gap-2 text-sm font-semibold text-ink-2">
        <Switch
          label={meta.active ? 'Active: turn off to stop triggers' : 'Inactive: turn on to start triggers'}
          checked={meta.active}
          disabled={readOnly || activating}
          onChange={onToggleActive}
        />
        <span className={cx('max-sm:hidden', meta.active && 'text-ok')} aria-hidden="true">
          {meta.active ? 'Active' : 'Inactive'}
        </span>
      </span>
      <Button
        variant={dirty || !meta.id ? 'primary' : 'secondary'}
        onClick={onSave}
        loading={saving}
        disabled={readOnly || (!dirty && Boolean(meta.id))}
      >
        {dirty || !meta.id ? 'Save' : 'Saved'}
      </Button>
    </header>
  );
}

export function ShortcutsDialog() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" size="sm">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.label} className="contents">
            <dt className="text-ink-2">{shortcut.label}</dt>
            <dd className="flex justify-end gap-1">
              {shortcut.keys.split(' ').map((key) => (
                <Kbd key={key}>{key === 'Ctrl' && /Mac/i.test(navigator.platform) ? '⌘' : key}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
