/**
 * Autosave status in the editor header (P3-17): Saving / Saved / failed (retrying in Ns).
 */
import { useAutosaveStatus } from './useAutosave';

export function AutosaveStatus() {
  const { state, retryIn } = useAutosaveStatus();
  if (state === 'idle') return null;
  const text =
    state === 'saving'
      ? 'Autosaving…'
      : state === 'saved'
        ? 'Autosaved'
        : `Autosave failed, retrying in ${retryIn}s`;
  return (
    <span
      className={state === 'failed' ? 'hidden text-xs text-err md:inline' : 'hidden text-xs text-ink-3 md:inline'}
      role="status"
      aria-live="polite"
    >
      {text}
    </span>
  );
}
