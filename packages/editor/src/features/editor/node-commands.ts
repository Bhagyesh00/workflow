/**
 * Node commands shared by keyboard shortcuts, the context menu (P3-02) and the command bar (P3-01):
 * clipboard, pin / unpin (n8n rules) and rename. They read and write the stores directly.
 */
import type { Item, NodeTypeDescription, RunData, WorkflowNode } from '@workflow/workflow';
import { deriveNodePorts } from '../../lib/ports';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

let memoryClipboard = '';

/** what the last copy put on the clipboard (the paste fallback when the system clipboard is empty) */
export function readMemoryClipboard(): string {
  return memoryClipboard;
}

/** Copy the selected nodes and stickies; returns how many items were copied (0: nothing selected). */
export function copySelectionToClipboard(options: { silent?: boolean } = {}): number {
  const store = useWorkflowStore.getState();
  const count = store.selection.nodes.length || store.selection.stickies.length;
  if (!store.selection.nodes.length && !store.selection.stickies.length) return 0;
  const text = JSON.stringify(store.copySelection(), null, 2);
  memoryClipboard = text;
  void navigator.clipboard?.writeText(text).catch(() => undefined);
  if (!options.silent) {
    const total = store.selection.nodes.length + store.selection.stickies.length;
    toast.info(`Copied ${count} item${total === 1 ? '' : 's'}`);
  }
  return count;
}

/** Copy, then delete the selection (read-only: copy only). */
export function cutSelection(): number {
  const count = copySelectionToClipboard({ silent: true });
  if (count) useWorkflowStore.getState().deleteSelection();
  return count;
}

/** node types whose output can never be pinned (n8n PIN_DATA_NODE_TYPES_DENYLIST) */
export const PIN_DENYLIST: readonly string[] = ['core.splitInBatches', 'core.stickyNote'];

/** the output a pin of `node` would take: output 0 of its last run */
function lastOutput(runData: RunData, name: string): Item[] | undefined {
  const runs = runData[name];
  const items = runs?.[runs.length - 1]?.data?.main?.[0];
  return items?.length ? items : undefined;
}

/**
 * Can `node` be pinned (n8n usePinnedData canPinNode)? Not for denylisted types, sub-nodes or nodes
 * with more or fewer than one main output (an error output does not count), and only with output
 * data to pin. A pinned node can always be unpinned (see `unpinNodes`).
 */
export function canPin(
  node: WorkflowNode,
  description: NodeTypeDescription | undefined,
  runData: RunData,
): boolean {
  if (!description || PIN_DENYLIST.includes(node.type)) return false;
  const ports = deriveNodePorts(node, description);
  if (ports.isSubNode) return false;
  const mainOutputs = ports.outputs.filter((p) => p.type === 'main' && p.category !== 'error');
  if (mainOutputs.length !== 1) return false;
  return Boolean(lastOutput(runData, node.name));
}

/** Pin the last output of every pinnable named node, as one undo step. Returns the pinned names. */
export function pinNodes(
  names: string[],
  descriptions: { get(type: string): NodeTypeDescription | undefined },
  runData: RunData,
): string[] {
  const store = useWorkflowStore.getState();
  if (store.readOnly) return [];
  const map: Record<string, Item[]> = {};
  for (const node of store.nodes) {
    if (!names.includes(node.name) || !canPin(node, descriptions.get(node.type), runData)) continue;
    map[node.name] = lastOutput(runData, node.name)!;
  }
  if (Object.keys(map).length) store.setPinDataMany(map);
  return Object.keys(map);
}

/** Unpin the named nodes that are pinned, as one undo step. Returns the unpinned names. */
export function unpinNodes(names: string[]): string[] {
  const store = useWorkflowStore.getState();
  if (store.readOnly) return [];
  const pinned = names.filter((n) => store.pinData[n]);
  if (pinned.length) store.setPinDataMany(Object.fromEntries(pinned.map((n) => [n, null])));
  return pinned;
}

/** Open the rename dialog for a node (F2, context menu "Rename"). */
export function startRename(nodeName: string): void {
  const store = useWorkflowStore.getState();
  if (store.readOnly || !store.nodes.some((n) => n.name === nodeName)) return;
  useUiStore.getState().setRenameTarget(nodeName);
}
