/** Sticky note: Markdown rendered safely; double-click to edit, resizable when selected. */
import { type NodeProps, NodeResizer } from '@xyflow/react';
import { Pencil, Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { Markdown } from '../../lib/markdown';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { cx } from '../ui/cx';
import { useCanvasActions } from './actions';
import type { StickyFlowNode } from './flow-elements';

export const STICKY_COLORS = ['#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9', '#eb5757', '#9aa5b1'];

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<StickyFlowNode>) {
  const { sticky, readOnly } = data;
  const actions = useCanvasActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sticky.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(sticky.content);
  }, [sticky.content, editing]);
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const rootRef = useRef<HTMLDivElement>(null);
  const stickyAction = useUiStore((s) => s.stickyAction);

  // context menu "Edit sticky note" / "Change color" (P3-02)
  useEffect(() => {
    if (!stickyAction || stickyAction.id !== sticky.id) return;
    useUiStore.getState().setStickyAction(null);
    if (readOnly) return;
    if (stickyAction.action === 'edit') setEditing(true);
    else rootRef.current?.querySelector<HTMLElement>('[aria-label^="Sticky colour"]')?.focus();
  }, [stickyAction, sticky.id, readOnly]);

  // Enter edits the selected sticky (the menu shows the shortcut), when it is the only selection
  useEffect(() => {
    if (!selected || readOnly || editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, button, [contenteditable="true"], .cm-editor')
      )
        return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const sel = useWorkflowStore.getState().selection;
      if (sel.nodes.length || sel.stickies.length !== 1 || sel.stickies[0] !== sticky.id) return;
      event.preventDefault();
      setEditing(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, readOnly, editing, sticky.id]);

  const finish = () => {
    setEditing(false);
    if (draft !== sticky.content) actions.updateSticky(sticky.id, { content: draft });
  };

  return (
    <>
      <NodeResizer
        isVisible={selected && !readOnly}
        minWidth={160}
        minHeight={80}
        onResizeEnd={(_, params) =>
          actions.updateSticky(sticky.id, {
            width: Math.round(params.width),
            height: Math.round(params.height),
            position: [Math.round(params.x), Math.round(params.y)],
          })
        }
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: double-click is a shortcut; the Edit button in the toolbar is the accessible path */}
      <div
        ref={rootRef}
        className="wf-sticky group relative flex flex-col"
        style={{ ['--wf-sticky' as string]: sticky.color ?? STICKY_COLORS[0] }}
        onDoubleClick={() => !readOnly && setEditing(true)}
      >
        {selected && !readOnly && (
          <div className="nodrag absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded-md bg-surface/90 p-0.5 shadow-card">
            {!editing && (
              <button
                type="button"
                aria-label="Edit sticky note"
                className="grid size-5 place-items-center rounded text-ink-2 hover:text-brand"
                onClick={() => setEditing(true)}
              >
                <Pencil size={12} />
              </button>
            )}
            {STICKY_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Sticky colour ${color}`}
                className={cx(
                  'size-4 rounded-full border border-black/10',
                  sticky.color === color && 'ring-2 ring-brand',
                )}
                style={{ background: color }}
                onClick={() => actions.updateSticky(sticky.id, { color })}
              />
            ))}
            <button
              type="button"
              aria-label="Delete sticky note"
              className="grid size-5 place-items-center rounded text-ink-2 hover:text-err"
              onClick={() => actions.removeSticky(sticky.id)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
        {editing ? (
          <textarea
            ref={textareaRef}
            aria-label="Sticky note text"
            className="nodrag nowheel h-full w-full flex-1 resize-none bg-transparent p-3 font-mono text-xs outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                finish();
              }
            }}
          />
        ) : (
          <div className="wf-scroll nowheel h-full overflow-auto p-3 text-sm">
            {sticky.content.trim() ? (
              <Markdown source={sticky.content} />
            ) : (
              <p className="text-ink-3">
                {readOnly ? 'Empty note' : 'Double-click to write a note. Markdown works here.'}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
});
