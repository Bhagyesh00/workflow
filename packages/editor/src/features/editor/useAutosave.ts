/**
 * Autosave (P3-17, as n8n useWorkflowSaving): save the draft 1.5 s after a change and at most 5 s
 * after the first unsaved change, with saveWorkflow(deps, { autosaved: true }); never for
 * read-only, archived or unsaved-new workflows, never two saves at once, retry with backoff;
 * off when settings.autosaveEnabled is false.
 *
 * C0 STUB: lane L13 writes it; does nothing until then.
 */
import type { EditorDeps } from './editor-actions';

export function useAutosave(_deps: EditorDeps): void {}
