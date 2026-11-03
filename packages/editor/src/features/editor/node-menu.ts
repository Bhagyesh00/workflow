/**
 * The canvas context menu model (P3-02, n8n entries and order): which entries each right-click target
 * shows, their labels, shortcut hints and enable rules. Pure: it reads the data in `MenuInputs` and
 * returns entries whose `run` calls one of `MenuActions`, so the rules are tested without a canvas.
 *
 * Targets: one node, a multi-selection, a group frame's title, a sticky note, the empty canvas.
 * Write entries are disabled in read-only; Copy, Open, Select all and the group view entries stay on.
 * Pin is disabled when the node cannot be pinned; Group is disabled (with the reason) when the selection
 * cannot be grouped; Convert to sub-workflow is hidden when it cannot be extracted.
 */
import {
  type NodeDescriptionLookup,
  type NodeTypeDescription,
  type RunData,
  validateSelectionForExtraction,
  validateSelectionForGrouping,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { groupsOfNodes } from '../../lib/node-groups';
import type { WorkflowGraph } from '../../lib/workflow-ops';
import type { ContextMenuTarget } from '../../stores/ui-store';
import { canPin } from './node-commands';
import type { WebhookUrlKind } from './webhook-urls';

export interface MenuEntry {
  key: string;
  label: string;
  /** shortcut hint shown at the end of the row */
  shortcut?: string;
  disabled?: boolean;
  /** why the entry is disabled (tooltip) */
  reason?: string;
  danger?: boolean;
  run: () => void;
}

export type MenuModel = Array<MenuEntry | 'separator'>;

/** what the entries do; CanvasContextMenu wires these to the stores and commands */
export interface MenuActions {
  open(nodeName: string): void;
  testStep(nodeName: string): void;
  copyUrl(nodeName: string, kind: WebhookUrlKind): void;
  openSubWorkflow(nodeName: string): void;
  rename(nodeName: string): void;
  toggleDisabled(names: string[]): void;
  pin(names: string[]): void;
  unpin(names: string[]): void;
  /** copy the selection */
  copy(): void;
  /** duplicate the selection */
  duplicate(): void;
  /** the whole workflow (undefined) or these nodes and the stickies that ride along */
  tidyUp(target?: { nodes: string[]; stickies?: string[] }): void;
  selectAll(): void;
  deselectAll(): void;
  removeNodes(names: string[]): void;
  /** delete the selected nodes and stickies */
  removeSelection(): void;
  group(): void;
  ungroup(groupIds: string[]): void;
  renameGroup(groupId: string): void;
  convert(): void;
  setGroupsExpanded(groupIds: string[] | 'all', expanded: boolean): void;
  setDescriptionPinned(groupId: string, pinned: boolean): void;
  editSticky(stickyId: string): void;
  colorSticky(stickyId: string): void;
  addNode(position: [number, number]): void;
  addSticky(position: [number, number]): void;
}

export interface MenuInputs {
  target: ContextMenuTarget;
  graph: WorkflowGraph;
  selection: { nodes: string[]; stickies: string[]; edges?: string[] };
  readOnly: boolean;
  /** the workflow is published (the production URL exists) */
  published: boolean;
  descriptions: { get(type: string): NodeTypeDescription | undefined };
  runData: RunData;
  /** type lookup for the group rules; defaults to `descriptions` */
  lookup?: NodeDescriptionLookup;
  /** names of nodes that call a sub-workflow that can be opened (Execute Workflow with a target) */
  subWorkflowNodes?: string[];
  /** which groups show expanded and which descriptions are pinned (default: all collapsed, none pinned) */
  groupView?: { expanded: string[]; pinned: string[] };
}

const READ_ONLY = 'This workflow is read-only';

/** the menu for `input.target`; consecutive sections are split by separators */
export function buildMenu(input: MenuInputs, actions: MenuActions): MenuModel {
  const sections = sectionsFor(input, actions);
  const model: MenuModel = [];
  for (const section of sections) {
    if (!section.length) continue;
    if (model.length) model.push('separator');
    model.push(...section);
  }
  return model;
}

function sectionsFor(input: MenuInputs, a: MenuActions): MenuEntry[][] {
  const { target } = input;
  if (target.type === 'canvas') return canvasSections(input, a, target.position);
  if (target.type === 'sticky') return stickySections(input, a, target.stickyId);
  if (target.type === 'group') return groupSections(input, a, target.groupId);
  if (target.type === 'selection') return multiSections(input, a, input.selection.nodes);
  const total = input.selection.nodes.length + input.selection.stickies.length;
  if (input.selection.nodes.includes(target.nodeName) && total > 1)
    return multiSections(input, a, input.selection.nodes);
  return nodeSections(input, a, target.nodeName);
}

const write = (input: MenuInputs, entry: MenuEntry): MenuEntry =>
  input.readOnly ? { ...entry, disabled: true, reason: READ_ONLY } : entry;

const nodeByName = (graph: WorkflowGraph, name: string): WorkflowNode | undefined =>
  graph.nodes.find((n) => n.name === name);

const lookupOf = (input: MenuInputs): NodeDescriptionLookup =>
  input.lookup ?? ((type) => input.descriptions.get(type));

const definitionOf = (graph: WorkflowGraph): WorkflowDefinition => ({
  name: '',
  nodes: graph.nodes,
  connections: graph.connections,
  stickyNotes: graph.stickyNotes,
  nodeGroups: graph.nodeGroups,
});

/** the webhook URLs a node has: none, or (test URL too unless every hook is a resume hook) */
function urlKinds(node: WorkflowNode, input: MenuInputs): { test: boolean; production: boolean } {
  const hooks = input.descriptions.get(node.type)?.webhooks ?? [];
  if (!hooks.length) return { test: false, production: false };
  return { test: hooks.some((h) => !h.restartWebhook), production: input.published };
}

// ---- sections shared by node, selection and group menus --------------------------------------------

function stateEntries(input: MenuInputs, a: MenuActions, names: string[], plural: boolean): MenuEntry[] {
  const nodes = names.map((n) => nodeByName(input.graph, n)).filter((n): n is WorkflowNode => Boolean(n));
  const allOff = nodes.length > 0 && nodes.every((n) => n.disabled);
  const allPinned = names.length > 0 && names.every((n) => input.graph.pinData[n]);
  const pinnable = nodes.filter((n) => canPin(n, input.descriptions.get(n.type), input.runData));
  const suffix = plural ? ' nodes' : '';
  const pinEntry: MenuEntry = allPinned
    ? { key: 'unpin', label: `Unpin${suffix}`, shortcut: 'P', run: () => a.unpin(names) }
    : {
        key: 'pin',
        label: `Pin${suffix}`,
        shortcut: 'P',
        disabled: pinnable.length === 0,
        reason: pinnable.length === 0 ? 'Run the node to get data to pin' : undefined,
        run: () => a.pin(names),
      };
  return [
    write(input, {
      key: 'toggle-disabled',
      label: `${allOff ? 'Activate' : 'Deactivate'}${suffix}`,
      shortcut: 'D',
      run: () => a.toggleDisabled(names),
    }),
    write(input, pinEntry),
  ];
}

function groupViewEntries(input: MenuInputs, a: MenuActions, groupIds: string[]): MenuEntry[] {
  const groups = input.graph.nodeGroups.filter((g) => groupIds.includes(g.id));
  if (!groups.length) return [];
  const view = input.groupView ?? { expanded: [], pinned: [] };
  const collapsed = groups.filter((g) => !view.expanded.includes(g.id));
  const expanded = groups.filter((g) => view.expanded.includes(g.id));
  const noun = groups.length === 1 ? 'group' : 'groups';
  const entries: MenuEntry[] = [];
  if (collapsed.length)
    entries.push({
      key: 'expand-groups',
      label: `Expand ${noun}`,
      shortcut: 'Alt+G',
      run: () =>
        a.setGroupsExpanded(
          collapsed.map((g) => g.id),
          true,
        ),
    });
  if (expanded.length)
    entries.push({
      key: 'collapse-groups',
      label: `Collapse ${noun}`,
      shortcut: 'Shift+Alt+G',
      run: () =>
        a.setGroupsExpanded(
          expanded.map((g) => g.id),
          false,
        ),
    });
  // a collapsed group with a description can show or hide it
  for (const group of collapsed) {
    if (!group.description?.trim()) continue;
    const shown = view.pinned.includes(group.id);
    entries.push({
      key: `description-${group.id}`,
      label: shown ? 'Hide description' : 'Show description',
      run: () => a.setDescriptionPinned(group.id, !shown),
    });
  }
  return entries;
}

function groupEntries(input: MenuInputs, a: MenuActions, names: string[]): MenuEntry[] {
  const ids = groupsOfNodes(input.graph, names);
  if (!ids.length) return [];
  const entries: MenuEntry[] = [];
  if (ids.length === 1)
    entries.push(
      write(input, { key: 'rename-group', label: 'Rename group', run: () => a.renameGroup(ids[0]) }),
    );
  entries.push(
    write(input, { key: 'ungroup', label: 'Ungroup', shortcut: 'Ctrl+Shift+G', run: () => a.ungroup(ids) }),
  );
  return entries;
}

// ---- one node ------------------------------------------------------------------------------------

function nodeSections(input: MenuInputs, a: MenuActions, name: string): MenuEntry[][] {
  const node = nodeByName(input.graph, name);
  if (!node) return [];
  const kinds = urlKinds(node, input);
  const head: MenuEntry[] = [
    { key: 'open', label: 'Open', shortcut: 'Enter', run: () => a.open(name) },
    { key: 'test-step', label: 'Test step', run: () => a.testStep(name) },
  ];
  if (kinds.test)
    head.push({
      key: 'copy-test-url',
      label: 'Copy test URL',
      shortcut: 'Shift+Alt+U',
      run: () => a.copyUrl(name, 'test'),
    });
  if (kinds.production)
    head.push({
      key: 'copy-production-url',
      label: 'Copy production URL',
      shortcut: 'Alt+U',
      run: () => a.copyUrl(name, 'production'),
    });
  if (input.subWorkflowNodes?.includes(name))
    head.push({
      key: 'open-sub-workflow',
      label: 'Open sub-workflow',
      shortcut: 'Ctrl+Shift+O',
      run: () => a.openSubWorkflow(name),
    });
  head.push(write(input, { key: 'rename', label: 'Rename', shortcut: 'F2', run: () => a.rename(name) }));
  head.push(...stateEntries(input, a, [name], false));

  const groupIds = groupsOfNodes(input.graph, [name]);
  const edit: MenuEntry[] = [
    { key: 'copy', label: 'Copy', shortcut: 'Ctrl+C', run: () => a.copy() },
    write(input, { key: 'duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', run: () => a.duplicate() }),
    write(input, {
      key: 'tidy-up',
      label: 'Tidy up',
      shortcut: 'Shift+Alt+T',
      run: () => a.tidyUp(undefined),
    }),
  ];
  return [
    head,
    [...edit, ...groupEntries(input, a, [name]), ...groupViewEntries(input, a, groupIds)],
    selectEntries(a),
    [
      write(input, {
        key: 'delete',
        label: 'Delete',
        shortcut: 'Del',
        danger: true,
        run: () => a.removeNodes([name]),
      }),
    ],
  ];
}

function selectEntries(a: MenuActions): MenuEntry[] {
  return [
    { key: 'select-all', label: 'Select all', shortcut: 'Ctrl+A', run: () => a.selectAll() },
    { key: 'deselect-all', label: 'Deselect all', run: () => a.deselectAll() },
  ];
}

// ---- several nodes -------------------------------------------------------------------------------

function multiSections(
  input: MenuInputs,
  a: MenuActions,
  names: string[],
  options: { tidy?: { nodes: string[]; stickies?: string[] }; remove?: () => void } = {},
): MenuEntry[][] {
  const stickies = input.selection.stickies;
  const edit: MenuEntry[] = [
    ...stateEntries(input, a, names, true),
    { key: 'copy', label: 'Copy nodes', shortcut: 'Ctrl+C', run: () => a.copy() },
    write(input, {
      key: 'duplicate',
      label: 'Duplicate nodes',
      shortcut: 'Ctrl+D',
      run: () => a.duplicate(),
    }),
    write(input, {
      key: 'tidy-up',
      label: 'Tidy up selection',
      shortcut: 'Shift+Alt+T',
      run: () => a.tidyUp(options.tidy ?? { nodes: names, stickies }),
    }),
  ];
  const second: MenuEntry[] = [];
  if (names.length >= 2 && !options.tidy) {
    const ids = idsOf(input.graph, names);
    const blocked = validateSelectionForGrouping(definitionOf(input.graph), ids, lookupOf(input))[0]?.message;
    second.push({
      key: 'group',
      label: 'Group nodes',
      shortcut: 'Ctrl+G',
      disabled: input.readOnly || Boolean(blocked),
      reason: input.readOnly ? READ_ONLY : blocked,
      run: () => a.group(),
    });
    const extractable =
      !input.readOnly &&
      validateSelectionForExtraction(definitionOf(input.graph), ids, lookupOf(input)).length === 0;
    if (extractable)
      second.push({
        key: 'convert',
        label: 'Convert to sub-workflow',
        shortcut: 'Alt+X',
        run: () => a.convert(),
      });
  }
  const groupIds = groupsOfNodes(input.graph, names);
  return [
    edit,
    [
      ...second,
      ...(options.tidy ? [] : groupEntries(input, a, names)),
      ...groupViewEntries(input, a, groupIds),
    ],
    selectEntries(a),
    [
      write(input, {
        key: 'delete',
        label: 'Delete nodes',
        shortcut: 'Del',
        danger: true,
        run: options.remove ?? (() => a.removeSelection()),
      }),
    ],
  ];
}

const idsOf = (graph: WorkflowGraph, names: string[]) =>
  graph.nodes.filter((n) => names.includes(n.name)).map((n) => n.id);

// ---- a group frame's title -----------------------------------------------------------------------

function groupSections(input: MenuInputs, a: MenuActions, groupId: string): MenuEntry[][] {
  const group = input.graph.nodeGroups.find((g) => g.id === groupId);
  if (!group) return [];
  const members = input.graph.nodes.filter((n) => group.nodeIds.includes(n.id)).map((n) => n.name);
  const head: MenuEntry[] = [
    write(input, { key: 'rename-group', label: 'Rename group', run: () => a.renameGroup(groupId) }),
    write(input, {
      key: 'ungroup',
      label: 'Ungroup',
      shortcut: 'Ctrl+Shift+G',
      run: () => a.ungroup([groupId]),
    }),
    ...groupViewEntries(input, a, [groupId]),
  ];
  const [edit, , select, remove] = multiSections(input, a, members, {
    tidy: { nodes: members },
    remove: () => a.removeNodes(members),
  });
  return [head, edit, select, remove];
}

// ---- a sticky note -------------------------------------------------------------------------------

function stickySections(input: MenuInputs, a: MenuActions, stickyId: string): MenuEntry[][] {
  return [
    [
      write(input, {
        key: 'edit-sticky',
        label: 'Edit sticky note',
        shortcut: 'Enter',
        run: () => a.editSticky(stickyId),
      }),
      write(input, { key: 'change-color', label: 'Change color', run: () => a.colorSticky(stickyId) }),
    ],
    [
      write(input, { key: 'duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', run: () => a.duplicate() }),
      write(input, {
        key: 'delete',
        label: 'Delete',
        shortcut: 'Del',
        danger: true,
        run: () => a.removeSelection(),
      }),
    ],
    selectEntries(a),
  ];
}

// ---- the empty canvas ----------------------------------------------------------------------------

function canvasSections(input: MenuInputs, a: MenuActions, position: [number, number]): MenuEntry[][] {
  const all = input.graph.nodeGroups.map((g) => g.id);
  const view = input.groupView ?? { expanded: [], pinned: [] };
  const groupEntriesAll: MenuEntry[] = [];
  if (all.some((id) => !view.expanded.includes(id)))
    groupEntriesAll.push({
      key: 'expand-all-groups',
      label: 'Expand all groups',
      shortcut: 'Alt+G',
      run: () => a.setGroupsExpanded('all', true),
    });
  if (all.some((id) => view.expanded.includes(id)))
    groupEntriesAll.push({
      key: 'collapse-all-groups',
      label: 'Collapse all groups',
      shortcut: 'Shift+Alt+G',
      run: () => a.setGroupsExpanded('all', false),
    });
  return [
    [
      write(input, { key: 'add-node', label: 'Add node', shortcut: 'N', run: () => a.addNode(position) }),
      write(input, {
        key: 'add-sticky',
        label: 'Add sticky note',
        shortcut: 'Shift+S',
        run: () => a.addSticky(position),
      }),
      write(input, {
        key: 'tidy-up',
        label: 'Tidy up workflow',
        shortcut: 'Shift+Alt+T',
        run: () => a.tidyUp(undefined),
      }),
      ...groupEntriesAll,
    ],
    [{ key: 'select-all', label: 'Select all', shortcut: 'Ctrl+A', run: () => a.selectAll() }],
  ];
}
