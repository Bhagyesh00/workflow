/**
 * The canvas context menu (P3-02, n8n entries and order) for ui.contextMenu: node, selection,
 * group title, sticky and canvas targets. Rendered inside the editor's ReactFlowProvider. The entries
 * come from node-menu.ts; this component wires them to the stores and commands.
 */
import { useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { ContextMenu } from '../../components/ui/ContextMenu';
import { Dialog } from '../../components/ui/Dialog';
import { TextInput } from '../../components/ui/Field';
import {
  isGroupDescriptionPinned,
  isGroupExpanded,
  setGroupDescriptionPinned,
  setGroupsExpanded,
} from '../../lib/group-view';
import { useRunStore } from '../../stores/run-store';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { type EditorDeps, runWorkflow } from './editor-actions';
import { copySelectionToClipboard, pinNodes, startRename, unpinNodes } from './node-commands';
import { buildMenu, type MenuActions, type MenuEntry } from './node-menu';
import { openSubWorkflow, subWorkflowTargets } from './open-resources';
import { tidyUp } from './tidy-up';
import { copyNodeWebhookUrl } from './webhook-urls';
import { addStickyAt } from './workflow-commands';

export interface CanvasContextMenuProps {
  deps: EditorDeps;
  /** "Test workflow" / run */
  execute: () => void;
}

export function CanvasContextMenu({ deps }: CanvasContextMenuProps) {
  const flow = useReactFlow();
  const menu = useUiStore((s) => s.contextMenu);
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const pinData = useWorkflowStore((s) => s.pinData);
  const stickyNotes = useWorkflowStore((s) => s.stickyNotes);
  const nodeGroups = useWorkflowStore((s) => s.nodeGroups);
  const selection = useWorkflowStore((s) => s.selection);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const published = useWorkflowStore((s) => s.meta.active);
  const lookup = useWorkflowStore((s) => s.nodeTypeLookup);
  const runData = useRunStore((s) => s.runData);
  const [renamingGroup, setRenamingGroup] = useState<{ id: string; name: string } | null>(null);
  // bumped by the view actions so the Expand / Collapse labels follow the view state
  const [, setViewTick] = useState(0);

  const close = () => useUiStore.getState().closeContextMenu();

  // the commands that act on the selection need the target selected
  const target = menu?.target;
  useEffect(() => {
    if (!target) return;
    const store = useWorkflowStore.getState();
    const current = store.selection;
    if (target.type === 'node') {
      if (!current.nodes.includes(target.nodeName))
        store.select({ nodes: [target.nodeName], stickies: [], edges: [] });
    } else if (target.type === 'sticky') {
      if (!current.stickies.includes(target.stickyId))
        store.select({ nodes: [], stickies: [target.stickyId], edges: [] });
    } else if (target.type === 'group') {
      const group = store.nodeGroups.find((g) => g.id === target.groupId);
      const members = store.nodes.filter((n) => group?.nodeIds.includes(n.id)).map((n) => n.name);
      const same = members.length === current.nodes.length && members.every((n) => current.nodes.includes(n));
      if (group && !same) store.select({ nodes: members, stickies: [], edges: [] });
    }
  }, [target]);

  const actions: MenuActions = useMemo(
    () => ({
      open: (name) => useUiStore.getState().openNdv(name),
      testStep: (name) => void runWorkflow(deps, { destinationNode: name }),
      copyUrl: (name, kind) => void copyNodeWebhookUrl(name, kind),
      openSubWorkflow: (name) => openSubWorkflow(name),
      rename: (name) => startRename(name),
      toggleDisabled: (names) => useWorkflowStore.getState().toggleDisabled(names),
      pin: (names) => void pinNodes(names, deps.descriptions, useRunStore.getState().runData),
      unpin: (names) => void unpinNodes(names),
      copy: () => void copySelectionToClipboard(),
      duplicate: () => void useWorkflowStore.getState().duplicateSelection(),
      tidyUp: (tidyTarget) => tidyUp(flow, tidyTarget),
      selectAll: () => useWorkflowStore.getState().selectAll(),
      deselectAll: () => useWorkflowStore.getState().clearSelection(),
      removeNodes: (names) => useWorkflowStore.getState().removeNodes(names),
      removeSelection: () => useWorkflowStore.getState().deleteSelection(),
      group: () => void useWorkflowStore.getState().groupSelection(),
      ungroup: (ids) => {
        for (const id of ids) useWorkflowStore.getState().ungroup(id);
      },
      renameGroup: (id) => {
        const group = useWorkflowStore.getState().nodeGroups.find((g) => g.id === id);
        if (group) setRenamingGroup({ id, name: group.name });
      },
      convert: () => useUiStore.getState().setConvertOpen(true),
      setGroupsExpanded: (ids, expanded) => {
        setGroupsExpanded(ids, expanded);
        setViewTick((n) => n + 1);
      },
      setDescriptionPinned: (id, pinned) => {
        setGroupDescriptionPinned(id, pinned);
        setViewTick((n) => n + 1);
      },
      editSticky: (id) => useUiStore.getState().setStickyAction({ id, action: 'edit' }),
      colorSticky: (id) => useUiStore.getState().setStickyAction({ id, action: 'color' }),
      addNode: (position) => useUiStore.getState().openCreator({ position }),
      addSticky: (position) => void addStickyAt(flow, position),
    }),
    [deps, flow],
  );

  // read on every render: the Expand / Collapse actions bump viewTick, which re-renders this
  const groupViewKey = JSON.stringify({
    expanded: nodeGroups.filter((g) => isGroupExpanded(g.id)).map((g) => g.id),
    pinned: nodeGroups.filter((g) => isGroupDescriptionPinned(g.id)).map((g) => g.id),
  });

  const items = useMemo(() => {
    if (!target) return [];
    const graph = { nodes, connections, pinData, stickyNotes, nodeGroups };
    const model = buildMenu(
      {
        target,
        graph,
        selection,
        readOnly,
        published,
        descriptions: deps.descriptions,
        runData,
        lookup,
        subWorkflowNodes: subWorkflowTargets(nodes).map((t) => t.nodeName),
        groupView: JSON.parse(groupViewKey),
      },
      actions,
    );
    return model.map((entry) => (entry === 'separator' ? entry : toItem(entry)));
  }, [
    target,
    nodes,
    connections,
    pinData,
    stickyNotes,
    nodeGroups,
    selection,
    readOnly,
    published,
    deps.descriptions,
    runData,
    lookup,
    actions,
    groupViewKey,
  ]);

  const submitGroupName = () => {
    if (!renamingGroup) return;
    const name = renamingGroup.name.trim();
    if (name) useWorkflowStore.getState().renameGroup(renamingGroup.id, name);
    setRenamingGroup(null);
  };

  return (
    <>
      {menu && items.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={close} label="Canvas actions" />
      )}
      <Dialog
        open={Boolean(renamingGroup)}
        onClose={() => setRenamingGroup(null)}
        title="Rename group"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenamingGroup(null)}>
              Cancel
            </Button>
            <Button onClick={submitGroupName}>Rename</Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitGroupName();
          }}
        >
          <label className="mb-1 block text-xs font-semibold text-ink-2" htmlFor="rename-group-name">
            Group name
          </label>
          <TextInput
            id="rename-group-name"
            data-autofocus
            value={renamingGroup?.name ?? ''}
            onChange={(event) => setRenamingGroup((g) => (g ? { ...g, name: event.target.value } : g))}
            onFocus={(event) => event.target.select()}
          />
        </form>
      </Dialog>
    </>
  );
}

function toItem(entry: MenuEntry) {
  return {
    key: entry.key,
    label: entry.label,
    hint: entry.shortcut,
    disabled: entry.disabled,
    title: entry.reason,
    danger: entry.danger,
    onSelect: entry.run,
  };
}
