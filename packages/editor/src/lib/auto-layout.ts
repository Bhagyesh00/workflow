/**
 * Tidy up layout (P3-03, as n8n useCanvasLayout): a pure left-to-right layered layout of the whole
 * workflow, or of a selection, with @dagrejs/dagre. Only positions change; connections never do.
 *
 * - Units: a loose node, an AI parent with its sub-nodes in a row under it, or a group whose
 *   members are all in scope (two passes: the members are laid out on their own first, then the
 *   measured frame, or the collapsed card, is one box in the outer pass). A sticky covering exactly
 *   one such group (and no loose node) joins its box.
 * - Each weakly connected component goes to dagre (rankdir LR) with nodes fed in sortByPosition
 *   order; back edges found by a DFS are dropped first. Components are stacked top to bottom in
 *   their old order and the result keeps the old top-left corner.
 * - Post-pass: execution order follows canvas position (the engine runs ready children by
 *   sortByPosition), so the children of every node, and the start candidates, are put back in
 *   their old order. Inside a layer their slots are reassigned; across layers a unit is pushed
 *   down until the order holds, and the layer is restacked so nothing overlaps.
 * - Stickies covering nodes move with them (by the move of the covered nodes' top-left); other
 *   stickies stay. Positions are integers (our canvas has no snap-to-grid).
 */
import { Graph, layout } from '@dagrejs/dagre';
import {
  type Connections,
  type StickyNote,
  sortByPosition,
  type WorkflowNode,
  type WorkflowNodeGroup,
} from '@workflow/workflow';
import { type Box, groupFrame } from './group-layout-push';

export interface LayoutSize {
  width: number;
  height: number;
}

/** horizontal gap between two layers */
export const LAYOUT_RANK_GAP = 88;
/** vertical gap between two boxes of one layer */
export const LAYOUT_NODE_GAP = 66;
/** vertical gap between two stacked components */
export const LAYOUT_COMPONENT_GAP = 88;
/** gaps of the AI sub-node row under its parent */
export const LAYOUT_SUBNODE_GAP_X = 40;
export const LAYOUT_SUBNODE_GAP_Y = 70;
/** size of a node whose size is not known */
export const LAYOUT_DEFAULT_SIZE: LayoutSize = { width: 220, height: 64 };

export interface AutoLayoutInput {
  nodes: WorkflowNode[];
  connections: Connections;
  stickyNotes?: StickyNote[];
  nodeGroups?: WorkflowNodeGroup[];
  /** node sizes by node name (measured on the canvas); missing ones use `defaultSize` */
  sizes?: Record<string, LayoutSize>;
  defaultSize?: LayoutSize;
  /** lay out only these nodes (a selection); omitted = the whole canvas */
  target?: { nodes: string[]; stickies?: string[] };
  /** groups shown collapsed, by group id, with the size of their card */
  collapsedGroups?: Record<string, LayoutSize>;
  /** trigger node names: the start node is the first of them (else the first root) */
  triggers?: string[];
  /** per AI parent node name: its AI input types in port order (the sub-node row follows it) */
  aiInputs?: Record<string, string[]>;
}

export interface AutoLayoutResult {
  /** the new top-left of every laid-out node, by name */
  positions: Record<string, [number, number]>;
  /** the new top-left of every sticky that moves, by id */
  stickyPositions: Record<string, [number, number]>;
}

interface Pt {
  x: number;
  y: number;
}

interface Ctx {
  byName: Map<string, WorkflowNode>;
  /** index in sortByPosition order of the old positions */
  order: Map<string, number>;
  size(name: string): LayoutSize;
  /** main edges by source */
  mainOut: Map<string, Array<{ target: string; output: number }>>;
  /** non-main edges by source (sub-node -> parent) */
  aiOut: Map<string, Array<{ parent: string; type: string }>>;
  /** trigger names when there are any, else roots; in old order */
  candidates: string[];
  groups: Array<{ group: WorkflowNodeGroup; names: string[]; stickyIds: string[] }>;
  stickies: Map<string, StickyNote>;
  collapsed: Record<string, LayoutSize>;
  aiInputs: Record<string, string[]>;
}

interface Unit {
  key: string;
  /** the visible box */
  width: number;
  height: number;
  /** y of the line edges attach to (the main node's middle), from the visible top */
  anchorY: number;
  /** old visible top-left */
  origin: Pt;
  /** node offsets from the visible top-left */
  nodes: Map<string, Pt>;
  /** sticky offsets from the visible top-left (stickies that belong to the unit) */
  stickies: Map<string, Pt>;
  /** smallest old order of its nodes */
  order: number;
  left: number;
  top: number;
  column: number;
}

interface PassResult {
  positions: Map<string, Pt>;
  stickies: Map<string, Pt>;
}

const pt = (p: [number, number]): Pt => ({ x: p[0], y: p[1] });

/** half the height dagre sees: the box is mirrored around the anchor so edges stay straight */
const half = (u: Unit) => Math.max(u.anchorY, u.height - u.anchorY);
const boxTop = (u: Unit) => u.top + u.anchorY - half(u);
const boxBottom = (u: Unit) => u.top + u.anchorY + half(u);

export function layoutWorkflow(input: AutoLayoutInput): AutoLayoutResult {
  const result: AutoLayoutResult = { positions: {}, stickyPositions: {} };
  if (!input.nodes.length) return result;
  const ctx = context(input);
  const scope = input.target
    ? input.target.nodes.filter((name, i, all) => ctx.byName.has(name) && all.indexOf(name) === i)
    : input.nodes.map((n) => n.name);
  if (!scope.length) return result;

  const done = layoutPass(ctx, scope, [], true);
  for (const [name, p] of done.positions) result.positions[name] = [p.x, p.y];
  for (const [id, p] of done.stickies) {
    const old = ctx.stickies.get(id)!.position;
    if (old[0] !== p.x || old[1] !== p.y) result.stickyPositions[id] = [p.x, p.y];
  }
  return result;
}

function context(input: AutoLayoutInput): Ctx {
  const byName = new Map(input.nodes.map((n) => [n.name, n]));
  const order = new Map(sortByPosition(input.nodes).map((n, i) => [n.name, i]));
  const mainOut = new Map<string, Array<{ target: string; output: number }>>();
  const aiOut = new Map<string, Array<{ parent: string; type: string }>>();
  const hasMainIn = new Set<string>();
  for (const [source, types] of Object.entries(input.connections)) {
    if (!byName.has(source)) continue;
    for (const [type, outputs] of Object.entries(types ?? {})) {
      (outputs ?? []).forEach((list, output) => {
        for (const c of list ?? []) {
          if (!byName.has(c.node) || c.node === source) continue;
          if (type === 'main') {
            hasMainIn.add(c.node);
            const edges = mainOut.get(source) ?? [];
            edges.push({ target: c.node, output });
            mainOut.set(source, edges);
          } else {
            const edges = aiOut.get(source) ?? [];
            edges.push({ parent: c.node, type });
            aiOut.set(source, edges);
          }
        }
      });
    }
  }
  const enabled = input.nodes.filter((n) => !n.disabled);
  const triggers = new Set(input.triggers ?? []);
  const triggerNodes = enabled.filter((n) => triggers.has(n.name));
  const roots = enabled.filter((n) => !hasMainIn.has(n.name) && !(aiOut.has(n.name) && !mainOut.has(n.name)));
  const candidates = sortByPosition(triggerNodes.length ? triggerNodes : roots).map((n) => n.name);

  const idToName = new Map(input.nodes.map((n) => [n.id, n.name]));
  const stickies = new Map((input.stickyNotes ?? []).map((s) => [s.id, s]));
  const seen = new Set<string>();
  const groups: Ctx['groups'] = [];
  for (const group of input.nodeGroups ?? []) {
    const names: string[] = [];
    const stickyIds: string[] = [];
    for (const id of group.nodeIds) {
      if (seen.has(id)) continue;
      const name = idToName.get(id);
      if (name) names.push(name);
      else if (stickies.has(id)) stickyIds.push(id);
      else continue;
      seen.add(id);
    }
    if (names.length) groups.push({ group, names, stickyIds });
  }

  const fallback = input.defaultSize ?? LAYOUT_DEFAULT_SIZE;
  return {
    byName,
    order,
    size: (name) => input.sizes?.[name] ?? fallback,
    mainOut,
    aiOut,
    candidates,
    groups,
    stickies,
    collapsed: input.collapsedGroups ?? {},
    aiInputs: input.aiInputs ?? {},
  };
}

// ---------------------------------------------------------------------------------------------
// One pass: the scope's units, laid out and anchored at the scope's old top-left
// ---------------------------------------------------------------------------------------------

/**
 * @param attached stickies that belong to this pass (a group's sticky members): they move with
 *   the nodes they cover, else with the whole scope
 * @param outer the outer pass: groups become units and every free sticky is considered
 */
function layoutPass(ctx: Ctx, scope: string[], attached: string[], outer: boolean): PassResult {
  const inScope = new Set(scope);
  const units: Unit[] = [];
  const unitOf = new Map<string, Unit>();
  const ownedStickies = new Set<string>();
  const groupInner = new Map<Unit, { inner: Map<string, Pt>; frame: Pt }>();
  const oldPos = (name: string) => pt(ctx.byName.get(name)!.position);
  const minOrder = (names: Iterable<string>) => Math.min(...[...names].map((n) => ctx.order.get(n)!));

  // 1. groups whose members are all in scope: members first, then one box
  if (outer) {
    for (const g of ctx.groups) {
      if (!g.names.every((n) => inScope.has(n))) continue;
      const inner = layoutPass(ctx, g.names, g.stickyIds, false);
      const stickyBox = (id: string, p: Pt): Box => {
        const s = ctx.stickies.get(id)!;
        return { x: p.x, y: p.y, width: s.width, height: s.height };
      };
      const frame = groupFrame([
        ...g.names.map((n) => ({ ...inner.positions.get(n)!, ...ctx.size(n) })),
        ...g.stickyIds.map((id) =>
          stickyBox(id, inner.stickies.get(id) ?? pt(ctx.stickies.get(id)!.position)),
        ),
      ]);
      const before = groupFrame([
        ...g.names.map((n) => ({ ...oldPos(n), ...ctx.size(n) })),
        ...g.stickyIds.map((id) => stickyBox(id, pt(ctx.stickies.get(id)!.position))),
      ]);
      const card = ctx.collapsed[g.group.id];
      const width = Math.round(card?.width ?? frame.width);
      const height = Math.round(card?.height ?? frame.height);
      const offset = (p: Pt): Pt => ({ x: p.x - frame.x, y: p.y - frame.y });
      // expanded: cables reach the members, so the line runs through the first member's middle
      const first = [...g.names].sort((a, b) => ctx.order.get(a)! - ctx.order.get(b)!)[0]!;
      const anchorY = card
        ? Math.round(height / 2)
        : Math.round(offset(inner.positions.get(first)!).y + ctx.size(first).height / 2);
      const unit: Unit = {
        key: `group:${g.group.id}`,
        width,
        height,
        anchorY,
        origin: { x: Math.round(before.x), y: Math.round(before.y) },
        nodes: new Map(g.names.map((n) => [n, offset(inner.positions.get(n)!)])),
        stickies: new Map([...inner.stickies].map(([id, p]) => [id, offset(p)])),
        order: minOrder(g.names),
        left: 0,
        top: 0,
        column: 0,
      };
      units.push(unit);
      groupInner.set(unit, { inner: inner.positions, frame: { x: frame.x, y: frame.y } });
      for (const n of g.names) unitOf.set(n, unit);
      for (const id of g.stickyIds) ownedStickies.add(id);
    }
  }

  // 2. loose nodes: AI parents carry their sub-nodes in a row
  const loose = scope.filter((n) => !unitOf.has(n)).sort((a, b) => ctx.order.get(a)! - ctx.order.get(b)!);
  const looseSet = new Set(loose);
  const parentOf = new Map<string, { parent: string; type: string }>();
  const isAncestor = (candidate: string, of: string) => {
    for (let at: string | undefined = of; at; at = parentOf.get(at)?.parent)
      if (at === candidate) return true;
    return false;
  };
  for (const name of loose) {
    const parents = (ctx.aiOut.get(name) ?? [])
      .filter((p) => looseSet.has(p.parent))
      .sort((a, b) => ctx.order.get(a.parent)! - ctx.order.get(b.parent)!);
    const pick = parents.find((p) => !isAncestor(name, p.parent));
    if (pick) parentOf.set(name, pick);
  }
  const children = new Map<string, string[]>();
  for (const [child, { parent }] of parentOf) children.set(parent, [...(children.get(parent) ?? []), child]);
  for (const name of loose) {
    if (parentOf.has(name)) continue;
    const tree = aiTree(ctx, name, children, parentOf);
    const names = [...tree.nodes.keys()];
    const unit: Unit = {
      key: `node:${name}`,
      width: tree.width,
      height: tree.height,
      anchorY: tree.anchorY,
      origin: {
        x: Math.round(Math.min(...names.map((n) => oldPos(n).x))),
        y: Math.round(Math.min(...names.map((n) => oldPos(n).y))),
      },
      nodes: tree.nodes,
      stickies: new Map(),
      order: minOrder(names),
      left: 0,
      top: 0,
      column: 0,
    };
    units.push(unit);
    for (const n of names) unitOf.set(n, unit);
  }

  // 3. a free sticky covering exactly one group unit (and no loose node) joins its box
  const free = outer ? [...ctx.stickies.keys()].filter((id) => !ownedStickies.has(id)) : [];
  const covering = new Map<string, string[]>();
  for (const id of [...attached, ...free]) covering.set(id, coveredBy(ctx, ctx.stickies.get(id)!));
  for (const id of free) {
    const covered = covering.get(id)!;
    const unit = covered.length && covered.every((n) => inScope.has(n)) ? unitOf.get(covered[0]!) : undefined;
    const group = unit && groupInner.get(unit);
    if (!unit || !group || !covered.every((n) => unitOf.get(n) === unit)) continue;
    const sticky = ctx.stickies.get(id)!;
    const moved = shift(
      pt(sticky.position),
      delta(
        covered,
        (n) => oldPos(n),
        (n) => group.inner.get(n)!,
      ),
    );
    joinSticky(unit, id, { x: moved.x - group.frame.x, y: moved.y - group.frame.y }, sticky);
    unit.origin = {
      x: Math.min(unit.origin.x, Math.round(sticky.position[0])),
      y: Math.min(unit.origin.y, Math.round(sticky.position[1])),
    };
    ownedStickies.add(id);
  }

  // 4. edges between units, components, order constraints
  const edges: Array<{ from: Unit; to: Unit; output: number; targetOrder: number }> = [];
  for (const source of scope) {
    for (const e of ctx.mainOut.get(source) ?? []) {
      if (!inScope.has(e.target)) continue;
      const from = unitOf.get(source)!;
      const to = unitOf.get(e.target)!;
      if (from !== to) edges.push({ from, to, output: e.output, targetOrder: ctx.order.get(e.target)! });
    }
  }
  const components = connectedComponents(units, edges);
  const pairs = orderPairs(ctx, inScope);

  const componentOf = new Map<Unit, number>();
  for (const [i, c] of components.entries()) for (const u of c) componentOf.set(u, i);
  for (const [i, component] of components.entries()) {
    const own = new Set(component);
    layoutComponent(
      component,
      edges.filter((e) => own.has(e.from)),
      pairs
        .map(([a, b]) => [unitOf.get(a)!, a, unitOf.get(b)!, b] as const)
        .filter(([ua, , ub]) => ua !== ub && componentOf.get(ua) === i && componentOf.get(ub) === i),
    );
  }

  // 5. stack components in their old order, then keep the old top-left
  const candidateOrder = new Map(ctx.candidates.filter((n) => inScope.has(n)).map((n, i) => [n, i]));
  const keyOf = (component: Unit[]) => {
    const names = component.flatMap((u) => [...u.nodes.keys()]);
    const starts = names.filter((n) => candidateOrder.has(n)).map((n) => ctx.order.get(n)!);
    return starts.length ? Math.min(...starts) : Math.min(...names.map((n) => ctx.order.get(n)!));
  };
  const stacked = components.map((c) => ({ c, key: keyOf(c) })).sort((a, b) => a.key - b.key);
  let cursor = 0;
  for (const { c } of stacked) {
    const left = Math.min(...c.map((u) => u.left));
    const top = Math.min(...c.map((u) => u.top));
    const bottom = Math.max(...c.map((u) => u.top + u.height));
    for (const u of c) {
      u.left -= left;
      u.top += cursor - top;
    }
    cursor += bottom - top + LAYOUT_COMPONENT_GAP;
  }
  const dx = Math.min(...units.map((u) => u.origin.x)) - Math.min(...units.map((u) => u.left));
  const dy = Math.min(...units.map((u) => u.origin.y)) - Math.min(...units.map((u) => u.top));

  const positions = new Map<string, Pt>();
  const stickies = new Map<string, Pt>();
  for (const u of units) {
    const at = (p: Pt): Pt => ({ x: u.left + dx + p.x, y: u.top + dy + p.y });
    for (const [n, p] of u.nodes) positions.set(n, at(p));
    for (const [id, p] of u.stickies) stickies.set(id, at(p));
  }

  // 6. stickies that follow the nodes they cover (or, for a group's own stickies, the scope)
  for (const id of [...attached, ...free]) {
    if (stickies.has(id) || ownedStickies.has(id)) continue;
    const covered = covering.get(id)!;
    const follows = covered.length > 0 && covered.every((n) => inScope.has(n));
    if (!follows && !attached.includes(id)) continue;
    const names = follows ? covered : scope;
    const d = delta(names, oldPos, (n) => positions.get(n)!);
    stickies.set(id, shift(pt(ctx.stickies.get(id)!.position), d));
  }
  for (const [id, p] of stickies) stickies.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
  return { positions, stickies };
}

/** an AI parent with its sub-nodes (recursively) in one row under it, centred */
function aiTree(
  ctx: Ctx,
  name: string,
  children: Map<string, string[]>,
  parentOf: Map<string, { parent: string; type: string }>,
): { width: number; height: number; anchorY: number; nodes: Map<string, Pt> } {
  const own = ctx.size(name);
  const ownWidth = Math.round(own.width);
  const ownHeight = Math.round(own.height);
  const inputs = ctx.aiInputs[name] ?? [];
  const slot = (child: string) => {
    const i = inputs.indexOf(parentOf.get(child)!.type);
    return i < 0 ? inputs.length : i;
  };
  const kids = [...(children.get(name) ?? [])].sort(
    (a, b) =>
      slot(a) - slot(b) ||
      ctx.byName.get(a)!.position[0] - ctx.byName.get(b)!.position[0] ||
      ctx.order.get(a)! - ctx.order.get(b)!,
  );
  const anchorY = Math.round(ownHeight / 2);
  if (!kids.length)
    return { width: ownWidth, height: ownHeight, anchorY, nodes: new Map([[name, { x: 0, y: 0 }]]) };

  const subs = kids.map((k) => aiTree(ctx, k, children, parentOf));
  const rowWidth = subs.reduce((sum, s) => sum + s.width, 0) + LAYOUT_SUBNODE_GAP_X * (subs.length - 1);
  const rowLeft = Math.round((ownWidth - rowWidth) / 2);
  const minX = Math.min(0, rowLeft);
  const rowTop = ownHeight + LAYOUT_SUBNODE_GAP_Y;
  const nodes = new Map<string, Pt>([[name, { x: -minX, y: 0 }]]);
  let x = rowLeft - minX;
  for (const sub of subs) {
    for (const [n, p] of sub.nodes) nodes.set(n, { x: x + p.x, y: rowTop + p.y });
    x += sub.width + LAYOUT_SUBNODE_GAP_X;
  }
  return {
    width: Math.max(ownWidth, rowLeft + rowWidth) - minX,
    height: rowTop + Math.max(...subs.map((s) => s.height)),
    anchorY,
    nodes,
  };
}

/** grow a group unit's box so it holds the sticky; offsets stay relative to the new top-left */
function joinSticky(unit: Unit, id: string, at: Pt, sticky: StickyNote): void {
  const ox = Math.min(0, Math.round(at.x));
  const oy = Math.min(0, Math.round(at.y));
  const move = (p: Pt): Pt => ({ x: p.x - ox, y: p.y - oy });
  unit.nodes = new Map([...unit.nodes].map(([n, p]) => [n, move(p)]));
  unit.stickies = new Map([...unit.stickies].map(([s, p]) => [s, move(p)]));
  const placed = move({ x: Math.round(at.x), y: Math.round(at.y) });
  unit.stickies.set(id, placed);
  const anchor = unit.anchorY - oy;
  unit.width = Math.max(unit.width - ox, placed.x + Math.round(sticky.width));
  unit.height = Math.max(unit.height - oy, placed.y + Math.round(sticky.height));
  unit.anchorY = anchor;
}

/** nodes whose middle lies inside the sticky (old positions) */
function coveredBy(ctx: Ctx, sticky: StickyNote): string[] {
  const [x, y] = sticky.position;
  const covered: string[] = [];
  for (const [name, n] of ctx.byName) {
    const size = ctx.size(name);
    const cx = n.position[0] + size.width / 2;
    const cy = n.position[1] + size.height / 2;
    if (cx >= x && cx <= x + sticky.width && cy >= y && cy <= y + sticky.height) covered.push(name);
  }
  return covered;
}

/** how far the top-left of these nodes moved */
function delta(names: string[], before: (n: string) => Pt, after: (n: string) => Pt): Pt {
  const corner = (at: (n: string) => Pt) => ({
    x: Math.min(...names.map((n) => at(n).x)),
    y: Math.min(...names.map((n) => at(n).y)),
  });
  const a = corner(before);
  const b = corner(after);
  return { x: b.x - a.x, y: b.y - a.y };
}

const shift = (p: Pt, d: Pt): Pt => ({ x: p.x + d.x, y: p.y + d.y });

function connectedComponents(units: Unit[], edges: Array<{ from: Unit; to: Unit }>): Unit[][] {
  const root = new Map<Unit, Unit>(units.map((u) => [u, u]));
  const find = (u: Unit): Unit => {
    let r = u;
    while (root.get(r) !== r) r = root.get(r)!;
    root.set(u, r);
    return r;
  };
  for (const e of edges) root.set(find(e.from), find(e.to));
  const byRoot = new Map<Unit, Unit[]>();
  for (const u of [...units].sort((a, b) => a.order - b.order)) {
    const r = find(u);
    byRoot.set(r, [...(byRoot.get(r) ?? []), u]);
  }
  return [...byRoot.values()];
}

/**
 * Pairs [a, b] (a runs first) that must keep their order: the main children of every node, the
 * start candidates and the scope's own roots (no main parent in scope), each in sortByPosition
 * order of the old positions. Consecutive pairs suffice: the order is transitive. Keeping the
 * roots in order also makes a second tidy up give the same layout (dagre's input order below is
 * built from these orders only).
 */
function orderPairs(ctx: Ctx, inScope: Set<string>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const chain = (names: string[]) => {
    const sorted = sortByPosition(names.filter((n) => inScope.has(n)).map((n) => ctx.byName.get(n)!));
    for (let i = 1; i < sorted.length; i++) pairs.push([sorted[i - 1]!.name, sorted[i]!.name]);
  };
  const hasParent = new Set<string>();
  for (const [source, edges] of ctx.mainOut) {
    chain([...new Set(edges.map((e) => e.target))]);
    if (inScope.has(source)) for (const e of edges) hasParent.add(e.target);
  }
  chain(ctx.candidates);
  chain([...inScope].filter((n) => !hasParent.has(n)));
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// One component: dagre, then the order post-pass
// ---------------------------------------------------------------------------------------------

function layoutComponent(
  units: Unit[],
  edges: Array<{ from: Unit; to: Unit; output: number; targetOrder: number }>,
  pairs: ReadonlyArray<readonly [Unit, string, Unit, string]>,
): void {
  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: LAYOUT_NODE_GAP, ranksep: LAYOUT_RANK_GAP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  // dagre's result depends on its input order: feed it a DFS from the start units (children by
  // output, then old order), which the post-pass keeps, rather than raw positions
  const { order, kept } = acyclic(
    [...units].sort((a, b) => a.order - b.order),
    edges,
  );
  for (const u of order) g.setNode(u.key, { width: u.width, height: 2 * half(u) });
  for (const e of kept) if (!g.hasEdge(e.from.key, e.to.key)) g.setEdge(e.from.key, e.to.key);
  layout(g);
  for (const u of units) {
    const label = g.node(u.key) as { x: number; y: number };
    u.left = Math.round(label.x - u.width / 2);
    u.top = Math.round(label.y - u.anchorY);
    u.column = Math.round(label.x);
  }

  // the order post-pass
  if (!pairs.length) return;
  const nodeY = (u: Unit, name: string) => u.top + u.nodes.get(name)!.y;
  const nodeX = (u: Unit, name: string) => u.left + u.nodes.get(name)!.x;

  // inside a layer: give the constrained units their slots in old order
  const constrained = new Set(pairs.flatMap(([ua, , ub]) => [ua, ub]));
  const columns = new Map<number, Unit[]>();
  for (const u of units) columns.set(u.column, [...(columns.get(u.column) ?? []), u]);
  for (const column of columns.values()) {
    const placed = column.filter((u) => constrained.has(u)).sort((a, b) => a.top - b.top);
    const centres = placed.map((u) => u.top + u.anchorY);
    for (const [i, u] of [...placed].sort((a, b) => a.order - b.order).entries())
      u.top = centres[i]! - u.anchorY;
  }
  restack(units);

  // across layers: push the later unit down until the pair is in order
  for (let round = 0; round < 4 * units.length + 10; round++) {
    let changed = false;
    for (const [ua, a, ub, b] of pairs) {
      const ya = nodeY(ua, a);
      const yb = nodeY(ub, b);
      const push = ya - yb + (nodeX(ua, a) < nodeX(ub, b) ? 0 : 1);
      if (push > 0) {
        ub.top += push;
        changed = true;
      }
    }
    if (!changed) break;
    restack(units);
  }
}

/**
 * DFS from the start units (no incoming edge, in old order): the preorder, and the edges without
 * the back edges that close a cycle.
 */
function acyclic<E extends { from: Unit; to: Unit; output: number; targetOrder: number }>(
  units: Unit[],
  edges: E[],
): { order: Unit[]; kept: E[] } {
  const out = new Map<Unit, E[]>();
  const hasIn = new Set<Unit>();
  for (const e of edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    hasIn.add(e.to);
  }
  for (const list of out.values()) list.sort((a, b) => a.output - b.output || a.targetOrder - b.targetOrder);
  const state = new Map<Unit, 1 | 2>();
  const kept: E[] = [];
  const order: Unit[] = [];
  const visit = (start: Unit) => {
    // iterative DFS: big workflows must not overflow the stack
    const stack: Array<{ unit: Unit; next: number }> = [{ unit: start, next: 0 }];
    state.set(start, 1);
    order.push(start);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const list = out.get(top.unit) ?? [];
      if (top.next >= list.length) {
        state.set(top.unit, 2);
        stack.pop();
        continue;
      }
      const e = list[top.next++]!;
      const seen = state.get(e.to);
      if (seen === 1) continue; // back edge
      kept.push(e);
      if (!seen) {
        state.set(e.to, 1);
        order.push(e.to);
        stack.push({ unit: e.to, next: 0 });
      }
    }
  };
  for (const u of units) if (!hasIn.has(u) && !state.has(u)) visit(u);
  for (const u of units) if (!state.has(u)) visit(u);
  return { order, kept };
}

/** push boxes down until no two boxes that share a column range overlap (gap included) */
function restack(units: Unit[]): void {
  const overlapX = (a: Unit, b: Unit) => a.left < b.left + b.width && b.left < a.left + a.width;
  for (let round = 0; round < units.length + 1; round++) {
    let moved = false;
    const sorted = [...units].sort((a, b) => boxTop(a) - boxTop(b) || a.order - b.order);
    for (let i = 1; i < sorted.length; i++) {
      const u = sorted[i]!;
      for (let j = 0; j < i; j++) {
        const above = sorted[j]!;
        const floor = boxBottom(above) + LAYOUT_NODE_GAP;
        if (overlapX(above, u) && boxTop(u) < floor) {
          u.top += floor - boxTop(u);
          moved = true;
        }
      }
    }
    if (!moved) return;
  }
}
