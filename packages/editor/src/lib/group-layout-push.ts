/**
 * Canvas group geometry (P3-04 addendum): the expanded frame around the members, the collapsed
 * card, and the push layout that moves other nodes out of an expanded frame (as n8n
 * useCanvasNodeGroupLayout). Pure and view-only: the offsets computed here are applied to display
 * positions on the canvas and never reach the workflow model or the save body.
 */

/** window event fired when the group view state (expanded, pinned) changes; the canvas re-renders */
export const GROUP_VIEW_EVENT = 'workflow:group-view';

/** frame inset around the members (sides and bottom) */
export const GROUP_PADDING = 32;
/** title bar band above the members */
export const GROUP_HEADER = 48;
export const COLLAPSED_GROUP_WIDTH = 400;
export const COLLAPSED_GROUP_HEIGHT = 64;
/** extra card height for a shown description (up to 3 lines) */
export const COLLAPSED_DESCRIPTION_HEIGHT = 60;
/** spacing kept between a frame and the nodes it pushed */
export const PUSH_GAP = 40;
/** size of a node React Flow has not measured yet */
export const DEFAULT_NODE_SIZE = { width: 120, height: 120 } as const;
/** below this zoom a description is hidden even when pinned */
export const DESCRIPTION_MIN_ZOOM = 0.66;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Offset {
  x: number;
  y: number;
}

/** the expanded frame around the member boxes (an empty box at 0, 0 when there are none) */
export function groupFrame(members: readonly Box[]): Box {
  if (!members.length) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...members.map((b) => b.x));
  const minY = Math.min(...members.map((b) => b.y));
  const maxX = Math.max(...members.map((b) => b.x + b.width));
  const maxY = Math.max(...members.map((b) => b.y + b.height));
  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_HEADER,
    width: maxX - minX + 2 * GROUP_PADDING,
    height: maxY - minY + GROUP_HEADER + GROUP_PADDING,
  };
}

/** the collapsed card, anchored at the frame's top-left corner */
export function collapsedCard(frame: Box, descriptionShown: boolean): Box {
  return {
    x: frame.x,
    y: frame.y,
    width: COLLAPSED_GROUP_WIDTH,
    height: COLLAPSED_GROUP_HEIGHT + (descriptionShown ? COLLAPSED_DESCRIPTION_HEIGHT : 0),
  };
}

export function showsGroupDescription(
  description: string | undefined,
  pinned: boolean,
  zoom: number,
): boolean {
  return Boolean(description?.trim()) && pinned && zoom >= DESCRIPTION_MIN_ZOOM;
}

export interface PushGroup {
  id: string;
  expanded: boolean;
  /** what the group occupies now: the frame when expanded, the card when collapsed */
  box: Box;
  /** the collapsed card's box (the lanes start from it) */
  chip: Box;
}

export interface PushItem {
  /** node id of a node in no group */
  id: string;
  box: Box;
}

export interface GroupPush {
  /** offset per group id (applies to the group's frame or card and to all its members) */
  groups: Map<string, Offset>;
  /** offset per loose node id */
  nodes: Map<string, Offset>;
}

interface Unit {
  key: string;
  box: Box;
  off: Offset;
}

const shifted = (u: Unit): Box => ({ ...u.box, x: u.box.x + u.off.x, y: u.box.y + u.off.y });
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Offsets that move every component (other groups and loose nodes; sticky notes never move) out
 * of each expanded group's frame. Expanded groups push in the given order. A component right of
 * the collapsed card that shares the frame's rows is in the right lane; one below the card that
 * shares its columns is in the lower lane (the deeper lane wins when both apply). When a lane
 * holds a component overlapping the frame, the whole lane moves by the clearance plus PUSH_GAP,
 * and whatever a pushed group had pushed moves with it. A component left of the card's right edge
 * and above its bottom edge sits on the card itself and is left alone.
 */
export function computeGroupPush(groups: readonly PushGroup[], loose: readonly PushItem[]): GroupPush {
  const units: Unit[] = [
    ...groups.map((g) => ({ key: `g:${g.id}`, box: g.box, off: { x: 0, y: 0 } })),
    ...loose.map((n) => ({ key: `n:${n.id}`, box: n.box, off: { x: 0, y: 0 } })),
  ];
  const byKey = new Map(units.map((u) => [u.key, u]));
  const pushedBy = new Map<string, Set<string>>();

  /** the lane plus everything the pushed groups in it had pushed before (each once) */
  const withCascade = (lane: Unit[], source: string): Unit[] => {
    const out = new Set<string>();
    const stack = lane.map((u) => u.key);
    while (stack.length) {
      const key = stack.pop() as string;
      if (key === source || out.has(key)) continue;
      out.add(key);
      for (const k of pushedBy.get(key) ?? []) stack.push(k);
    }
    return [...out].map((k) => byKey.get(k) as Unit);
  };

  for (const g of groups) {
    if (!g.expanded) continue;
    const source = byKey.get(`g:${g.id}`) as Unit;
    const frame = shifted(source);
    const chip = { ...g.chip, x: g.chip.x + source.off.x, y: g.chip.y + source.off.y };
    const chipRight = chip.x + chip.width;
    const chipBottom = chip.y + chip.height;
    const right: Unit[] = [];
    const down: Unit[] = [];
    for (const u of units) {
      if (u === source) continue;
      const b = shifted(u);
      const inRows = b.y < frame.y + frame.height && b.y + b.height > frame.y;
      const inColumns = b.x < frame.x + frame.width && b.x + b.width > frame.x;
      const isRight = b.x >= chipRight && inRows;
      const isDown = b.y >= chipBottom && inColumns;
      if (isRight && isDown) (b.x - chipRight >= b.y - chipBottom ? right : down).push(u);
      else if (isRight) right.push(u);
      else if (isDown) down.push(u);
    }
    const mine = pushedBy.get(source.key) ?? new Set<string>();
    pushedBy.set(source.key, mine);

    const rightOver = right.filter((u) => overlaps(frame, shifted(u)));
    if (rightOver.length) {
      const dx = Math.max(...rightOver.map((u) => frame.x + frame.width + PUSH_GAP - shifted(u).x));
      for (const u of withCascade(right, source.key)) u.off = { x: u.off.x + dx, y: u.off.y };
      for (const u of right) mine.add(u.key);
    }
    const downOver = down.filter((u) => overlaps(frame, shifted(u)));
    if (downOver.length) {
      const dy = Math.max(...downOver.map((u) => frame.y + frame.height + PUSH_GAP - shifted(u).y));
      for (const u of withCascade(down, source.key)) u.off = { x: u.off.x, y: u.off.y + dy };
      for (const u of down) mine.add(u.key);
    }
  }

  const result: GroupPush = { groups: new Map(), nodes: new Map() };
  for (const u of units) {
    if (u.off.x === 0 && u.off.y === 0) continue;
    const off = { x: Math.round(u.off.x), y: Math.round(u.off.y) };
    if (u.key.startsWith('g:')) result.groups.set(u.key.slice(2), off);
    else result.nodes.set(u.key.slice(2), off);
  }
  return result;
}
