/**
 * Opens forms in a popup while a workflow is tested. Stubs: L1 (P4-02) writes them; both do nothing
 * until then, because the run store and the listen action already call them.
 */
import type { TaskData } from '@workflow/workflow';

/** open the test URL of a Form Trigger */
export function openTestForm(_url: string): void {}

/** after a node finished: open the next form page when the task asks for one */
export function maybeOpenFormPopup(_taskData: TaskData): void {}
