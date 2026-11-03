/**
 * Group view state kept in this browser per workflow (P3-04 addendum, as n8n
 * useCanvasNodeGroupView): which groups are expanded (every other group shows collapsed) and
 * which descriptions are pinned. View-only: nothing here is saved with the workflow and nothing
 * marks it dirty.
 *
 * The workflow id is the open workflow (workflow store meta.id); an unsaved workflow uses one
 * slot that moves to the new id on its first save. State lives in memory and is written through to localStorage (one key, entries per
 * workflow id), so it survives a reload; without storage it lasts for the page.
 */
import { useWorkflowStore } from '../stores/workflow-store';
import { GROUP_VIEW_EVENT } from './group-layout-push';

const STORAGE_KEY = 'workflow.groupView';
const UNSAVED = '__unsaved__';

interface WorkflowGroupView {
  /** expanded group ids, in the order they were expanded */
  expanded: string[];
  pinned: string[];
}

let memory: Record<string, WorkflowGroupView> | null = null;

function isView(value: unknown): value is WorkflowGroupView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WorkflowGroupView>;
  const strings = (list: unknown) => Array.isArray(list) && list.every((x) => typeof x === 'string');
  return strings(v.expanded) && strings(v.pinned);
}

function state(): Record<string, WorkflowGroupView> {
  if (memory) return memory;
  memory = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [id, view] of Object.entries(parsed as Record<string, unknown>)) {
        if (isView(view)) memory[id] = { expanded: [...view.expanded], pinned: [...view.pinned] };
      }
    }
  } catch {
    // unreadable or blocked storage: start empty
  }
  return memory;
}

const workflowKey = (workflowId?: string) => workflowId ?? useWorkflowStore.getState().meta.id ?? UNSAVED;

function viewOf(workflowId?: string): WorkflowGroupView {
  return state()[workflowKey(workflowId)] ?? { expanded: [], pinned: [] };
}

function persist(all: Record<string, WorkflowGroupView>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // storage full or blocked: the in-memory state still applies
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(GROUP_VIEW_EVENT));
}

function save(next: WorkflowGroupView, workflowId?: string): void {
  const all = state();
  const key = workflowKey(workflowId);
  if (!next.expanded.length && !next.pinned.length) delete all[key];
  else all[key] = next;
  persist(all);
}

/**
 * The unsaved slot belongs to the new workflow on the canvas. Its first save (markSaved gives it
 * an id without a load) moves the slot to that id, so the groups the user just made stay as they
 * are. A load or reset (a new loadCount) opens another workflow, so the slot is dropped and never
 * reaches the next new workflow.
 */
useWorkflowStore.subscribe((next, prev) => {
  const all = state();
  if (!all[UNSAVED]) return;
  if (next.loadCount !== prev.loadCount) {
    delete all[UNSAVED];
    persist(all);
  } else if (!prev.meta.id && next.meta.id) {
    all[next.meta.id] = all[UNSAVED];
    delete all[UNSAVED];
    persist(all);
  }
});

const openGroups = () => useWorkflowStore.getState().nodeGroups;

/** Expand (true) or collapse (false) the given groups, or every group of the open workflow. */
export function setGroupsExpanded(groupIds: readonly string[] | 'all', expanded: boolean): void {
  const ids = groupIds === 'all' ? openGroups().map((g) => g.id) : [...groupIds];
  const view = viewOf();
  const kept = view.expanded.filter((id) => !ids.includes(id));
  const next = expanded ? [...kept, ...ids.filter((id, i) => ids.indexOf(id) === i)] : kept;
  if (next.length === view.expanded.length && next.every((id, i) => id === view.expanded[i])) return;
  save({ ...view, expanded: next });
}

export function isGroupExpanded(groupId: string, workflowId?: string): boolean {
  return viewOf(workflowId).expanded.includes(groupId);
}

/** Show (true) or hide (false) a collapsed group's description; only a group with one can be pinned. */
export function setGroupDescriptionPinned(groupId: string, pinned: boolean): void {
  const view = viewOf();
  const has = view.pinned.includes(groupId);
  if (pinned) {
    const group = openGroups().find((g) => g.id === groupId);
    if (has || !group?.description?.trim()) return;
    save({ ...view, pinned: [...view.pinned, groupId] });
  } else if (has) {
    save({ ...view, pinned: view.pinned.filter((id) => id !== groupId) });
  }
}

export function isGroupDescriptionPinned(groupId: string, workflowId?: string): boolean {
  return viewOf(workflowId).pinned.includes(groupId);
}
