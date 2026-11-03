/**
 * Autosave (P3-17, as n8n useWorkflowSaving): save the draft 1.5 s after a change and at most 5 s
 * after the first unsaved change, with saveWorkflow(deps, { autosaved: true }); never for
 * read-only, archived or unsaved-new workflows, never two saves at once, retry with backoff;
 * off when settings.autosaveEnabled is false. A save here only writes the draft: it never
 * activates or publishes.
 */
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useSettings } from '../../api/queries';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { type EditorDeps, saveWorkflow } from './editor-actions';

export const AUTOSAVE_DELAY_MS = 1500;
export const AUTOSAVE_MAX_WAIT_MS = 5000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30_000;

export interface AutosaveStatusState {
  state: 'idle' | 'saving' | 'saved' | 'failed';
  /** seconds until the next retry (state 'failed') */
  retryIn: number;
}

export const useAutosaveStatus = create<AutosaveStatusState>()(() => ({ state: 'idle', retryIn: 0 }));

const setStatus = (next: AutosaveStatusState) => useAutosaveStatus.setState(next);

function eligible(): boolean {
  const s = useWorkflowStore.getState();
  return !!s.meta.id && s.dirty && !s.readOnly && !s.meta.isArchived && !useUiStore.getState().saveConflict;
}

export function useAutosave(deps: EditorDeps): void {
  const { autosaveEnabled } = useSettings();
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    if (!autosaveEnabled) return;
    let stopped = false;
    let running = false;
    let failures = 0;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let maxWait: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let countdown: ReturnType<typeof setInterval> | null = null;

    const clearPending = () => {
      if (debounce) clearTimeout(debounce);
      if (maxWait) clearTimeout(maxWait);
      debounce = null;
      maxWait = null;
    };
    const clearRetry = () => {
      if (retry) clearTimeout(retry);
      if (countdown) clearInterval(countdown);
      retry = null;
      countdown = null;
    };

    const schedule = () => {
      if (stopped || running || retry || !eligible()) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void run(), AUTOSAVE_DELAY_MS);
      maxWait ??= setTimeout(() => void run(), AUTOSAVE_MAX_WAIT_MS);
    };

    const run = async () => {
      clearPending();
      clearRetry();
      if (stopped || running || !eligible()) return;
      running = true;
      setStatus({ state: 'saving', retryIn: 0 });
      let saved = false;
      try {
        saved = (await saveWorkflow(depsRef.current, { autosaved: true })) !== null;
      } finally {
        running = false;
      }
      if (stopped) return;
      if (saved) {
        failures = 0;
        setStatus({ state: 'saved', retryIn: 0 });
        schedule(); // edits made during the save
        return;
      }
      if (!eligible()) {
        // a conflict, a switch to read-only or archived: nothing to retry
        setStatus({ state: 'idle', retryIn: 0 });
        return;
      }
      failures += 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
      let left = Math.ceil(delay / 1000);
      setStatus({ state: 'failed', retryIn: left });
      countdown = setInterval(() => {
        left = Math.max(0, left - 1);
        setStatus({ state: 'failed', retryIn: left });
      }, 1000);
      retry = setTimeout(() => void run(), delay);
    };

    let lastRevision = useWorkflowStore.getState().revision;
    const unsubscribe = useWorkflowStore.subscribe((s) => {
      if (s.revision === lastRevision) return;
      lastRevision = s.revision;
      if (useAutosaveStatus.getState().state === 'saved') setStatus({ state: 'idle', retryIn: 0 });
      schedule();
    });
    // a load or reset replaces the workflow: nothing pending belongs to the new one
    const unsubscribeLoad = useWorkflowStore.subscribe((s, prev) => {
      if (s.meta.id !== prev.meta.id) {
        clearPending();
        clearRetry();
        failures = 0;
        setStatus({ state: 'idle', retryIn: 0 });
      }
    });
    schedule();

    return () => {
      stopped = true;
      unsubscribe();
      unsubscribeLoad();
      clearPending();
      clearRetry();
      setStatus({ state: 'idle', retryIn: 0 });
    };
  }, [autosaveEnabled]);
}
