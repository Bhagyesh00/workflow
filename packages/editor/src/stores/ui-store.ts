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

export interface UiState {
  theme: ThemePreference;
  resolvedTheme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  sidePanel: SidePanel;
  creatorContext: CreatorContext;
  ndvNode: string | null;
  logPanelOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  /** PATCH answered 409: someone saved a newer version */
  saveConflict: boolean;
  /** activation was refused with these per-node problems */
  activationErrors: ActivationErrorDetail[] | null;

  setTheme(theme: ThemePreference): void;
  toggleSidebar(collapsed?: boolean): void;
  openCreator(context?: CreatorContext): void;
  setSidePanel(panel: SidePanel): void;
  openNdv(nodeName: string | null): void;
  setLogPanel(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setShortcutsOpen(open: boolean): void;
  setSaveConflict(open: boolean): void;
  setActivationErrors(errors: ActivationErrorDetail[] | null): void;
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
    settingsOpen: false,
    shortcutsOpen: false,
    saveConflict: false,
    activationErrors: null,

    setTheme(next) {
      storeThemePreference(next);
      set({ theme: next, resolvedTheme: applyTheme(next) });
    },
    toggleSidebar(collapsed) {
      set((s) => ({ sidebarCollapsed: collapsed ?? !s.sidebarCollapsed }));
    },
    openCreator(context = {}) {
      set({ sidePanel: 'creator', creatorContext: context });
    },
    setSidePanel(panel) {
      set({ sidePanel: panel, creatorContext: {} });
    },
    openNdv(nodeName) {
      set({ ndvNode: nodeName });
    },
    setLogPanel(open) {
      set({ logPanelOpen: open });
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
  };
});

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
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
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: 'success', title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: 'error', title, description }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: 'info', title, description }),
};
