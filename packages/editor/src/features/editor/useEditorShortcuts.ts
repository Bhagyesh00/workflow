/** Keyboard shortcuts and clipboard handling for the canvas. */
import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';
import { parseClipboard } from '../../lib/workflow-ops';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

export const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'Ctrl S', label: 'Save' },
  { keys: 'Ctrl Enter', label: 'Execute workflow' },
  { keys: 'N or Tab', label: 'Add a node' },
  { keys: 'Shift S', label: 'Add a sticky note' },
  { keys: 'Enter', label: 'Open the selected node' },
  { keys: 'D', label: 'Deactivate or activate selected nodes' },
  { keys: 'Ctrl C / X / V', label: 'Copy, cut, paste' },
  { keys: 'Ctrl D', label: 'Duplicate' },
  { keys: 'Ctrl Z / Ctrl Shift Z', label: 'Undo, redo' },
  { keys: 'Ctrl A', label: 'Select all' },
  { keys: 'Delete', label: 'Delete selection' },
  { keys: '1', label: 'Zoom to fit' },
  { keys: '0', label: 'Reset zoom' },
  { keys: '+ / -', label: 'Zoom in, out' },
  { keys: 'L', label: 'Show or hide logs' },
  { keys: '?', label: 'Show these shortcuts' },
];

let memoryClipboard = '';

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

      if (mod && key === 'enter') {
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
        const text = JSON.stringify(store.copySelection(), null, 2);
        memoryClipboard = text;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        if (key === 'x') store.deleteSelection();
        else
          toast.info(
            `Copied ${store.selection.nodes.length || store.selection.stickies.length} item${store.selection.nodes.length + store.selection.stickies.length === 1 ? '' : 's'}`,
          );
      } else if (mod && key === 'd') {
        event.preventDefault();
        store.duplicateSelection();
      } else if (mod) {
        return;
      } else if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        store.deleteSelection();
      } else if (key === 'enter' && store.selection.nodes.length === 1) {
        event.preventDefault();
        ui.openNdv(store.selection.nodes[0]);
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
      const text = event.clipboardData?.getData('text/plain') || memoryClipboard;
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
