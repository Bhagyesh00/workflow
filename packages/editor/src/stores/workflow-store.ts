/**
 * The open workflow: graph (nodes, connections, pinned data, sticky notes), metadata, selection
 * and undo/redo history. Graph mutations go through the pure functions in `lib/workflow-ops`.
 */
import type { Item, StickyNote, WorkflowNode, WorkflowSettings } from '@workflow/workflow';
import { create } from 'zustand';
import type { Tag, WorkflowCreateBody, WorkflowDTO } from '../api/types';
import type { ClipboardPayload, ConnectionRef, ParameterPath, WorkflowGraph } from '../lib/workflow-ops';
import * as ops from '../lib/workflow-ops';

export interface WorkflowMeta {
  id?: string;
  name: string;
  active: boolean;
  versionId?: string;
  settings: WorkflowSettings;
  tags: Tag[];
  createdAt?: string;
  updatedAt?: string;
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

  load(workflow: Partial<WorkflowDTO> & { name: string }, options?: { readOnly?: boolean }): void;
  reset(): void;
  markSaved(dto: Pick<WorkflowDTO, 'id' | 'versionId'> & Partial<WorkflowDTO>, revision?: number): void;

  setName(name: string): void;
  setSettings(settings: WorkflowSettings): void;
  setTags(tags: Tag[]): void;
  setActive(active: boolean, versionId?: string): void;

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
  toggleDisabled(names: string[]): void;

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

const graphOf = (s: WorkflowGraph): WorkflowGraph => ({
  nodes: s.nodes,
  connections: s.connections,
  pinData: s.pinData,
  stickyNotes: s.stickyNotes,
});

const emptyMeta = (): WorkflowMeta => ({ name: 'My workflow', active: false, settings: {}, tags: [] });

/** Body for POST /workflows (and the run endpoint's `workflowData`). */
export function toWorkflowBody(state: WorkflowState): WorkflowCreateBody {
  return {
    name: state.meta.name,
    nodes: state.nodes,
    connections: state.connections,
    settings: state.meta.settings,
    pinData: state.pinData,
    stickyNotes: state.stickyNotes,
    tagIds: state.meta.tags.map((t) => t.id),
  };
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

    load(workflow, options = {}) {
      set({
        nodes: ops.normalizeNodes(workflow.nodes ?? []),
        connections: workflow.connections ?? {},
        pinData: workflow.pinData ?? {},
        stickyNotes: workflow.stickyNotes ?? [],
        meta: {
          id: workflow.id,
          name: workflow.name,
          active: workflow.active ?? false,
          versionId: workflow.versionId,
          settings: workflow.settings ?? {},
          tags: workflow.tags ?? [],
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
        },
        selection: emptySelection(),
        past: [],
        future: [],
        dirty: false,
        readOnly: options.readOnly ?? false,
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
        },
      }));
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
    setActive(active, versionId) {
      set((s) => ({ meta: { ...s.meta, active, versionId: versionId ?? s.meta.versionId } }));
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
      let next = graph;
      if (links.from) next = ops.connect(next, { ...links.from, target: added.name });
      if (links.to) next = ops.connect(next, { ...links.to, source: added.name });
      commit(next, { selection: { nodes: [added.name], stickies: [], edges: [] } });
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
      commit(ops.connect(graphOf(get()), ref));
    },
    disconnect(ref) {
      commit(ops.disconnect(graphOf(get()), ref));
    },
    insertOnConnection(ref, node) {
      const { graph, node: added } = ops.addNode(graphOf(get()), node);
      commit(ops.insertNodeOnConnection(graph, ref, added.name), {
        selection: { nodes: [added.name], stickies: [], edges: [] },
      });
      return added;
    },
    setPinData(nodeName, items) {
      commit(ops.setPinData(graphOf(get()), nodeName, items));
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
      if (!nodes.length && !stickies.length && !edges.length) return;
      let graph = graphOf(s);
      const edgeSet = new Set(edges);
      for (const ref of ops.listConnections(graph.connections)) {
        if (edgeSet.has(ops.connectionId(ref))) graph = ops.disconnect(graph, ref);
      }
      graph = ops.removeNodes(graph, nodes);
      graph = ops.removeStickies(graph, stickies);
      commit(graph, { selection: emptySelection() });
    },
  };
});
