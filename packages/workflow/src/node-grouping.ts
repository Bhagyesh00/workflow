/**
 * Canvas group rules (P3-04) and the sub-workflow extraction rules built on them (P3-05).
 * Two rule sets, as n8n's grouping validation:
 * - grouping: no trigger, one connected section with at most one entry and one exit node (many connections
 *   allowed), sub-nodes travel with their parent, stickies ride along, no non-main connection crossing the
 *   border, one group per node; never the single-main-input/output test.
 * - extraction: the grouping rules plus a single main input and a single main output, and no deprecated node.
 * Save-path validation: five basic checks always; the full checks only when every member's type resolves.
 *
 * Signatures are the contract for L4, L5, L2 and the server. Everything here is pure and works on node ids.
 */
import type { NodeTypeDescription, WorkflowDefinition, WorkflowNode } from './interfaces';

/** resolves a node type description (editor: node catalog; server: registry); undefined = unknown type */
export type NodeDescriptionLookup = (type: string, typeVersion?: number) => NodeTypeDescription | undefined;

/** the part of a node type description the grouping and extraction rules read */
export type NodeGroupingTypeInfo = Pick<NodeTypeDescription, 'group' | 'polling' | 'hidden'>;

/** resolves what the grouping rules read of a node type; a NodeDescriptionLookup is one */
export type NodeGroupingLookup = (type: string, typeVersion?: number) => NodeGroupingTypeInfo | undefined;

/**
 * Stands in for a node type a lookup cannot resolve, so the structural checks (one section, one
 * entry, one exit, no AI connection across the border) still run: not a trigger, not deprecated.
 */
export const STRUCTURAL_NODE_TYPE: NodeGroupingTypeInfo = { group: [] };

/** max length of a group description (P3-04 addendum); the server answers 400 above it */
export const GROUP_DESCRIPTION_MAX_LENGTH = 145;

/** the strict rule set (n8n's relaxed, flag-gated rules are off) */
export interface NodeGroupingRules {
  /** a trigger node may be a member */
  allowTriggers: boolean;
  /** nodes that take main input from outside the group */
  maxEntryNodes: number;
  /** nodes that send main output outside the group */
  maxExitNodes: number;
  /** non-main (AI sub-node) connections may cross the group border */
  allowNonMainBoundary: boolean;
  /** groups a node may belong to */
  maxGroupsPerNode: number;
}

export const NODE_GROUPING_RULES: Readonly<NodeGroupingRules> = Object.freeze({
  allowTriggers: false,
  maxEntryNodes: 1,
  maxExitNodes: 1,
  allowNonMainBoundary: false,
  maxGroupsPerNode: 1,
});

export type GroupingProblemCode =
  // selection rules (grouping and extraction)
  | 'trigger'
  | 'disconnected'
  | 'multiple_entry'
  | 'multiple_exit'
  | 'input_to_non_first'
  | 'output_from_non_last'
  | 'no_path_first_to_last'
  | 'non_main_boundary'
  | 'node_in_other_group'
  // extraction only
  | 'multiple_input_branches'
  | 'multiple_output_branches'
  | 'deprecated'
  // save path (validateWorkflowNodeGroups) basic checks
  | 'duplicate_group_id'
  | 'duplicate_group_name'
  | 'empty_group'
  | 'unknown_node'
  | 'node_in_multiple_groups'
  | 'description_too_long'
  // anything else
  | 'generic';

export interface GroupingProblem {
  code: GroupingProblemCode;
  /** user-facing rule text (toast, 400 body) */
  message: string;
  /** node ids the problem is about */
  nodeIds?: string[];
  /** set by validateWorkflowNodeGroups */
  groupId?: string;
}

// ---------------------------------------------------------------------------------------------
// graph helpers (by node id)

interface Link {
  from: string;
  to: string;
  type: string;
  outIndex: number;
  inIndex: number;
}

interface Graph {
  byId: Map<string, WorkflowNode>;
  links: Link[];
  stickyIds: Set<string>;
}

function buildGraph(definition: WorkflowDefinition): Graph {
  const byId = new Map<string, WorkflowNode>();
  const byName = new Map<string, WorkflowNode>();
  for (const n of definition.nodes ?? []) {
    byId.set(n.id, n);
    byName.set(n.name, n);
  }
  const links: Link[] = [];
  for (const [source, perType] of Object.entries(definition.connections ?? {})) {
    const from = byName.get(source);
    if (!from) continue;
    for (const [type, outputs] of Object.entries(perType ?? {})) {
      (outputs ?? []).forEach((list, outIndex) => {
        for (const c of list ?? []) {
          const to = byName.get(c.node);
          if (to) links.push({ from: from.id, to: to.id, type, outIndex, inIndex: c.index ?? 0 });
        }
      });
    }
  }
  const stickyIds = new Set((definition.stickyNotes ?? []).map((s) => s.id));
  return { byId, links, stickyIds };
}

function isTriggerType(d: NodeGroupingTypeInfo): boolean {
  return d.group.includes('trigger') || Boolean(d.polling);
}

const uniq = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** the selection without sticky notes (they ride along) and without ids that are not nodes */
function realNodeIds(graph: Graph, ids: readonly string[]): string[] {
  return uniq(ids).filter((id) => graph.byId.has(id) && !graph.stickyIds.has(id));
}

function names(graph: Graph, ids: readonly string[]): string {
  return ids.map((id) => `"${graph.byId.get(id)?.name ?? id}"`).join(', ');
}

/** the selection plus the AI sub-nodes attached to selected parents (recursive, selection order first) */
function expandIds(graph: Graph, ids: readonly string[]): string[] {
  const out = uniq(ids);
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) {
    for (const l of graph.links) {
      if (l.type !== 'main' && l.to === out[i] && !seen.has(l.from)) {
        seen.add(l.from);
        out.push(l.from);
      }
    }
  }
  return out;
}

/** can `from` reach `to` over main links inside `members`? */
function mainPath(graph: Graph, members: Set<string>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === to) return true;
    for (const l of graph.links) {
      if (l.type === 'main' && l.from === cur && members.has(l.to) && !seen.has(l.to)) {
        seen.add(l.to);
        stack.push(l.to);
      }
    }
  }
  return false;
}

/** one connected piece, counting links of every type (sub-nodes hang off their parent) */
function isConnected(graph: Graph, members: string[]): boolean {
  if (members.length <= 1) return true;
  const set = new Set(members);
  const seen = new Set([members[0]]);
  const stack = [members[0]];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const l of graph.links) {
      const other = l.from === cur ? l.to : l.to === cur ? l.from : undefined;
      if (other !== undefined && set.has(other) && !seen.has(other)) {
        seen.add(other);
        stack.push(other);
      }
    }
  }
  return seen.size === set.size;
}

const MESSAGES = {
  empty: 'Select at least one node.',
  trigger: 'A trigger node cannot be part of a group. Remove the trigger from the selection.',
  disconnected:
    'The selected nodes must form one connected section. Select nodes that are connected to each other.',
  multipleEntry:
    'Only one node of the selection may receive input from nodes outside it. Select a section with a single entry node.',
  multipleExit:
    'Only one node of the selection may send output to nodes outside it. Select a section with a single exit node.',
  inputToNonFirst: 'Nodes outside the selection may only connect to the first node of the selection.',
  outputFromNonLast: 'Only the last node of the selection may connect to nodes outside it.',
  noPath: 'The selection needs a path from its first node to its last node.',
  nonMain:
    'A connection other than a main connection (such as an AI model, tool or memory) crosses the border of the selection. Select the node together with the nodes attached to it.',
  otherGroup: 'A selected node already belongs to another group.',
  multipleInput:
    'The selection has more than one input. A sub-workflow takes one input: select a section with a single input.',
  multipleOutput:
    'The selection has more than one output. A sub-workflow returns one output: select a section with a single output.',
  deprecated: 'A deprecated node cannot be moved to a sub-workflow.',
} as const;

function selectionProblems(
  definition: WorkflowDefinition,
  graph: Graph,
  members: string[],
  types: NodeGroupingLookup | undefined,
  opts: { checkOtherGroups: boolean; extraction: boolean },
): GroupingProblem[] {
  const problems: GroupingProblem[] = [];
  if (members.length === 0) return [{ code: 'generic', message: MESSAGES.empty }];
  const set = new Set(members);
  const describe = (id: string) => {
    const n = graph.byId.get(id) as WorkflowNode;
    return types?.(n.type, n.typeVersion);
  };

  if (types && !NODE_GROUPING_RULES.allowTriggers) {
    const triggers = members.filter((id) => {
      const d = describe(id);
      return d ? isTriggerType(d) : false;
    });
    if (triggers.length) {
      problems.push({
        code: 'trigger',
        message: `${MESSAGES.trigger} (${names(graph, triggers)})`,
        nodeIds: triggers,
      });
    }
  }

  if (opts.checkOtherGroups) {
    const taken = new Set<string>();
    for (const grp of definition.nodeGroups ?? []) for (const id of grp.nodeIds) taken.add(id);
    const clash = members.filter((id) => taken.has(id));
    if (clash.length) {
      problems.push({
        code: 'node_in_other_group',
        message: `${MESSAGES.otherGroup} (${names(graph, clash)})`,
        nodeIds: clash,
      });
    }
  }

  if (!isConnected(graph, members)) problems.push({ code: 'disconnected', message: MESSAGES.disconnected });

  if (!NODE_GROUPING_RULES.allowNonMainBoundary) {
    const crossing = graph.links.filter((l) => l.type !== 'main' && set.has(l.from) !== set.has(l.to));
    if (crossing.length) {
      problems.push({
        code: 'non_main_boundary',
        message: MESSAGES.nonMain,
        nodeIds: uniq(crossing.flatMap((l) => [l.from, l.to])),
      });
    }
  }

  // main links crossing the border and main links inside it
  const inbound = graph.links.filter((l) => l.type === 'main' && !set.has(l.from) && set.has(l.to));
  const outbound = graph.links.filter((l) => l.type === 'main' && set.has(l.from) && !set.has(l.to));
  const inside = graph.links.filter((l) => l.type === 'main' && set.has(l.from) && set.has(l.to));
  const entries = uniq(inbound.map((l) => l.to));
  const exits = uniq(outbound.map((l) => l.from));
  let shapeOk = true;
  if (entries.length > NODE_GROUPING_RULES.maxEntryNodes) {
    shapeOk = false;
    problems.push({
      code: 'multiple_entry',
      message: `${MESSAGES.multipleEntry} (${names(graph, entries)})`,
      nodeIds: entries,
    });
  }
  if (exits.length > NODE_GROUPING_RULES.maxExitNodes) {
    shapeOk = false;
    problems.push({
      code: 'multiple_exit',
      message: `${MESSAGES.multipleExit} (${names(graph, exits)})`,
      nodeIds: exits,
    });
  }
  if (shapeOk) {
    // first node = head of the section, last node = its tail (no main link from / to another member)
    const heads = members.filter((id) => !inside.some((l) => l.to === id && l.from !== id));
    const tails = members.filter((id) => !inside.some((l) => l.from === id && l.to !== id));
    const entry = entries[0];
    const exit = exits[0];
    let positionOk = true;
    if (entry !== undefined && heads.length > 0 && !heads.includes(entry)) {
      positionOk = false;
      problems.push({
        code: 'input_to_non_first',
        message: `${MESSAGES.inputToNonFirst} (${names(graph, [entry])})`,
        nodeIds: [entry],
      });
    }
    if (exit !== undefined && tails.length > 0 && !tails.includes(exit)) {
      positionOk = false;
      problems.push({
        code: 'output_from_non_last',
        message: `${MESSAGES.outputFromNonLast} (${names(graph, [exit])})`,
        nodeIds: [exit],
      });
    }
    if (positionOk) {
      const first = entry ?? (heads.length === 1 ? heads[0] : undefined);
      const last = exit ?? (tails.length === 1 ? tails[0] : undefined);
      if (first !== undefined && last !== undefined && !mainPath(graph, set, first, last)) {
        problems.push({ code: 'no_path_first_to_last', message: MESSAGES.noPath, nodeIds: [first, last] });
      }
    }
  }

  if (opts.extraction) {
    // one input slot and one output slot: several sources into the same input are fine (all rewired)
    if (uniq(inbound.map((l) => `${l.to}:${l.inIndex}`)).length > 1) {
      problems.push({ code: 'multiple_input_branches', message: MESSAGES.multipleInput, nodeIds: entries });
    }
    if (uniq(outbound.map((l) => `${l.from}:${l.outIndex}`)).length > 1) {
      problems.push({ code: 'multiple_output_branches', message: MESSAGES.multipleOutput, nodeIds: exits });
    }
    if (types) {
      // a node type hidden from the node creator is the deprecated kind
      const old = members.filter((id) => describe(id)?.hidden === true);
      if (old.length) {
        problems.push({
          code: 'deprecated',
          message: `${MESSAGES.deprecated} (${names(graph, old)})`,
          nodeIds: old,
        });
      }
    }
  }
  return problems;
}

/** problems that block grouping the selected node ids; [] = allowed */
export function validateSelectionForGrouping(
  definition: WorkflowDefinition,
  nodeIds: readonly string[],
  types?: NodeGroupingLookup,
): GroupingProblem[] {
  const graph = buildGraph(definition);
  const members = expandIds(graph, realNodeIds(graph, nodeIds));
  return selectionProblems(definition, graph, members, types, { checkOtherGroups: true, extraction: false });
}

/** problems that block converting the selected node ids to a sub-workflow; [] = allowed */
export function validateSelectionForExtraction(
  definition: WorkflowDefinition,
  nodeIds: readonly string[],
  types?: NodeGroupingLookup,
): GroupingProblem[] {
  const graph = buildGraph(definition);
  const members = expandIds(graph, realNodeIds(graph, nodeIds));
  return selectionProblems(definition, graph, members, types, { checkOtherGroups: false, extraction: true });
}

/** save-path check of `definition.nodeGroups`; [] = valid */
export function validateWorkflowNodeGroups(
  definition: WorkflowDefinition,
  types?: NodeGroupingLookup,
): GroupingProblem[] {
  const groups = definition.nodeGroups ?? [];
  if (groups.length === 0) return [];
  const graph = buildGraph(definition);
  const problems: GroupingProblem[] = [];
  const idCount = new Map<string, number>();
  const nameCount = new Map<string, number>();
  for (const g of groups) {
    idCount.set(g.id, (idCount.get(g.id) ?? 0) + 1);
    nameCount.set(g.name, (nameCount.get(g.name) ?? 0) + 1);
  }
  const owners = new Map<string, number>();
  for (const g of groups) for (const id of uniq(g.nodeIds)) owners.set(id, (owners.get(id) ?? 0) + 1);

  const reportedIds = new Set<string>();
  const reportedNames = new Set<string>();
  for (const g of groups) {
    const label = `Group "${g.name}"`;
    const before = problems.length;
    if ((idCount.get(g.id) ?? 0) > 1 && !reportedIds.has(g.id)) {
      reportedIds.add(g.id);
      problems.push({
        code: 'duplicate_group_id',
        message: `Two groups share the id "${g.id}".`,
        groupId: g.id,
      });
    }
    if ((nameCount.get(g.name) ?? 0) > 1 && !reportedNames.has(g.name)) {
      reportedNames.add(g.name);
      problems.push({
        code: 'duplicate_group_name',
        message: `Two groups are named "${g.name}". Group names must be unique.`,
        groupId: g.id,
      });
    }
    if (g.nodeIds.length === 0) {
      problems.push({ code: 'empty_group', message: `${label} has no nodes.`, groupId: g.id });
    }
    const unknown = g.nodeIds.filter((id) => !graph.byId.has(id) && !graph.stickyIds.has(id));
    if (unknown.length) {
      problems.push({
        code: 'unknown_node',
        message: `${label} lists a node that is not in the workflow.`,
        nodeIds: unknown,
        groupId: g.id,
      });
    }
    const shared = uniq(g.nodeIds).filter((id) => (owners.get(id) ?? 0) > 1);
    if (shared.length) {
      problems.push({
        code: 'node_in_multiple_groups',
        message: `${label} shares a node with another group. A node can be in one group only.`,
        nodeIds: shared,
        groupId: g.id,
      });
    }
    if (typeof g.description === 'string' && g.description.length > GROUP_DESCRIPTION_MAX_LENGTH) {
      problems.push({
        code: 'description_too_long',
        message: `${label} has a description longer than ${GROUP_DESCRIPTION_MAX_LENGTH} characters.`,
        groupId: g.id,
      });
    }
    // the full checks run when this group passed the basic ones and every member's type resolves
    if (problems.length !== before || !types) continue;
    const members = realNodeIds(graph, g.nodeIds);
    const resolved = members.every((id) => {
      const n = graph.byId.get(id) as WorkflowNode;
      return types(n.type, n.typeVersion) !== undefined;
    });
    if (!resolved || members.length === 0) continue;
    for (const p of selectionProblems(definition, graph, members, types, {
      checkOtherGroups: false,
      extraction: false,
    })) {
      problems.push({ ...p, message: `${label}: ${p.message}`, groupId: g.id });
    }
  }
  return problems;
}

/** the selection plus the AI sub-nodes attached to selected parents (node ids, selection order first) */
export function expandSelectionWithSubNodes(
  definition: WorkflowDefinition,
  nodeIds: readonly string[],
): string[] {
  return expandIds(buildGraph(definition), nodeIds);
}

/** trimmed description, or undefined when empty */
export function normalizeGroupDescription(description: string | null | undefined): string | undefined {
  const text = typeof description === 'string' ? description.trim() : '';
  return text === '' ? undefined : text;
}
