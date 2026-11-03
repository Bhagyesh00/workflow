/**
 * A canvas group (P3-04): expanded, a dashed frame around its members with a title bar; collapsed
 * (the default), one 400-wide card that takes the members' outside cables. The title bar renames
 * inline, edits and pins the description, collapses or expands, and ungroups; dragging it moves
 * every member (FlowCanvas turns the drag into member moves). Right-click opens the group menu.
 */
import { GROUP_DESCRIPTION_MAX_LENGTH } from '@workflow/workflow';
import { Handle, type NodeProps, Position, useStore } from '@xyflow/react';
import { ChevronDown, ChevronRight, Info, PencilLine, Ungroup } from 'lucide-react';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { plural } from '../../lib/format';
import { showsGroupDescription } from '../../lib/group-layout-push';
import { setGroupDescriptionPinned, setGroupsExpanded } from '../../lib/group-view';
import { consumeGroupRenameRequest } from '../../lib/node-groups';
import { useWorkflowStore } from '../../stores/workflow-store';
import { cx } from '../ui/cx';
import { GROUP_DRAG_HANDLE, GROUP_IN_HANDLE, GROUP_OUT_HANDLE, type GroupFlowNode } from './flow-elements';

function TitleButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="nodrag grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
    >
      {children}
    </button>
  );
}

/** inline text editor for the name or the description: Enter saves, Escape cancels, blur saves */
function InlineEdit({
  label,
  initial,
  maxLength,
  multiline,
  onDone,
}: {
  label: string;
  initial: string;
  maxLength: number;
  multiline?: boolean;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  const common = {
    'aria-label': label,
    autoFocus: true,
    maxLength,
    value,
    onFocus: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      event.currentTarget.select(),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(event.target.value),
    onBlur: () => finish(value),
    onKeyDown: (event: React.KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finish(value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    },
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    className:
      'nodrag nopan w-full min-w-0 rounded-md border border-brand-line bg-surface px-1.5 py-0.5 text-sm text-ink outline-none focus:border-brand',
  };
  if (!multiline) return <input type="text" {...common} />;
  return (
    <div className="nodrag flex flex-col gap-0.5">
      <textarea rows={3} {...common} className={cx(common.className, 'resize-none text-xs')} />
      <span className="self-end text-[11px] text-ink-3" aria-live="polite">
        {value.length}/{maxLength}
      </span>
    </div>
  );
}

/** the frame lets pointer events through to the canvas; its title bar and texts take them back */
const interactive = { pointerEvents: 'auto' } as const;

export const GroupNode = memo(function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  const { group, collapsed, memberCount, readOnly, descriptionPinned } = data;
  const zoom = useStore((s) => s.transform[2]);
  const [editing, setEditing] = useState<'name' | 'description' | null>(null);

  // a group just made with Ctrl+G or the toolbar opens expanded with its title ready to rename
  useEffect(() => {
    if (readOnly || !consumeGroupRenameRequest(group.id)) return;
    setGroupsExpanded([group.id], true);
    setEditing('name');
  }, [group.id, readOnly]);

  const store = () => useWorkflowStore.getState();
  const hasDescription = Boolean(group.description?.trim());
  const showDescription =
    editing !== 'description' && showsGroupDescription(group.description, descriptionPinned, zoom);
  const toggleLabel = `${collapsed ? 'Expand' : 'Collapse'} group ${group.name}`;

  const titleBar = (
    <div
      className={cx(
        GROUP_DRAG_HANDLE,
        'flex h-9 min-w-0 cursor-grab items-center gap-1 px-1.5 active:cursor-grabbing',
        !collapsed && 'rounded-t-[14px] bg-surface/85',
      )}
      style={interactive}
      data-testid="group-title"
    >
      <TitleButton label={toggleLabel} onClick={() => setGroupsExpanded([group.id], collapsed)}>
        {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
      </TitleButton>
      <div className="min-w-0 flex-1">
        {editing === 'name' ? (
          <InlineEdit
            label="Group name"
            initial={group.name}
            maxLength={128}
            onDone={(value) => {
              setEditing(null);
              const name = value?.trim();
              if (name && name !== group.name) store().renameGroup(group.id, name);
            }}
          />
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: double-click is the mouse shortcut; the group menu has "Rename group"
          <span
            data-group-name
            className="block truncate text-sm font-semibold text-ink"
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (!readOnly) setEditing('name');
            }}
          >
            {group.name}
          </span>
        )}
      </div>
      {collapsed && editing !== 'name' && (
        <span className="shrink-0 px-1 text-xs text-ink-3">{plural(memberCount, 'node')}</span>
      )}
      {hasDescription && (
        <TitleButton
          label={`${descriptionPinned ? 'Hide' : 'Show'} description of ${group.name}`}
          pressed={descriptionPinned}
          onClick={() => setGroupDescriptionPinned(group.id, !descriptionPinned)}
        >
          <Info size={14} />
        </TitleButton>
      )}
      {!readOnly && (
        <>
          <TitleButton label={`Edit description of ${group.name}`} onClick={() => setEditing('description')}>
            <PencilLine size={14} />
          </TitleButton>
          <TitleButton label={`Ungroup ${group.name}`} onClick={() => store().ungroup(group.id)}>
            <Ungroup size={14} />
          </TitleButton>
        </>
      )}
    </div>
  );

  const descriptionEditor = editing === 'description' && (
    <div className="px-2 pb-2" style={interactive}>
      <InlineEdit
        label="Group description"
        initial={group.description ?? ''}
        maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
        multiline
        onDone={(value) => {
          setEditing(null);
          if (value !== null && value.trim() !== (group.description ?? '')) {
            store().updateGroupDescription(group.id, value);
          }
        }}
      />
    </div>
  );

  if (collapsed) {
    return (
      <div
        className={cx(
          GROUP_DRAG_HANDLE,
          'wf-group-card relative flex h-full w-full flex-col rounded-2xl border border-brand-line bg-surface shadow-card',
        )}
      >
        <Handle type="target" position={Position.Left} id={GROUP_IN_HANDLE} isConnectable={false} />
        {titleBar}
        {descriptionEditor}
        {showDescription && (
          <p className="line-clamp-3 px-3 pb-2 text-xs leading-[18px] text-ink-2">{group.description}</p>
        )}
        <Handle type="source" position={Position.Right} id={GROUP_OUT_HANDLE} isConnectable={false} />
      </div>
    );
  }

  return (
    <div
      className="wf-group-frame relative h-full w-full rounded-2xl border-2 border-dashed border-brand-line"
      style={{ background: 'color-mix(in oklab, var(--wf-brand) 5%, transparent)' }}
    >
      {showDescription && (
        <p
          className="absolute bottom-full left-2 mb-1 line-clamp-2 max-w-[360px] text-xs text-ink-2"
          style={interactive}
        >
          {group.description}
        </p>
      )}
      {titleBar}
      {descriptionEditor && (
        <div className="absolute inset-x-0 top-9 z-10 max-w-[400px] rounded-b-xl bg-surface shadow-card">
          {descriptionEditor}
        </div>
      )}
    </div>
  );
});
