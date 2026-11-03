/**
 * Registers the editor's commands with the command bar while the editor is open (P3-01): add node,
 * sticky, nodes in workflow, test workflow, tidy up, select all, rename, add tag, settings,
 * duplicate, download, import, publish / unpublish, archive (unarchive / delete when archived),
 * open sub-workflow and credential (P3-12), import from URL (P3-13). Write commands are hidden
 * for read-only.
 *
 * C0 STUB: lane L3 writes it; registers nothing until then.
 */
import type { ReactFlowInstance } from '@xyflow/react';
import type { EditorDeps } from '../editor/editor-actions';

export interface EditorCommandsInput {
  deps: EditorDeps;
  flow: ReactFlowInstance;
  save: () => Promise<void>;
  execute: () => void;
}

export function useEditorCommands(_input: EditorCommandsInput): void {}
