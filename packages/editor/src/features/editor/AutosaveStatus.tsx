/**
 * Autosave status in the editor header (P3-17): Saving / Saved / failed ("Autosave failed: <error>.
 * Retrying in Ns", as n8n; a failure raises no toast).
 */
import { useAutosaveStatus } from './useAutosave';

export function AutosaveStatus() {
  const { state, retryIn, error } = useAutosaveStatus();
  if (state === 'idle') return null;
  const text =
    state === 'saving'
      ? 'Autosaving…'
      : state === 'saved'
        ? 'Autosaved'
        : `Autosave failed: ${error.replace(/[.\s]+$/, '')}. Retrying in ${retryIn}s`;
  return (
    <span
      className={
        state === 'failed' ? 'hidden text-xs text-err md:inline' : 'hidden text-xs text-ink-3 md:inline'
      }
      role="status"
      aria-live="polite"
    >
      {text}
    </span>
  );
}
