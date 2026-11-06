/**
 * Opens forms in a popup while a workflow is tested. One window at a time: a form page goes on to the
 * next page by itself, so a popup that is still open is left alone.
 */
import type { TaskData } from '@workflow/workflow';

const POPUP_NAME = 'workflow-form';
const POPUP_FEATURES = 'popup,width=620,height=760,resizable=yes,scrollbars=yes';

let popup: Window | null = null;
/** the waiting tasks that have asked already */
const asked = new Set<string>();

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function show(url: string): void {
  const opened = window.open(url, POPUP_NAME, POPUP_FEATURES);
  if (!opened) return;
  popup = opened;
  // a form page has no business with the editor; the handle only tells whether it is closed
  try {
    opened.opener = null;
  } catch {
    // the popup already shows a page of another origin, which was cut off when it opened
  }
}

/** open the test URL of a Form Trigger */
export function openTestForm(url: string): void {
  if (isHttpUrl(url)) show(url);
}

/** after a node finished: open the next form page when the task asks for one */
export function maybeOpenFormPopup(taskData: TaskData): void {
  if (taskData.executionStatus !== 'waiting') return;
  const url = taskData.metadata?.resumeFormUrl;
  if (typeof url !== 'string' || !isHttpUrl(url)) return;
  const task = `${url}@${taskData.startTime}`;
  if (asked.has(task)) return;
  asked.add(task);
  if (popup && !popup.closed) return;
  show(url);
}

/** for tests: forget the popup and the tasks */
export function resetFormPopup(): void {
  popup = null;
  asked.clear();
}
