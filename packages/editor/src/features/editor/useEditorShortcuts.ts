/** Keyboard shortcuts and clipboard handling for the canvas. */
import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';
import { setGroupsExpanded } from '../../lib/group-view';
import { groupsOfNodes } from '../../lib/node-groups';
import { parseClipboard } from '../../lib/workflow-ops';
import { useRunStore } from '../../stores/run-store';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { EditorDeps } from './editor-actions';
import {
  copySelectionToClipboard,
  cutSelection,
  pinNodes,
  readMemoryClipboard,
  startRename,
  unpinNodes,
} from './node-commands';
import { openSubWorkflow } from './open-resources';
import { tidyUp } from './tidy-up';
import { copyNodeWebhookUrl } from './webhook-urls';

export const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'Ctrl K', label: 'Open the command bar' },
  { keys: 'Ctrl S', label: 'Save' },
  { keys: 'Ctrl Enter', label: 'Execute workflow' },
  { keys: 'N or Tab', label: 'Add a node' },
  { keys: 'Shift S', label: 'Add a sticky note' },
  { keys: 'Enter', label: 'Open the selected node' },
  { keys: 'F2', label: 'Rename the selected node' },
  { keys: 'R', label: 'Replace the selected node' },
  { keys: 'D', label: 'Deactivate or activate selected nodes' },
  { keys: 'P', label: 'Pin or unpin selected nodes' },
  { keys: 'Ctrl C / X / V', label: 'Copy, cut, paste' },
  { keys: 'Ctrl D', label: 'Duplicate' },
  { keys: 'Ctrl Z / Ctrl Shift Z', label: 'Undo, redo' },
  { keys: 'Ctrl A', label: 'Select all' },
  { keys: 'Delete', label: 'Delete selection' },
  { keys: 'Ctrl G', label: 'Group selected nodes' },
  { keys: 'Ctrl Shift G', label: 'Ungroup' },
  { keys: 'Alt G / Shift Alt G', label: 'Expand, collapse groups' },
  { keys: 'Alt X', label: 'Convert selected nodes to a sub-workflow' },
  { keys: 'Shift Alt T', label: 'Tidy up' },
  { keys: 'Alt U', label: 'Copy the production URL' },
  { keys: 'Shift Alt U', label: 'Copy the test URL' },
  { keys: 'Ctrl Shift O', label: 'Open the sub-workflow' },
  { keys: '1', label: 'Zoom to fit' },
  { keys: '0', label: 'Reset zoom' },
  { keys: '+ / -', label: 'Zoom in, out' },
  { keys: 'L', label: 'Show or hide logs' },
  { keys: '?', label: 'Show these shortcuts' },
];

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"], .cm-editor'));
}

function overlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
}

export function useEditorShortcuts(handlers: {
  onSave: () => void;
  onExecute: () => void;
  onAddSticky: () => void;
  /** node descriptions for pinning (P3-02); without them P pins nothing */
  descriptions?: EditorDeps['descriptions'];
}) {
  const flow = useReactFlow();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 's') {
        event.preventDefault();
        handlers.onSave();
        return;
      }
      if (isEditable(event.target) || overlayOpen()) return;
      const store = useWorkflowStore.getState();
      const ui = useUiStore.getState();
      const selected = store.selection.nodes;
      const single = selected.length === 1 ? selected[0] : null;
      // Alt combinations: match the physical key (Alt changes event.key on macOS)
      const code = event.code;

      if (mod && event.shiftKey && code === 'KeyO') {
        event.preventDefault();
        if (single) openSubWorkflow(single);
      } else if (mod && code === 'KeyG') {
        event.preventDefault();
        if (event.shiftKey) {
          for (const id of groupsOfNodes(store, selected)) store.ungroup(id);
        } else if (selected.length) {
          store.groupSelection();
        }
      } else if (mod && key === 'enter') {
        event.preventDefault();
        handlers.onExecute();
      } else if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
      } else if (mod && key === 'y') {
        event.preventDefault();
        store.redo();
      } else if (mod && key === 'a') {
        event.preventDefault();
        store.selectAll();
      } else if (mod && (key === 'c' || key === 'x')) {
        if (!store.selection.nodes.length && !store.selection.stickies.length) return;
        event.preventDefault();
        if (key === 'x') cutSelection();
        else copySelectionToClipboard();
      } else if (mod && key === 'd') {
        event.preventDefault();
        store.duplicateSelection();
      } else if (mod) {
        return;
      } else if (event.altKey && event.shiftKey && code === 'KeyT') {
        event.preventDefault();
        tidyUp(
          flow,
          selected.length >= 2 ? { nodes: selected, stickies: store.selection.stickies } : undefined,
        );
      } else if (event.altKey && code === 'KeyG') {
        event.preventDefault();
        const groups = groupsOfNodes(store, selected);
        setGroupsExpanded(groups.length ? groups : 'all', !event.shiftKey);
      } else if (event.altKey && code === 'KeyX') {
        event.preventDefault();
        if (selected.length && !store.readOnly) ui.setConvertOpen(true);
      } else if (event.altKey && code === 'KeyU') {
        event.preventDefault();
        if (single) void copyNodeWebhookUrl(single, event.shiftKey ? 'test' : 'production');
      } else if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        store.deleteSelection();
      } else if (key === 'enter' && single) {
        event.preventDefault();
        ui.openNdv(single);
      } else if (key === 'f2' && single) {
        event.preventDefault();
        startRename(single);
      } else if (key === 'r' && !event.shiftKey && single && !store.readOnly) {
        event.preventDefault();
        ui.openCreator();
        ui.setReplaceTarget(single);
      } else if (key === 'p' && !event.shiftKey && selected.length) {
        event.preventDefault();
        if (selected.every((name) => store.pinData[name])) unpinNodes(selected);
        else if (handlers.descriptions)
          pinNodes(selected, handlers.descriptions, useRunStore.getState().runData);
      } else if ((key === 'n' || key === 'tab') && !event.shiftKey) {
        event.preventDefault();
        ui.openCreator();
      } else if (key === 's' && event.shiftKey) {
        event.preventDefault();
        handlers.onAddSticky();
      } else if (key === 'd' && store.selection.nodes.length) {
        store.toggleDisabled(store.selection.nodes);
      } else if (key === '1') {
        void flow.fitView({ padding: 0.25, maxZoom: 1.1, duration: 200 });
      } else if (key === '0') {
        void flow.zoomTo(1, { duration: 200 });
      } else if (key === '+' || key === '=') {
        void flow.zoomIn({ duration: 150 });
      } else if (key === '-') {
        void flow.zoomOut({ duration: 150 });
      } else if (event.key === '?') {
        ui.setShortcutsOpen(true);
      } else if (key === 'l') {
        ui.setLogPanel(!ui.logPanelOpen);
      } else if (key === 'escape') {
        if (ui.sidePanel) ui.setSidePanel(null);
        else store.clearSelection();
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      if (isEditable(event.target) || overlayOpen()) return;
      const text = event.clipboardData?.getData('text/plain') || readMemoryClipboard();
      const payload = parseClipboard(text);
      if (!payload) return;
      event.preventDefault();
      const store = useWorkflowStore.getState();
      if (store.readOnly) return;
      // drop the pasted block around the centre of the visible canvas
      const xs = [
        ...payload.nodes.map((n) => n.position[0]),
        ...(payload.stickyNotes ?? []).map((s) => s.position[0]),
      ];
      const ys = [
        ...payload.nodes.map((n) => n.position[1]),
        ...(payload.stickyNotes ?? []).map((s) => s.position[1]),
      ];
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      const sameWorkflow = payload.nodes.some((n) => store.nodes.some((m) => m.id === n.id));
      const minX = xs.length ? Math.min(...xs) : 0;
      const minY = ys.length ? Math.min(...ys) : 0;
      const offset: [number, number] = sameWorkflow
        ? [40, 40]
        : [Math.round(center.x - minX), Math.round(center.y - minY)];
      const names = store.paste(payload, offset);
      if (names.length) toast.info(`Pasted ${names.length} node${names.length === 1 ? '' : 's'}`);
    };

    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('paste', onPaste);
    };
  }, [flow, handlers]);
}
