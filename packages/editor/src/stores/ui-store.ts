/** Editor chrome state: open panels, node creator context, theme and toasts. */
import type { ConnectionType } from '@workflow/workflow';
import { create } from 'zustand';
import type { ActivationErrorDetail } from '../api/types';
import { applyTheme, readThemePreference, storeThemePreference, type ThemePreference } from '../lib/brand';
import type { ConnectionRef } from '../lib/workflow-ops';

export interface CreatorContext {
  /** connect the new node from this output */
  connectFrom?: Omit<ConnectionRef, 'target' | 'targetType' | 'targetIndex'>;
  /** the new node is a sub-node plugged into this (AI) input */
  connectTo?: { target: string; targetType: ConnectionType; targetIndex: number };
  /** replace this cable with source -> new node -> target */
  insertOn?: ConnectionRef;
  /** canvas position for the new node */
  position?: [number, number];
}

export type SidePanel = 'creator' | 'doctor' | 'versions' | null;

/** tab of the bottom log panel; `chat` shows only when the workflow has a chat trigger (P5-59, P5-60) */
export type LogPanelTab = 'logs' | 'console' | 'timeline' | 'chat';

/** what a right-click (or a node's "More" button) opened the context menu on (P3-02) */
export type ContextMenuTarget =
  | { type: 'node'; nodeName: string }
  /** the current multi-selection */
  | { type: 'selection' }
  /** a group frame's title bar */
  | { type: 'group'; groupId: string }
  | { type: 'sticky'; stickyId: string }
  /** empty canvas; `position` is in flow coordinates (where "Add node" puts the node) */
  | { type: 'canvas'; position: [number, number] };

export interface ContextMenuState {
  /** viewport (client) coordinates of the pointer */
  x: number;
  y: number;
  target: ContextMenuTarget;
}

/** a request to a sticky note from the context menu (P3-02 addendum) */
export interface StickyAction {
  id: string;
  action: 'edit' | 'color';
}

export interface UiState {
  theme: ThemePreference;
  resolvedTheme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  sidePanel: SidePanel;
  creatorContext: CreatorContext;
  ndvNode: string | null;
  logPanelOpen: boolean;
  /** P5-60: the log panel's open tab; default `logs` */
  logPanelTab: LogPanelTab;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  /** PATCH answered 409: someone saved a newer version */
  saveConflict: boolean;
  /** activation was refused with these per-node problems */
  activationErrors: ActivationErrorDetail[] | null;
  /** P3-01 command bar (Ctrl/Cmd+K) */
  commandBarOpen: boolean;
  /** P3-02 canvas context menu */
  contextMenu: ContextMenuState | null;
  /** node whose rename dialog is open (F2, menu Rename) */
  renameTarget: string | null;
  /** P3-05 "Convert to sub-workflow" dialog for the selection */
  convertOpen: boolean;
  /** P3-10 publish dialog */
  publishDialogOpen: boolean;
  /** "Import from file" dialog on the workflows page */
  importOpen: boolean;
  /** asks the editor header to focus the workflow name (command bar "Rename") */
  workflowRenameRequested: boolean;
  /** asks the editor header to open the tags editor (command bar "Add tag") */
  tagsEditRequested: boolean;
  /** P3-11: the node panel replaces this node (R) */
  replaceTarget: string | null;
  /** P3-02 addendum: edit or recolour this sticky */
  stickyAction: StickyAction | null;
  /** P3-13 "Import from URL" dialog */
  importUrlOpen: boolean;
  /** P3-12: credential open in the editor's credential modal */
  openCredentialId: string | null;

  setTheme(theme: ThemePreference): void;
  toggleSidebar(collapsed?: boolean): void;
  openCreator(context?: CreatorContext): void;
  setSidePanel(panel: SidePanel): void;
  openNdv(nodeName: string | null): void;
  setLogPanel(open: boolean): void;
  /** switches the tab only; `setLogPanel(true)` opens the panel */
  setLogPanelTab(tab: LogPanelTab): void;
  setSettingsOpen(open: boolean): void;
  setShortcutsOpen(open: boolean): void;
  setSaveConflict(open: boolean): void;
  setActivationErrors(errors: ActivationErrorDetail[] | null): void;
  setCommandBarOpen(open: boolean): void;
  openContextMenu(menu: ContextMenuState): void;
  closeContextMenu(): void;
  setRenameTarget(nodeName: string | null): void;
  setConvertOpen(open: boolean): void;
  setPublishDialogOpen(open: boolean): void;
  setImportOpen(open: boolean): void;
  setWorkflowRenameRequested(requested: boolean): void;
  setTagsEditRequested(requested: boolean): void;
  /** call after openCreator(): the panel then replaces this node */
  setReplaceTarget(nodeName: string | null): void;
  setStickyAction(action: StickyAction | null): void;
  setImportUrlOpen(open: boolean): void;
  setOpenCredentialId(credentialId: string | null): void;
}

/** A stored choice wins; otherwise an explicit theme set on <html> by an embedding page. */
function initialTheme(): ThemePreference {
  const stored = readThemePreference();
  if (stored !== 'system') return stored;
  const host = document.documentElement.dataset.theme;
  return host === 'light' || host === 'dark' ? host : 'system';
}

export const useUiStore = create<UiState>()((set) => {
  const theme = typeof window === 'undefined' ? 'system' : initialTheme();
  return {
    theme,
    resolvedTheme: 'light',
    sidebarCollapsed: false,
    sidePanel: null,
    creatorContext: {},
    ndvNode: null,
    logPanelOpen: false,
    logPanelTab: 'logs',
    settingsOpen: false,
    shortcutsOpen: false,
    saveConflict: false,
    activationErrors: null,
    commandBarOpen: false,
    contextMenu: null,
    renameTarget: null,
    convertOpen: false,
    publishDialogOpen: false,
    importOpen: false,
    workflowRenameRequested: false,
    tagsEditRequested: false,
    replaceTarget: null,
    stickyAction: null,
    importUrlOpen: false,
    openCredentialId: null,

    setTheme(next) {
      storeThemePreference(next);
      set({ theme: next, resolvedTheme: applyTheme(next) });
    },
    toggleSidebar(collapsed) {
      set((s) => ({ sidebarCollapsed: collapsed ?? !s.sidebarCollapsed }));
    },
    openCreator(context = {}) {
      set({ sidePanel: 'creator', creatorContext: context, replaceTarget: null });
    },
    setSidePanel(panel) {
      set({ sidePanel: panel, creatorContext: {}, replaceTarget: null });
    },
    openNdv(nodeName) {
      set({ ndvNode: nodeName });
    },
    setLogPanel(open) {
      set({ logPanelOpen: open });
    },
    setLogPanelTab(tab) {
      set({ logPanelTab: tab });
    },
    setSettingsOpen(open) {
      set({ settingsOpen: open });
    },
    setShortcutsOpen(open) {
      set({ shortcutsOpen: open });
    },
    setSaveConflict(open) {
      set({ saveConflict: open });
    },
    setActivationErrors(errors) {
      set({ activationErrors: errors });
    },
    setCommandBarOpen(open) {
      set({ commandBarOpen: open });
    },
    openContextMenu(menu) {
      set({ contextMenu: menu });
    },
    closeContextMenu() {
      set({ contextMenu: null });
    },
    setRenameTarget(nodeName) {
      set({ renameTarget: nodeName });
    },
    setConvertOpen(open) {
      set({ convertOpen: open });
    },
    setPublishDialogOpen(open) {
      set({ publishDialogOpen: open });
    },
    setImportOpen(open) {
      set({ importOpen: open });
    },
    setWorkflowRenameRequested(requested) {
      set({ workflowRenameRequested: requested });
    },
    setTagsEditRequested(requested) {
      set({ tagsEditRequested: requested });
    },
    setReplaceTarget(nodeName) {
      set({ replaceTarget: nodeName });
    },
    setStickyAction(action) {
      set({ stickyAction: action });
    },
    setImportUrlOpen(open) {
      set({ importUrlOpen: open });
    },
    setOpenCredentialId(credentialId) {
      set({ openCredentialId: credentialId });
    },
  };
});

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

export type ToastKind = 'success' | 'error' | 'info';

/** a button on a toast (e.g. "Ungroup" on a blocked group edit); clicking it also dismisses the toast */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push(toast: Omit<Toast, 'id'>): number;
  dismiss(id: number): void;
}

let toastSeq = 0;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push(toast) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...toast, id }] }));
    return id;
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toast = {
  success: (title: string, description?: string, action?: ToastAction) =>
    useToastStore.getState().push({ kind: 'success', title, description, action }),
  error: (title: string, description?: string, action?: ToastAction) =>
    useToastStore.getState().push({ kind: 'error', title, description, action }),
  info: (title: string, description?: string, action?: ToastAction) =>
    useToastStore.getState().push({ kind: 'info', title, description, action }),
};
