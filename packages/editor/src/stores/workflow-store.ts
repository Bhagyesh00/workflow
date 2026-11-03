/**
 * The open workflow: graph (nodes, connections, pinned data, sticky notes), metadata, selection
 * and undo/redo history. Graph mutations go through the pure functions in `lib/workflow-ops`.
 */
import type {
  Item,
  NodeDescriptionLookup,
  StickyNote,
  WorkflowNode,
  WorkflowSettings,
} from '@workflow/workflow';
import { create } from 'zustand';
import type { Tag, WorkflowCreateBody, WorkflowDTO } from '../api/types';
import * as groups from '../lib/node-groups';
import type { ClipboardPayload, ConnectionRef, ParameterPath, WorkflowGraph } from '../lib/workflow-ops';
import * as ops from '../lib/workflow-ops';
import { toast } from './ui-store';

export interface WorkflowMeta {
  id?: string;
  name: string;
  /** true while a version is published (publishedVersionId !== null) */
  active: boolean;
  versionId?: string;
  settings: WorkflowSettings;
  tags: Tag[];
  createdAt?: string;
  updatedAt?: string;
  /** P3-07: null = the root folder */
  folderId: string | null;
  /** P3-07: an archived workflow opens read-only */
  isArchived: boolean;
  /** P3-10 */
  publishedVersionId: string | null;
}

export interface Selection {
  nodes: string[];
  stickies: string[];
  /** connection ids (see `connectionId`) */
  edges: string[];
}

const emptySelection = (): Selection => ({ nodes: [], stickies: [], edges: [] });

const HISTORY_LIMIT = 100;

export interface WorkflowState extends WorkflowGraph {
  meta: WorkflowMeta;
  selection: Selection;
  past: WorkflowGraph[];
  future: WorkflowGraph[];
  dirty: boolean;
  /** incremented on every change; a save only clears `dirty` if nothing changed meanwhile */
  revision: number;
  readOnly: boolean;
  /** bumped on load so views can reset (fit view, close panels) */
  loadCount: number;
  /** node type descriptions for the group rules (set by the editor page once the catalog loads) */
  nodeTypeLookup?: NodeDescriptionLookup;

  /** an archived workflow (`isArchived`) always loads read-only */
  load(workflow: Partial<WorkflowDTO> & { name: string }, options?: { readOnly?: boolean }): void;
  reset(): void;
  markSaved(dto: Pick<WorkflowDTO, 'id' | 'versionId'> & Partial<WorkflowDTO>, revision?: number): void;
  setNodeTypeLookup(lookup: NodeDescriptionLookup | undefined): void;

  setName(name: string): void;
  setSettings(settings: WorkflowSettings): void;
  setTags(tags: Tag[]): void;
  /** P3-10: the published pointer (null = unpublished); `active` follows it */
  setPublished(publishedVersionId: string | null, versionId?: string): void;
  /** wrapper of setPublished: true publishes `versionId` (else the current version), false unpublishes */
  setActive(active: boolean, versionId?: string): void;
  /** P3-07: after archive / unarchive. Archived is read-only; on unarchive pass the role's `readOnly` */
  setArchived(isArchived: boolean, readOnly?: boolean): void;

  /** push the current graph to history (call before a gesture like a drag) */
  checkpoint(): void;
  undo(): void;
  redo(): void;

  /** add a node; `from` plugs an output into the new node, `to` plugs the new node into an input */
  addNode(
    node: WorkflowNode,
    links?: { from?: Omit<ConnectionRef, 'target'>; to?: Omit<ConnectionRef, 'source'> },
  ): WorkflowNode;
  removeNodes(names: string[]): void;
  updateNode(name: string, patch: Partial<Omit<WorkflowNode, 'name' | 'id'>>): void;
  renameNode(oldName: string, newName: string): void;
  setParameter(nodeName: string, path: ParameterPath, value: unknown): void;
  moveNodes(positions: Record<string, [number, number]>, options?: { history?: boolean }): void;
  connect(ref: ConnectionRef): void;
  disconnect(ref: ConnectionRef): void;
  insertOnConnection(ref: ConnectionRef, node: WorkflowNode): WorkflowNode;
  setPinData(nodeName: string, items: Item[] | null): void;
  /** pin (items) or unpin (null) several nodes as one undo step */
  setPinDataMany(map: Record<string, Item[] | null>): void;
  toggleDisabled(names: string[]): void;
  /** replace the whole graph as one undo step (tidy up, convert, replace, import); optional new selection */
  applyGraph(next: WorkflowGraph, selection?: Partial<Selection>): void;

  /** P3-04: group the selected nodes; returns the new group id, or null when the rules refused it */
  groupSelection(): string | null;
  ungroup(groupId: string): void;
  renameGroup(groupId: string, name: string): void;
  /** move every member by (dx, dy); during a drag pass history: false after checkpoint(), like moveNodes */
  moveGroup(groupId: string, dx: number, dy: number, options?: { history?: boolean }): void;
  updateGroupDescription(groupId: string, text: string): void;

  addSticky(sticky: Omit<StickyNote, 'id'>): string;
  updateSticky(id: string, patch: Partial<Omit<StickyNote, 'id'>>, options?: { history?: boolean }): void;
  removeStickies(ids: string[]): void;

  select(selection: Partial<Selection>): void;
  selectAll(): void;
  clearSelection(): void;
  copySelection(): ClipboardPayload;
  paste(payload: ClipboardPayload, offset?: [number, number]): string[];
  duplicateSelection(): string[];
  deleteSelection(): void;
}

/** The editable graph of a store state (or any object holding the graph fields). */
export const graphOf = (s: WorkflowGraph): WorkflowGraph => ({
  nodes: s.nodes,
  connections: s.connections,
  pinData: s.pinData,
  stickyNotes: s.stickyNotes,
  nodeGroups: s.nodeGroups,
});

const emptyMeta = (): WorkflowMeta => ({
  name: 'My workflow',
  active: false,
  settings: {},
  tags: [],
  folderId: null,
  isArchived: false,
  publishedVersionId: null,
});

/** Body for POST /workflows (and the run endpoint's `workflowData`). */
export function toWorkflowBody(state: WorkflowState): WorkflowCreateBody {
  return {
    name: state.meta.name,
    nodes: state.nodes,
    connections: state.connections,
    settings: state.meta.settings,
    pinData: state.pinData,
    stickyNotes: state.stickyNotes,
    nodeGroups: state.nodeGroups,
    tagIds: state.meta.tags.map((t) => t.id),
    ...(state.meta.folderId ? { folderId: state.meta.folderId } : {}),
  };
}

/**
 * P3-04: an edit that would break a group is refused with n8n's toast and an "Ungroup" action.
 * Returns true when the edit must stop.
 */
/** the edit is refused: say why, with Ungroup as the way out */
function groupBlockedToast(error: groups.CrossingEditError): void {
  toast.error(error.message, undefined, {
    label: 'Ungroup',
    onClick: () => useWorkflowStore.getState().ungroup(error.groupId),
  });
}

/** true (after the toast) when `edit` on `graph` would break a valid group */
function blockedOn(
  graph: WorkflowGraph,
  ref: ConnectionRef,
  edit: groups.CrossingEdit,
  types: WorkflowState['nodeTypeLookup'],
): boolean {
  const error = groups.crossingEditError(graph, ref, edit, types);
  if (error) groupBlockedToast(error);
  return Boolean(error);
}

function blockedByGroup(state: WorkflowState, ref: ConnectionRef, edit: groups.CrossingEdit): boolean {
  return blockedOn(graphOf(state), ref, edit, state.nodeTypeLookup);
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => {
  /** apply a graph change, recording history unless `history: false` */
  const commit = (
    next: WorkflowGraph,
    options: { history?: boolean; selection?: Partial<Selection> } = {},
  ) => {
    const state = get();
    if (state.readOnly) return;
    const past =
      options.history === false ? state.past : [...state.past, graphOf(state)].slice(-HISTORY_LIMIT);
    set({
      ...next,
      past,
      future: options.history === false ? state.future : [],
      dirty: true,
      revision: state.revision + 1,
      ...(options.selection ? { selection: { ...state.selection, ...options.selection } } : {}),
    });
  };

  return {
    ...ops.EMPTY_GRAPH,
    meta: emptyMeta(),
    selection: emptySelection(),
    past: [],
    future: [],
    dirty: false,
    revision: 0,
    readOnly: false,
    loadCount: 0,
    nodeTypeLookup: undefined,

    load(workflow, options = {}) {
      const isArchived = workflow.isArchived ?? false;
      set({
        nodes: ops.normalizeNodes(workflow.nodes ?? []),
        connections: workflow.connections ?? {},
        pinData: workflow.pinData ?? {},
        stickyNotes: workflow.stickyNotes ?? [],
        nodeGroups: workflow.nodeGroups ?? [],
        meta: {
          id: workflow.id,
          name: workflow.name,
          active: workflow.active ?? false,
          versionId: workflow.versionId,
          settings: workflow.settings ?? {},
          tags: workflow.tags ?? [],
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
          folderId: workflow.folderId ?? null,
          isArchived,
          publishedVersionId: workflow.publishedVersionId ?? null,
        },
        selection: emptySelection(),
        past: [],
        future: [],
        dirty: false,
        readOnly: (options.readOnly ?? false) || isArchived,
        loadCount: get().loadCount + 1,
      });
    },

    reset() {
      set({
        ...ops.EMPTY_GRAPH,
        meta: emptyMeta(),
        selection: emptySelection(),
        past: [],
        future: [],
        dirty: false,
        readOnly: false,
        loadCount: get().loadCount + 1,
      });
    },

    markSaved(dto, revision) {
      set((s) => ({
        dirty: revision !== undefined && revision !== s.revision ? s.dirty : false,
        meta: {
          ...s.meta,
          id: dto.id,
          versionId: dto.versionId,
          active: dto.active ?? s.meta.active,
          tags: dto.tags ?? s.meta.tags,
          createdAt: dto.createdAt ?? s.meta.createdAt,
          updatedAt: dto.updatedAt ?? s.meta.updatedAt,
          folderId: dto.folderId !== undefined ? dto.folderId : s.meta.folderId,
          isArchived: dto.isArchived ?? s.meta.isArchived,
          publishedVersionId:
            dto.publishedVersionId !== undefined ? dto.publishedVersionId : s.meta.publishedVersionId,
        },
      }));
    },
    setNodeTypeLookup(lookup) {
      set({ nodeTypeLookup: lookup });
    },

    setName(name) {
      if (get().readOnly) return;
      set((s) => ({ meta: { ...s.meta, name }, dirty: true, revision: s.revision + 1 }));
    },
    setSettings(settings) {
      if (get().readOnly) return;
      set((s) => ({ meta: { ...s.meta, settings }, dirty: true, revision: s.revision + 1 }));
    },
    setTags(tags) {
      if (get().readOnly) return;
      set((s) => ({ meta: { ...s.meta, tags }, dirty: true, revision: s.revision + 1 }));
    },
    setPublished(publishedVersionId, versionId) {
      set((s) => ({
        meta: {
          ...s.meta,
          publishedVersionId,
          active: publishedVersionId !== null,
          versionId: versionId ?? s.meta.versionId,
        },
      }));
    },
    setActive(active, versionId) {
      const current = versionId ?? get().meta.versionId ?? null;
      get().setPublished(active ? current : null, versionId);
    },
    setArchived(isArchived, readOnly) {
      set((s) => ({ meta: { ...s.meta, isArchived }, readOnly: isArchived || (readOnly ?? s.readOnly) }));
    },

    checkpoint() {
      const s = get();
      if (s.readOnly) return;
      set({ past: [...s.past, graphOf(s)].slice(-HISTORY_LIMIT), future: [] });
    },
    undo() {
      const s = get();
      const previous = s.past[s.past.length - 1];
      if (!previous || s.readOnly) return;
      set({
        ...previous,
        past: s.past.slice(0, -1),
        future: [graphOf(s), ...s.future].slice(0, HISTORY_LIMIT),
        dirty: true,
        revision: s.revision + 1,
        selection: emptySelection(),
      });
    },
    redo() {
      const s = get();
      const next = s.future[0];
      if (!next || s.readOnly) return;
      set({
        ...next,
        past: [...s.past, graphOf(s)].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        dirty: true,
        revision: s.revision + 1,
        selection: emptySelection(),
      });
    },

    addNode(node, links = {}) {
      const s = get();
      const { graph, node: added } = ops.addNode(graphOf(s), node);
      const refs: ConnectionRef[] = [];
      if (links.from) refs.push({ ...links.from, target: added.name });
      if (links.to) refs.push({ ...links.to, source: added.name });
      // each link goes through the group guard and auto-extend, as connect does
      let next = graph;
      const extended: string[] = [];
      for (const ref of refs) {
        // refused: nothing is added (callers check that the node exists)
        if (blockedOn(next, ref, 'connect', s.nodeTypeLookup)) return added;
        const extension = groups.extendGroupsForConnection(ops.connect(next, ref), ref, s.nodeTypeLookup);
        next = extension.graph;
        extended.push(...extension.extended);
      }
      commit(next, { selection: { nodes: [added.name], stickies: [], edges: [] } });
      for (const name of extended) toast.info(`'${name}' extended`);
      return added;
    },
    removeNodes(names) {
      const s = get();
      commit(ops.removeNodes(graphOf(s), names), {
        selection: { nodes: s.selection.nodes.filter((n) => !names.includes(n)) },
      });
    },
    updateNode(name, patch) {
      commit(ops.updateNode(graphOf(get()), name, patch));
    },
    renameNode(oldName, newName) {
      const s = get();
      const next = ops.renameNode(graphOf(s), oldName, newName);
      commit(next, {
        selection: { nodes: s.selection.nodes.map((n) => (n === oldName ? newName.trim() : n)) },
      });
    },
    setParameter(nodeName, path, value) {
      commit(ops.setNodeParameter(graphOf(get()), nodeName, path, value));
    },
    moveNodes(positions, options = {}) {
      commit(ops.moveNodes(graphOf(get()), positions), { history: options.history });
    },
    connect(ref) {
      const s = get();
      if (s.readOnly || blockedByGroup(s, ref, 'connect')) return;
      const extension = groups.extendGroupsForConnection(ops.connect(graphOf(s), ref), ref, s.nodeTypeLookup);
      commit(extension.graph);
      for (const name of extension.extended) toast.info(`'${name}' extended`);
    },
    disconnect(ref) {
      const s = get();
      if (s.readOnly || blockedByGroup(s, ref, 'disconnect')) return;
      commit(ops.disconnect(graphOf(s), ref));
    },
    insertOnConnection(ref, node) {
      const s = get();
      if (s.readOnly || blockedByGroup(s, ref, 'insert')) return node;
      const { graph, node: added } = ops.addNode(graphOf(s), node);
      commit(ops.insertNodeOnConnection(graph, ref, added.name), {
        selection: { nodes: [added.name], stickies: [], edges: [] },
      });
      return added;
    },
    setPinData(nodeName, items) {
      commit(ops.setPinData(graphOf(get()), nodeName, items));
    },
    setPinDataMany(map) {
      let graph = graphOf(get());
      for (const [name, items] of Object.entries(map)) graph = ops.setPinData(graph, name, items);
      commit(graph);
    },
    applyGraph(next, selection) {
      commit(next, selection ? { selection } : {});
    },

    groupSelection() {
      const s = get();
      if (s.readOnly || !s.selection.nodes.length) return null;
      const result = groups.groupNodes(graphOf(s), s.selection.nodes, s.nodeTypeLookup);
      if (!result.groupId) {
        if (result.problems[0]) toast.error('Could not group these nodes', result.problems[0].message);
        return null;
      }
      commit(result.graph);
      return result.groupId;
    },
    ungroup(groupId) {
      commit(groups.ungroupNodes(graphOf(get()), groupId));
    },
    renameGroup(groupId, name) {
      commit(groups.renameNodeGroup(graphOf(get()), groupId, name));
    },
    moveGroup(groupId, dx, dy, options = {}) {
      commit(groups.moveNodeGroup(graphOf(get()), groupId, dx, dy), { history: options.history });
    },
    updateGroupDescription(groupId, text) {
      commit(groups.setNodeGroupDescription(graphOf(get()), groupId, text));
    },
    toggleDisabled(names) {
      const s = get();
      const targets = s.nodes.filter((n) => names.includes(n.name));
      if (!targets.length) return;
      const disable = targets.some((n) => !n.disabled);
      let graph = graphOf(s);
      for (const n of targets)
        graph = ops.updateNode(graph, n.name, { disabled: disable ? true : undefined });
      commit(graph);
    },

    addSticky(sticky) {
      const s = get();
      const next = ops.addSticky(graphOf(s), sticky);
      const id = next.stickyNotes[next.stickyNotes.length - 1].id;
      commit(next, { selection: { nodes: [], stickies: [id], edges: [] } });
      return id;
    },
    updateSticky(id, patch, options = {}) {
      commit(ops.updateSticky(graphOf(get()), id, patch), { history: options.history });
    },
    removeStickies(ids) {
      const s = get();
      commit(ops.removeStickies(graphOf(s), ids), {
        selection: { stickies: s.selection.stickies.filter((i) => !ids.includes(i)) },
      });
    },

    select(selection) {
      set((s) => ({ selection: { ...s.selection, ...selection } }));
    },
    selectAll() {
      set((s) => ({
        selection: { nodes: s.nodes.map((n) => n.name), stickies: s.stickyNotes.map((n) => n.id), edges: [] },
      }));
    },
    clearSelection() {
      set({ selection: emptySelection() });
    },
    copySelection() {
      const s = get();
      return ops.extractSubgraph(graphOf(s), s.selection.nodes, s.selection.stickies);
    },
    paste(payload, offset) {
      const s = get();
      if (s.readOnly) return [];
      const result = ops.pasteSubgraph(graphOf(s), payload, offset);
      commit(result.graph, { selection: { nodes: result.names, stickies: result.stickyIds, edges: [] } });
      return result.names;
    },
    duplicateSelection() {
      const s = get();
      if (!s.selection.nodes.length && !s.selection.stickies.length) return [];
      return get().paste(get().copySelection(), [40, 40]);
    },
    deleteSelection() {
      const s = get();
      const { nodes, stickies, edges } = s.selection;
      if (s.readOnly || (!nodes.length && !stickies.length && !edges.length)) return;
      let graph = graphOf(s);
      const edgeSet = new Set(edges);
      const removed = new Set(nodes);
      for (const ref of ops.listConnections(graph.connections)) {
        if (!edgeSet.has(ops.connectionId(ref))) continue;
        // cables of deleted nodes go with them: removeNodes shrinks or dissolves their groups
        if (removed.has(ref.source) || removed.has(ref.target)) continue;
        // a cable that would break a group is refused as the hover delete is
        if (blockedOn(graph, ref, 'disconnect', s.nodeTypeLookup)) return;
        graph = ops.disconnect(graph, ref);
      }
      graph = ops.removeNodes(graph, nodes);
      graph = ops.removeStickies(graph, stickies);
      commit(graph, { selection: emptySelection() });
    },
  };
});
