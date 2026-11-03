/**
 * Convert a node selection to a sub-workflow (P3-05), as n8n's workflow extraction: the new workflow is
 * "Start" (Execute Workflow Trigger) -> selected nodes -> optional "End" Merge -> optional "Return" Set
 * node; the parent gets one "Call <name>" Execute Workflow node at the selection's average position,
 * rewired, with cross-boundary `$('Node')` references mapped. Pure: the caller creates and publishes the
 * new workflow.
 *
 * Output: a called workflow returns output 0 of the node that ran last. When the items leave the
 * selection from a later output (an IF false branch) or the section has other last nodes that may run
 * after the exit, the "End" Merge outputs the exit's items after everything else has run.
 *
 * Expressions:
 * - inner nodes that read outside nodes (`$('Outside').item.json.a`, `.first()`, `.last()`, `.all()`,
 *   `.itemMatching(n)`, `.params`, `.isExecuted`, `$node["Outside"]`, `$items("Outside")`) read a typed
 *   Start input instead (type any); the Call node sends the original expression as that input. Once
 *   typed inputs exist, `$json` / `$input` reads of the first node become inputs too (Start then only
 *   emits the declared fields). Without outside reads Start passes the items through unchanged.
 * - outside nodes that read the last inner node read the Call node (its output is that node's output);
 *   reads of other inner nodes go through a "Return" Set node that adds them as fields.
 * Strings starting with `=` and Code `jsCode` are rewritten, at any depth of the parameters.
 */
import type {
  Connection,
  Connections,
  ConnectionType,
  Item,
  NodeParameters,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeGroup,
  WorkflowSettings,
} from './interfaces';
import {
  expandSelectionWithSubNodes,
  type GroupingProblem,
  type NodeDescriptionLookup,
  validateSelectionForExtraction,
  validateWorkflowNodeGroups,
} from './node-grouping';

export interface ExtractSubWorkflowInput {
  definition: WorkflowDefinition;
  /** selected node ids (expanded with sub-nodes inside) */
  nodeIds: string[];
  /** name of the new workflow */
  name: string;
  /** id the new workflow will get; used in the Execute Workflow node's workflow reference */
  newWorkflowId?: string;
  /** node types for the extraction rules (trigger, deprecated, sub-nodes) */
  types?: NodeDescriptionLookup;
}

export interface ExtractionResult {
  /** the new workflow's body */
  subWorkflow: {
    name: string;
    nodes: WorkflowNode[];
    connections: Connections;
    settings: WorkflowSettings;
    pinData?: Record<string, Item[]>;
  };
  /** the parent after the conversion */
  parent: {
    nodes: WorkflowNode[];
    connections: Connections;
    pinData?: Record<string, Item[]>;
    nodeGroups?: WorkflowNodeGroup[];
  };
  /** name of the Execute Workflow node added to the parent */
  executeNodeName: string;
}

/** thrown when the selection breaks an extraction rule; `problems` holds every broken rule */
export class SubWorkflowExtractionError extends Error {
  readonly problems: GroupingProblem[];
  constructor(problems: GroupingProblem[]) {
    super(problems.map((p) => p.message).join(' '));
    this.name = 'SubWorkflowExtractionError';
    this.problems = problems;
  }
}

export const SUBWORKFLOW_TRIGGER_TYPE = 'core.executeWorkflowTrigger';
export const EXECUTE_WORKFLOW_TYPE = 'core.executeWorkflow';
const RETURN_NODE_TYPE = 'core.set';
/** Merge that outputs the exit's items once the rest of the section has run */
const END_NODE_TYPE = 'core.merge';
/** most inputs a Merge node has */
const END_NODE_MAX_INPUTS = 10;
/** distance between the Start / Return node and the node next to it */
const NODE_OFFSET = 220;

// ---------------------------------------------------------------------------------------------
// references in expressions

type Accessor = 'item' | 'first' | 'last' | 'all' | 'itemMatching' | 'params' | 'isExecuted';

interface Reference {
  /** referenced node name; undefined for `$json` / `$input` */
  node?: string;
  accessor: Accessor;
  /** argument of itemMatching(n) */
  index?: number;
  /** `.json` follows the accessor */
  json: boolean;
  /** property path after `.json` */
  path: string[];
  /** the reference as written (head, accessor, `.json` and path) */
  text: string;
  /** end of the head (`$('Name')`, `$node["Name"]`, `$items("Name")`) inside `text` */
  headLength: number;
  headKind: 'call' | 'node' | 'items' | 'json' | 'input';
}

const HEAD =
  /\$\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)|\$node\[\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3\s*\]|\$node\.([A-Za-z_$][\w$]*)|\$items\(\s*(['"`])((?:\\.|(?!\6)[^\\])*)\6\s*\)/g;
const INPUT_HEAD = /(?<![\w$.])\$(json|input)\b/g;

const unescapeName = (value: string) => value.replace(/\\(.)/g, '$1');

/** `.json` and identifier segments after it; a segment followed by `(` is a method call and stops the path */
function readJsonPath(text: string, from: number): { json: boolean; path: string[]; end: number } {
  const json = /^\.json\b(?!\s*\()/.exec(text.slice(from));
  if (!json) return { json: false, path: [], end: from };
  let end = from + json[0].length;
  const path: string[] = [];
  for (;;) {
    const seg = /^\.([A-Za-z_$][\w$]*)/.exec(text.slice(end));
    if (!seg) break;
    const after = end + seg[0].length;
    if (/^\s*\(/.test(text.slice(after))) break;
    path.push(seg[1]);
    end = after;
  }
  return { json: true, path, end };
}

/** the accessor of `$('Name')` / `$input`; undefined when it is not one we can map */
function readAccessor(
  text: string,
  from: number,
  allowed: readonly Accessor[],
): { accessor: Accessor; index?: number; end: number } | undefined {
  const rest = text.slice(from);
  const forms: Array<[Accessor, RegExp]> = [
    ['item', /^\.item\b(?!\s*\()/],
    ['first', /^\.first\(\s*\)/],
    ['last', /^\.last\(\s*\)/],
    ['all', /^\.all\(\s*\)/],
    ['itemMatching', /^\.itemMatching\(\s*(\d+)\s*\)/],
    ['params', /^\.params\b(?!\s*\()/],
    ['isExecuted', /^\.isExecuted\b(?!\s*\()/],
  ];
  for (const [accessor, re] of forms) {
    if (!allowed.includes(accessor)) continue;
    const m = re.exec(rest);
    if (m) return { accessor, index: m[1] === undefined ? undefined : Number(m[1]), end: from + m[0].length };
  }
  return undefined;
}

const PATH_ACCESSORS: readonly Accessor[] = ['item', 'first', 'last', 'itemMatching'];

/** references to `names` in `text` (non-overlapping, left to right) */
function findNodeReferences(text: string, names: ReadonlySet<string>): Array<Reference & { start: number }> {
  const out: Array<Reference & { start: number }> = [];
  for (const m of text.matchAll(HEAD)) {
    const start = m.index ?? 0;
    const headEnd = start + m[0].length;
    let node: string;
    let headKind: Reference['headKind'];
    if (m[2] !== undefined) {
      node = unescapeName(m[2]);
      headKind = 'call';
    } else if (m[4] !== undefined) {
      node = unescapeName(m[4]);
      headKind = 'node';
    } else if (m[5] !== undefined) {
      node = m[5];
      headKind = 'node';
    } else {
      node = unescapeName(m[7] ?? '');
      headKind = 'items';
    }
    if (!names.has(node)) continue;
    let ref: Reference | undefined;
    if (headKind === 'call') {
      const acc = readAccessor(text, headEnd, [
        'item',
        'first',
        'last',
        'all',
        'itemMatching',
        'params',
        'isExecuted',
      ]);
      if (!acc) continue;
      const p = PATH_ACCESSORS.includes(acc.accessor)
        ? readJsonPath(text, acc.end)
        : { json: false, path: [], end: acc.end };
      ref = {
        node,
        accessor: acc.accessor,
        index: acc.index,
        json: p.json,
        path: p.path,
        text: text.slice(start, p.end),
        headLength: m[0].length,
        headKind,
      };
    } else if (headKind === 'node') {
      const p = readJsonPath(text, headEnd);
      if (p.json) {
        ref = {
          node,
          accessor: 'item',
          json: true,
          path: p.path,
          text: text.slice(start, p.end),
          headLength: m[0].length,
          headKind,
        };
      } else {
        const param = /^\.parameter\b(?!\s*\()/.exec(text.slice(headEnd));
        if (!param) continue;
        ref = {
          node,
          accessor: 'params',
          json: false,
          path: [],
          text: text.slice(start, headEnd + param[0].length),
          headLength: m[0].length,
          headKind,
        };
      }
    } else {
      ref = { node, accessor: 'all', json: false, path: [], text: m[0], headLength: m[0].length, headKind };
    }
    out.push({ ...ref, start });
  }
  return out;
}

/** `$json...` and `$input.item / first() / last() / all()` reads in `text` */
function findInputReferences(text: string): Array<Reference & { start: number }> {
  const out: Array<Reference & { start: number }> = [];
  for (const m of text.matchAll(INPUT_HEAD)) {
    const start = m.index ?? 0;
    const headEnd = start + m[0].length;
    if (m[1] === 'json') {
      const p = /^\.\s*\(/.test(text.slice(headEnd))
        ? undefined
        : readJsonPath(`.json${text.slice(headEnd)}`, 0);
      if (!p) continue;
      const end = headEnd + p.end - '.json'.length;
      out.push({
        accessor: 'item',
        json: true,
        path: p.path,
        text: text.slice(start, end),
        headLength: m[0].length,
        headKind: 'json',
        start,
      });
      continue;
    }
    const acc = readAccessor(text, headEnd, ['item', 'first', 'last', 'all']);
    if (!acc) continue;
    const p = acc.accessor === 'all' ? { json: false, path: [], end: acc.end } : readJsonPath(text, acc.end);
    out.push({
      accessor: acc.accessor,
      json: p.json,
      path: p.path,
      text: text.slice(start, p.end),
      headLength: m[0].length,
      headKind: 'input',
      start,
    });
  }
  return out;
}

/** replace each reference found in `text` by `replace(ref)` (undefined keeps it) */
function rewriteText(
  text: string,
  find: (text: string) => Array<Reference & { start: number }>,
  replace: (ref: Reference) => string | undefined,
): string {
  let out = '';
  let cursor = 0;
  for (const ref of find(text)) {
    if (ref.start < cursor) continue;
    const next = replace(ref);
    if (next === undefined) continue;
    out += text.slice(cursor, ref.start) + next;
    cursor = ref.start + ref.text.length;
  }
  return out + text.slice(cursor);
}

const CODE_KEYS = new Set(['jsCode']);

/** rewrite expression strings (`=...`) and Code at any depth */
function rewriteParameters(value: unknown, rewrite: (text: string) => string, key?: string): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('=') || (key !== undefined && CODE_KEYS.has(key))) return rewrite(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteParameters(v, rewrite));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteParameters(v, rewrite, k)]));
  }
  return value;
}

function sanitize(label: string): string {
  const cleaned = label.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_$]/g, '');
  if (!cleaned) return 'value';
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}

const SUFFIX: Record<Accessor, string> = {
  item: '',
  first: 'firstItem',
  last: 'lastItem',
  all: 'allItems',
  itemMatching: 'itemMatching',
  params: 'params',
  isExecuted: 'isExecuted',
};

function suffixOf(ref: Reference): string {
  return ref.accessor === 'itemMatching' ? `itemMatching_${ref.index}` : SUFFIX[ref.accessor];
}

/** variable name of a reference: its path (plus accessor suffix), else the node name (plus suffix) */
function baseName(ref: Reference, owner: string, prefixed: boolean): string {
  const suffix = suffixOf(ref);
  const path = ref.path.map(sanitize).join('_');
  if (path) {
    const name = suffix ? `${path}_${suffix}` : path;
    return prefixed ? `${owner}_${name}` : name;
  }
  if (suffix) return `${owner}_${suffix}`;
  return ref.json ? owner : `${owner}_item`;
}

/** a per-item read: `.item` (and `$node[...].json`, `$json`, `$input.item`); every other accessor reads first() */
const isPerItem = (ref: Reference) => ref.accessor === 'item';

interface Variable {
  name: string;
  /** the original read, evaluated where the data is (Call node inputs, Return node fields) */
  expression: string;
}

/** variables keyed by what they read, so `$('A').all()` and `$items('A')` share one */
class Variables {
  readonly list: Variable[] = [];
  private readonly byKey = new Map<string, Variable>();
  private readonly taken = new Set<string>();

  constructor(private readonly prefixed: boolean) {}

  get size(): number {
    return this.list.length;
  }

  add(ref: Reference): string {
    const owner = ref.node === undefined ? 'input' : sanitize(ref.node);
    const key = JSON.stringify([ref.node ?? null, ref.accessor, ref.index ?? null, ref.json, ref.path]);
    const known = this.byKey.get(key);
    if (known) return known.name;
    let name = baseName(ref, owner, this.prefixed);
    if (this.taken.has(name)) name = `${owner}_${name}`;
    if (this.taken.has(name)) {
      let i = 1;
      while (this.taken.has(`${name}_${i}`)) i++;
      name = `${name}_${i}`;
    }
    const variable = { name, expression: ref.text };
    this.taken.add(name);
    this.byKey.set(key, variable);
    this.list.push(variable);
    return name;
  }
}

const quoteName = (name: string) => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** read of a variable through node `via` */
function variableRead(via: string, ref: Reference, variable: string): string {
  return `$(${quoteName(via)})${isPerItem(ref) ? '.item' : '.first()'}.json.${variable}`;
}

/** read of a variable the Start node emits, from the first node ($json / $input stay as they are) */
function inputRead(ref: Reference, variable: string): string {
  if (ref.headKind === 'json') return `$json.${variable}`;
  return `$input${isPerItem(ref) ? '.item' : '.first()'}.json.${variable}`;
}

/** the same read with the node head pointed at `name` */
function renameHead(ref: Reference, name: string): string {
  const rest = ref.text.slice(ref.headLength);
  if (ref.headKind === 'node') return `$node[${JSON.stringify(name)}]${rest}`;
  if (ref.headKind === 'items') return `$items(${quoteName(name)})`;
  return `$(${quoteName(name)})${rest}`;
}

// ---------------------------------------------------------------------------------------------
// graph helpers

interface Link {
  from: string;
  type: ConnectionType;
  outIndex: number;
  to: string;
  inIndex: number;
}

function linksOf(connections: Connections): Link[] {
  const links: Link[] = [];
  for (const [from, byType] of Object.entries(connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType ?? {}) as Array<
      [ConnectionType, Array<Connection[] | null>]
    >) {
      (outputs ?? []).forEach((list, outIndex) => {
        for (const c of list ?? []) links.push({ from, type, outIndex, to: c.node, inIndex: c.index ?? 0 });
      });
    }
  }
  return links;
}

function addLink(target: Connections, link: Link): void {
  const outputs = ((target[link.from] ??= {})[link.type] ??= []);
  while (outputs.length <= link.outIndex) outputs.push([]);
  const list = (outputs[link.outIndex] ??= []);
  if (!list.some((c) => c.node === link.to && c.index === link.inIndex && c.type === link.type)) {
    list.push({ node: link.to, type: link.type, index: link.inIndex });
  }
}

function uniqueName(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  let i = 1;
  while (taken.has(`${wanted}_${i}`)) i++;
  return `${wanted}_${i}`;
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const topmost = (nodes: WorkflowNode[]) =>
  [...nodes].sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0])[0];

// ---------------------------------------------------------------------------------------------

/** throws SubWorkflowExtractionError when the selection breaks an extraction rule */
export function extractSubWorkflow(input: ExtractSubWorkflowInput): ExtractionResult {
  const { definition, name, newWorkflowId, types } = input;
  const nodes = definition.nodes ?? [];
  const connections = definition.connections ?? {};
  const known = new Set(nodes.map((n) => n.id));
  const selected = expandSelectionWithSubNodes(definition, input.nodeIds).filter((id) => known.has(id));
  const problems = validateSelectionForExtraction(definition, selected, types);
  if (problems.length) throw new SubWorkflowExtractionError(problems);

  const insideIds = new Set(selected);
  const inside = nodes.filter((n) => insideIds.has(n.id));
  const outside = nodes.filter((n) => !insideIds.has(n.id));
  const insideNames = new Set(inside.map((n) => n.name));
  const outsideNames = new Set(outside.map((n) => n.name));
  const byName = new Map(nodes.map((n) => [n.name, n]));

  const links = linksOf(connections);
  const isIn = (nodeName: string) => insideNames.has(nodeName);
  const inbound = links.filter((l) => l.type === 'main' && !isIn(l.from) && isIn(l.to));
  const outbound = links.filter((l) => l.type === 'main' && isIn(l.from) && !isIn(l.to));
  const internal = links.filter((l) => isIn(l.from) && isIn(l.to));
  // AI sub-nodes feed their parent over non-main links; they are never first or last
  const subNodes = new Set(internal.filter((l) => l.type !== 'main').map((l) => l.from));
  const flowNodes = inside.filter((n) => !subNodes.has(n.name));

  // first node(s): the entry, else the heads of the section
  const starts: Array<{ node: string; index: number }> = inbound.length
    ? [{ node: inbound[0].to, index: inbound[0].inIndex }]
    : flowNodes
        .filter((n) => !internal.some((l) => l.type === 'main' && l.to === n.name && l.from !== n.name))
        .map((n) => ({ node: n.name, index: 0 }));
  // last node: the exit, else the only tail (topmost of several)
  const tails = flowNodes.filter(
    (n) => !internal.some((l) => l.type === 'main' && l.from === n.name && l.to !== n.name),
  );
  const exit = outbound.length
    ? { node: outbound[0].from, index: outbound[0].outIndex }
    : tails.length
      ? { node: topmost(tails).name, index: 0 }
      : undefined;
  const exitName = outbound.length ? outbound[0].from : undefined;
  // end nodes besides the exit; the End node below waits for them
  const otherTails = exitName ? tails.filter((t) => t.name !== exitName) : [];
  if (otherTails.length + 2 > END_NODE_MAX_INPUTS) {
    throw new SubWorkflowExtractionError([
      {
        code: 'generic',
        message: `The selection ends in ${otherTails.length + 1} nodes. Select a part that ends in at most ${END_NODE_MAX_INPUTS - 1} nodes.`,
        nodeIds: otherTails.map((t) => t.id),
      },
    ]);
  }

  // --- the new workflow --------------------------------------------------------------------
  const startName = uniqueName('Start', insideNames);
  const inputs = new Variables(false);
  let subNodesRewritten = inside.map((n) => ({
    ...n,
    parameters: rewriteParameters(n.parameters, (text) =>
      rewriteText(
        text,
        (t) => findNodeReferences(t, outsideNames),
        (ref) => variableRead(startName, ref, inputs.add(ref)),
      ),
    ) as NodeParameters,
  }));
  if (inputs.size > 0) {
    // typed Start: the first node's own input reads become inputs too
    const firstNames = new Set(starts.map((s) => s.node));
    subNodesRewritten = subNodesRewritten.map((n) =>
      firstNames.has(n.name)
        ? {
            ...n,
            parameters: rewriteParameters(n.parameters, (text) =>
              rewriteText(text, findInputReferences, (ref) => inputRead(ref, inputs.add(ref))),
            ) as NodeParameters,
          }
        : n,
    );
  }

  const firstNode = byName.get(starts[0]?.node ?? '') ?? topmost(flowNodes.length ? flowNodes : inside);
  const startNode: WorkflowNode = {
    id: newId(),
    name: startName,
    type: SUBWORKFLOW_TRIGGER_TYPE,
    typeVersion: 1,
    position: [firstNode.position[0] - NODE_OFFSET, firstNode.position[1]],
    parameters:
      inputs.size > 0
        ? {
            inputSource: 'workflowInputs',
            workflowInputs: { values: inputs.list.map((v) => ({ name: v.name, type: 'any' })) },
          }
        : { inputSource: 'passthrough' },
  };

  // --- the parent ----------------------------------------------------------------------------
  const callName = uniqueName(`Call ${name}`, new Set([...outsideNames, ...insideNames]));
  const returns = new Variables(true);
  const parentNodes = outside.map((n) => ({
    ...n,
    parameters: rewriteParameters(n.parameters, (text) =>
      rewriteText(
        text,
        (t) => findNodeReferences(t, insideNames),
        (ref) => {
          // the Call node outputs what the last node output
          if (ref.node === exitName && ref.accessor !== 'params' && ref.accessor !== 'isExecuted') {
            return renameHead(ref, callName);
          }
          return variableRead(callName, ref, returns.add(ref));
        },
      ),
    ) as NodeParameters,
  }));

  const subConnections: Connections = {};
  for (const l of internal) addLink(subConnections, l);
  for (const s of starts)
    addLink(subConnections, { from: startName, type: 'main', outIndex: 0, to: s.node, inIndex: s.index });

  const subWorkflowNodes: WorkflowNode[] = [startNode, ...subNodesRewritten];
  const taken = new Set([...insideNames, startName]);
  // The engine returns the output 0 of the node that ran last. When the selection's items leave from a
  // later output (IF false) or another end node of the section may run after the exit, an "End" Merge
  // outputs the exit's items. It waits for the exit, for Start (so it also runs when the exit sends
  // nothing) and for every other end node (so it runs after them, at the latest when nothing else is
  // left to run).
  let last: { node: WorkflowNode; index: number } = {
    node: byName.get(exit?.node ?? '') ?? topmost(inside),
    index: exit?.index ?? 0,
  };
  if (exitName && (last.index !== 0 || otherTails.length > 0)) {
    const endName = uniqueName('End', taken);
    taken.add(endName);
    const feeds = [
      { from: last.node.name, outIndex: last.index },
      { from: startName, outIndex: 0 },
      ...otherTails.map((t) => ({ from: t.name, outIndex: 0 })),
    ];
    subWorkflowNodes.push({
      id: newId(),
      name: endName,
      type: END_NODE_TYPE,
      typeVersion: 1,
      position: [last.node.position[0] + NODE_OFFSET, last.node.position[1]],
      parameters: {
        mode: 'chooseBranch',
        numberInputs: feeds.length,
        chooseBranchMode: 'specifiedInput',
        useDataOfInput: 1,
        options: {},
      },
    });
    for (const [inIndex, f] of feeds.entries()) {
      addLink(subConnections, { from: f.from, type: 'main', outIndex: f.outIndex, to: endName, inIndex });
    }
    last = { node: subWorkflowNodes[subWorkflowNodes.length - 1], index: 0 };
  }
  if (returns.size > 0) {
    const returnName = uniqueName('Return', taken);
    subWorkflowNodes.push({
      id: newId(),
      name: returnName,
      type: RETURN_NODE_TYPE,
      typeVersion: 1,
      position: [last.node.position[0] + NODE_OFFSET, last.node.position[1]],
      parameters: {
        mode: 'manual',
        assignments: {
          assignments: returns.list.map((v) => ({
            id: newId(),
            name: v.name,
            value: `={{ ${v.expression} }}`,
          })),
        },
        // keep the last node's fields: the Call node's output stays what that node output
        includeOtherFields: true,
        options: {},
      },
    });
    addLink(subConnections, {
      from: last.node.name,
      type: 'main',
      outIndex: last.index,
      to: returnName,
      inIndex: 0,
    });
  }

  const callId = newId();
  const sumX = inside.reduce((acc, n) => acc + n.position[0], 0);
  const sumY = inside.reduce((acc, n) => acc + n.position[1], 0);
  const callNode: WorkflowNode = {
    id: callId,
    name: callName,
    type: EXECUTE_WORKFLOW_TYPE,
    typeVersion: 1,
    position: [Math.round(sumX / inside.length), Math.round(sumY / inside.length)],
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'list', value: newWorkflowId ?? '', cachedResultName: name },
      mode: 'once',
      ...(inputs.size > 0
        ? {
            workflowInputs: {
              values: inputs.list.map((v) => ({ name: v.name, value: `={{ ${v.expression} }}` })),
            },
          }
        : {}),
      options: {},
    },
  };

  // keep the parent's connection lists as they are; links into the selection go to the Call node,
  // links out of it leave from the Call node's only output
  const parentConnections: Connections = {};
  for (const [from, byType] of Object.entries(connections)) {
    if (isIn(from)) continue;
    const next: Connections[string] = {};
    for (const [type, outputs] of Object.entries(byType ?? {}) as Array<
      [ConnectionType, Array<Connection[] | null>]
    >) {
      next[type] = (outputs ?? []).map((list) => {
        if (!list) return list;
        const kept: Connection[] = [];
        for (const c of list) {
          const target = isIn(c.node) ? { node: callName, type: 'main' as const, index: 0 } : c;
          if (
            !kept.some((k) => k.node === target.node && k.index === target.index && k.type === target.type)
          ) {
            kept.push(target);
          }
        }
        return kept;
      });
    }
    parentConnections[from] = next;
  }
  for (const l of outbound) {
    addLink(parentConnections, { from: callName, type: 'main', outIndex: 0, to: l.to, inIndex: l.inIndex });
  }

  const pinData = definition.pinData
    ? Object.fromEntries(Object.entries(definition.pinData).filter(([k]) => !isIn(k)))
    : undefined;

  const finalNodes = [...parentNodes, callNode];
  return {
    subWorkflow: {
      name,
      nodes: subWorkflowNodes,
      connections: subConnections,
      settings: { executionOrder: 'v1' },
    },
    parent: {
      nodes: finalNodes,
      connections: parentConnections,
      ...(pinData ? { pinData } : {}),
      ...(definition.nodeGroups
        ? {
            nodeGroups: regroup(
              definition.nodeGroups,
              insideIds,
              callId,
              { ...definition, nodes: finalNodes, connections: parentConnections },
              types,
            ),
          }
        : {}),
    },
    executeNodeName: callName,
  };
}

/**
 * Groups after the swap, as n8n: a group moved whole is removed; when the moved nodes came from one
 * group that keeps members, the Call node joins it; a touched group the rules no longer accept is
 * dissolved.
 */
function regroup(
  groups: WorkflowNodeGroup[],
  moved: ReadonlySet<string>,
  callId: string,
  parent: WorkflowDefinition,
  types: NodeDescriptionLookup | undefined,
): WorkflowNodeGroup[] {
  const touched = groups.filter((g) => g.nodeIds.some((id) => moved.has(id)));
  const out: WorkflowNodeGroup[] = [];
  for (const g of groups) {
    if (!touched.includes(g)) {
      out.push(g);
      continue;
    }
    const kept = g.nodeIds.filter((id) => !moved.has(id));
    if (kept.length === 0) continue;
    const next = { ...g, nodeIds: touched.length === 1 ? [...kept, callId] : kept };
    if (validateWorkflowNodeGroups({ ...parent, nodeGroups: [next] }, types).length === 0) out.push(next);
  }
  return out;
}
