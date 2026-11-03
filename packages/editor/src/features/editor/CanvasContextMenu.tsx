/**
 * The canvas context menu (P3-02, n8n entries and order) for ui.contextMenu: node, selection,
 * group title, sticky and canvas targets. Rendered inside the editor's ReactFlowProvider.
 *
 * C0 STUB: lane L2 writes it; renders nothing until then.
 */
import type { EditorDeps } from './editor-actions';

export interface CanvasContextMenuProps {
  deps: EditorDeps;
  /** "Test workflow" / run */
  execute: () => void;
}

export function CanvasContextMenu(_props: CanvasContextMenuProps): null {
  return null;
}
