/**
 * Editor header: name, tags, save state, Doctor/History/Settings, publishing (status chip, Publish
 * and the publish dialog, Unpublish in the More menu; P3-10), archive, save.
 */
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  CloudOff,
  Copy,
  Download,
  FlaskConical,
  History,
  Keyboard,
  Link2,
  MoreHorizontal,
  Rocket,
  Settings2,
  Sparkles,
  Stethoscope,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAiBuilderFeature, useMe } from '../../api/queries';
import type { PublishBody } from '../../api/types';
import { Button, IconButton } from '../../components/ui/Button';
import { cx } from '../../components/ui/cx';
import { Dialog } from '../../components/ui/Dialog';
import { Menu } from '../../components/ui/Menu';
import { Badge, Kbd } from '../../components/ui/misc';
import { TagsEditor } from '../../components/workflow/TagsEditor';
import type { DoctorIssue } from '../../lib/doctor';
import { useBuilderStore } from '../../stores/builder-store';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { AutosaveStatus } from './AutosaveStatus';
import { PublishDialog } from './PublishDialog';
import { PUBLISH_STATE_LABEL, publishStateOf, requestPublish } from './publish-actions';
import { SHORTCUTS } from './useEditorShortcuts';
import { downloadWorkflow } from './workflow-commands';

export function EditorTopBar({
  issues,
  saving,
  onSave,
  onPublish,
  onUnpublish,
  onDuplicate,
  onArchive,
  onUnarchive,
  onDelete,
  activating,
}: {
  issues: DoctorIssue[];
  saving: boolean;
  onSave: () => void;
  /** P3-10: the publish dialog's choice (the Publish button opens the dialog after the review gate) */
  onPublish: (body: PublishBody) => void;
  onUnpublish: () => void;
  onDuplicate: () => void;
  /** P3-07 */
  onArchive: () => void;
  onUnarchive: () => void;
  /** archived workflows only (P3-07) */
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
  const renameRequested = useUiStore((s) => s.workflowRenameRequested);
  const tagsRequested = useUiStore((s) => s.tagsEditRequested);
  // archive / restore / delete follow the role, not the archived read-only state
  const canWrite = useMe().data?.role !== 'viewer';
  const aiBuilder = useAiBuilderFeature();
  const [name, setDraftName] = useState(meta.name);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraftName(meta.name), [meta.name]);
  // command bar "Rename": focus the name field
  useEffect(() => {
    if (!renameRequested) return;
    useUiStore.getState().setWorkflowRenameRequested(false);
    if (readOnly) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [renameRequested, readOnly]);
  // command bar "Add tag": the tags editor opens once per request
  useEffect(() => {
    if (tagsRequested) useUiStore.getState().setTagsEditRequested(false);
  }, [tagsRequested]);

  const publishState = publishStateOf(meta, dirty);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

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
          ref={nameRef}
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
          <TagsEditor value={meta.tags} onChange={setTags} readOnly={readOnly} autoOpen={tagsRequested} />
        </div>
        {/* P5-11: the workflow's test runs; an unsaved workflow has none */}
        {meta.id ? (
          <Link
            to={`/workflow/${encodeURIComponent(meta.id)}/evaluations`}
            aria-label="Evaluations"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-ink-2 hover:bg-surface-3 hover:text-ink"
          >
            <FlaskConical size={15} />
            <span className="hidden lg:inline">Evaluations</span>
          </Link>
        ) : (
          <button
            type="button"
            disabled
            aria-label="Evaluations"
            title="Save the workflow to run evaluations"
            className="inline-flex h-8 shrink-0 cursor-not-allowed items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-ink-3 opacity-60"
          >
            <FlaskConical size={15} />
            <span className="hidden lg:inline">Evaluations</span>
          </button>
        )}
        {/* P5-09: the AI builder's panel; editors and above, when the builder is on */}
        {aiBuilder.enabled && canWrite && !readOnly && (
          <button
            type="button"
            onClick={() => useBuilderStore.getState().setOpen(sidePanel !== 'builder')}
            aria-pressed={sidePanel === 'builder'}
            aria-label="Build with AI"
            className={cx(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold',
              sidePanel === 'builder'
                ? 'bg-brand-soft text-brand'
                : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
            )}
          >
            <Sparkles size={15} />
            <span className="hidden lg:inline">Build with AI</span>
          </button>
        )}
      </div>
      <span className={cx('hidden text-xs md:inline', dirty ? 'text-warn' : 'text-ink-3')} aria-live="polite">
        {saving ? 'Saving…' : dirty ? 'Unsaved changes' : meta.id ? 'Saved' : 'Not saved yet'}
      </span>
      <AutosaveStatus />
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
            onSelect: downloadWorkflow,
          },
          {
            key: 'import-url',
            label: 'Import from URL',
            icon: <Link2 size={14} />,
            onSelect: () => useUiStore.getState().setImportUrlOpen(true),
            disabled: readOnly,
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
          ...(meta.publishedVersionId
            ? [
                {
                  key: 'unpublish',
                  label: 'Unpublish',
                  icon: <CloudOff size={14} />,
                  onSelect: onUnpublish,
                  disabled: readOnly || activating,
                },
              ]
            : []),
          ...(meta.isArchived
            ? [
                {
                  key: 'unarchive',
                  label: 'Restore',
                  icon: <ArchiveRestore size={14} />,
                  onSelect: onUnarchive,
                  disabled: !canWrite,
                },
                {
                  key: 'delete',
                  label: 'Delete',
                  icon: <Trash2 size={14} />,
                  onSelect: onDelete,
                  danger: true,
                  disabled: !canWrite,
                },
              ]
            : [
                {
                  key: 'archive',
                  label: 'Archive',
                  icon: <Archive size={14} />,
                  onSelect: onArchive,
                  danger: true,
                  disabled: readOnly || !meta.id,
                },
              ]),
        ]}
      />
      <div className="mx-1 h-6 w-px bg-line" />
      <span role="status" aria-label={`Publish status: ${PUBLISH_STATE_LABEL[publishState]}`}>
        <Badge
          tone={publishState === 'published' ? 'ok' : publishState === 'changed' ? 'warn' : 'neutral'}
          className="max-md:hidden"
        >
          {PUBLISH_STATE_LABEL[publishState]}
        </Badge>
      </span>
      <Button
        icon={<Rocket size={14} />}
        onClick={() => void requestPublish()}
        loading={activating}
        disabled={readOnly || activating || publishState === 'published'}
        title={publishState === 'published' ? 'This version is already published' : undefined}
      >
        Publish
      </Button>
      <PublishDialog onPublish={onPublish} />
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
