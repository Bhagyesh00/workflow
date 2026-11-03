/**
 * Group view state kept in this browser per workflow (P3-04 addendum, as n8n
 * useCanvasNodeGroupView): which groups are expanded (every other group shows collapsed) and
 * which descriptions are pinned. View-only: nothing here is saved with the workflow.
 *
 * C0 STUB: lane L4 writes the bodies. The workflow id is the open workflow (workflow store meta.id).
 */

/** Expand (true) or collapse (false) the given groups, or every group of the open workflow. */
export function setGroupsExpanded(_groupIds: readonly string[] | 'all', _expanded: boolean): void {
  throw new Error('not implemented (L4)');
}

export function isGroupExpanded(_groupId: string): boolean {
  throw new Error('not implemented (L4)');
}

/** Show (true) or hide (false) a collapsed group's description. */
export function setGroupDescriptionPinned(_groupId: string, _pinned: boolean): void {
  throw new Error('not implemented (L4)');
}

export function isGroupDescriptionPinned(_groupId: string): boolean {
  throw new Error('not implemented (L4)');
}
