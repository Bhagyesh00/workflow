/**
 * Open sub-workflows and credentials from the editor (P3-12, as n8n useWorkflowCommands):
 * - a sub-workflow per Execute Workflow node whose workflowId has a value (name, else id), opened
 *   in a new tab (noreferrer); also Ctrl/Cmd+Shift+O and the node context menu;
 * - a credential per distinct credential the nodes use, opened in the editor's credential modal
 *   (ui.openCredentialId, rendered by OpenCredentialHost).
 */
import { useQuery } from '@tanstack/react-query';
import type { Scope, WorkflowNode } from '@workflow/workflow';
import { useCallback } from 'react';
import { create } from 'zustand';
import { projectsApi } from '../../api/endpoints';
import { queryKeys, useMe, useProject } from '../../api/queries';
import type { Me, WorkflowDTO } from '../../api/types';
import { canWith } from '../../lib/permissions';
import { useProjectStore } from '../../stores/project-store';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

/**
 * P6-43: the project and the caller's scopes of the workflow open in the editor (the store keeps neither):
 * the workflow's gates read `scopes`, pickers and loaders read `projectId`. Set when the page loads it.
 */
interface OpenWorkflowState {
  id: string | undefined;
  projectId: string | null;
  scopes: Scope[] | undefined;
  set(dto: Pick<WorkflowDTO, 'id' | 'projectId' | 'scopes'>): void;
  clear(): void;
}

export const useOpenWorkflowStore = create<OpenWorkflowState>()((set) => ({
  id: undefined,
  projectId: null,
  scopes: undefined,
  set: (dto) => set({ id: dto.id, projectId: dto.projectId ?? null, scopes: dto.scopes }),
  clear: () => set({ id: undefined, projectId: null, scopes: undefined }),
}));

/** the open workflow as a scoped row (nothing while another workflow's scopes are held) */
export function openWorkflowResource(): { scopes?: Scope[] } {
  const open = useOpenWorkflowStore.getState();
  const id = useWorkflowStore.getState().meta.id;
  return open.id && open.id === id ? { scopes: open.scopes } : {};
}

/** `can(scope)` for the open workflow: the workspace role's scopes, or the workflow's own */
export function useOpenWorkflowCan(): (scope: Scope) => boolean {
  const me = useMe().data;
  const scopes = useOpenWorkflowStore((s) => s.scopes);
  const openId = useOpenWorkflowStore((s) => s.id);
  const id = useWorkflowStore((s) => s.meta.id);
  const own = openId && openId === id ? scopes : undefined;
  return useCallback((scope: Scope) => canWith(me, scope, { scopes: own }), [me, own]);
}

/** the same check outside React (archive actions), over a `me` read from the cache */
export function canOnOpenWorkflow(me: Pick<Me, 'globalScopes'> | null | undefined, scope: Scope): boolean {
  return canWith(me, scope, openWorkflowResource());
}

/** the project the user works in: the open workflow's, else the project page's (null on Overview) */
export function useWorkingProjectId(): string | null {
  const openId = useOpenWorkflowStore((s) => s.id);
  const openProject = useOpenWorkflowStore((s) => s.projectId);
  const id = useWorkflowStore((s) => s.meta.id);
  const current = useProjectStore((s) => s.currentProjectId);
  return (openId && openId === id ? openProject : null) ?? current;
}

/** the same, read outside React (a mutation's body) */
export function workingProjectId(): string | undefined {
  const open = useOpenWorkflowStore.getState();
  const id = useWorkflowStore.getState().meta.id;
  return (
    ((open.id && open.id === id ? open.projectId : null) ?? useProjectStore.getState().currentProjectId) ||
    undefined
  );
}

/**
 * May the caller change the workflow in the editor: `workflow:update` on a saved one, `workflow:create` in
 * the working project (else the personal project) on a new one. False until `me` loads.
 */
export function useCanEditWorkflow(): boolean {
  const me = useMe().data;
  const id = useWorkflowStore((s) => s.meta.id);
  const openId = useOpenWorkflowStore((s) => s.id);
  const scopes = useOpenWorkflowStore((s) => s.scopes);
  const working = useWorkingProjectId();
  const project = useProject(id ? null : working);
  const personal = useQuery({
    queryKey: queryKeys.personalProject,
    queryFn: projectsApi.personal,
    enabled: !id && !working,
    staleTime: 60_000,
    retry: false,
  });
  if (id) return canWith(me, 'workflow:update', { scopes: openId === id ? scopes : undefined });
  return canWith(me, 'workflow:create', working ? project.data : personal.data);
}

/**
 * The project a node's credential picker works in: the working project (the open workflow's), else the
 * personal project, where an unsaved workflow on `/workflow/new` is saved. Null while that one loads.
 */
export function useCredentialProjectId(): string | null {
  const working = useWorkingProjectId();
  const personal = useQuery({
    queryKey: queryKeys.personalProject,
    queryFn: projectsApi.personal,
    enabled: !working,
    staleTime: 60_000,
    retry: false,
  });
  return working ?? personal.data?.id ?? null;
}

/**
 * What a node option, list or mapper call names so the server knows whose credentials it may use: the saved
 * workflow, else the working project (the personal project on `/home/*`). `ready` is false until one of the
 * two ids is known, so a call never goes out naming neither.
 */
export function useOptionsScope(): { workflowId?: string; projectId?: string; ready: boolean } {
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const working = useWorkingProjectId();
  const personal = useQuery({
    queryKey: queryKeys.personalProject,
    queryFn: projectsApi.personal,
    enabled: !workflowId && !working,
    staleTime: 60_000,
    retry: false,
  });
  if (workflowId) return { workflowId, ready: true };
  const projectId = working ?? personal.data?.id;
  return { projectId, ready: Boolean(projectId) };
}

export interface SubWorkflowTarget {
  nodeName: string;
  workflowId: string;
  /** the selected workflow's name when known, else its id */
  label: string;
}

export interface CredentialTarget {
  id: string;
  name: string;
  /** credential type name */
  type: string;
}

const EXECUTE_WORKFLOW = 'core.executeWorkflow';

/** the same pattern the By URL mode of the Execute Workflow node extracts its id with */
const WORKFLOW_URL_ID = /\/workflows?\/([0-9a-zA-Z_-]+)/;

/** the workflow id a locator value stands for; null for an empty value, an expression or an unreadable URL */
function readId(value: unknown, mode?: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text || text.startsWith('=')) return null;
  if (mode === 'url') return WORKFLOW_URL_ID.exec(text)?.[1] ?? null;
  return text;
}

/** the workflow id and cached name a node's workflowId parameter holds (plain string or resource locator) */
function readTarget(node: WorkflowNode): { id: string; name: string } | null {
  if (node.type !== EXECUTE_WORKFLOW) return null;
  const source = node.parameters.source;
  if (source !== undefined && source !== 'database') return null;
  const raw = node.parameters.workflowId;
  if (typeof raw === 'string') {
    const id = readId(raw);
    return id ? { id, name: '' } : null;
  }
  if (raw && typeof raw === 'object') {
    const rl = raw as { value?: unknown; mode?: unknown; cachedResultName?: unknown };
    const id = readId(rl.value, rl.mode);
    if (!id) return null;
    return { id, name: typeof rl.cachedResultName === 'string' ? rl.cachedResultName.trim() : '' };
  }
  return null;
}

export function subWorkflowTargets(nodes: readonly WorkflowNode[]): SubWorkflowTarget[] {
  const out: SubWorkflowTarget[] = [];
  for (const node of nodes) {
    const target = readTarget(node);
    if (target) out.push({ nodeName: node.name, workflowId: target.id, label: target.name || target.id });
  }
  return out;
}

export function credentialTargets(nodes: readonly WorkflowNode[]): CredentialTarget[] {
  const seen = new Set<string>();
  const out: CredentialTarget[] = [];
  for (const node of nodes) {
    for (const [type, ref] of Object.entries(node.credentials ?? {})) {
      if (!ref?.id || seen.has(ref.id)) continue;
      seen.add(ref.id);
      out.push({ id: ref.id, name: ref.name || ref.id, type });
    }
  }
  return out;
}

/** the app address of a workflow, for a new tab (hash routing keeps the page and sets the fragment) */
function workflowUrl(workflowId: string): string {
  const path = `workflow/${encodeURIComponent(workflowId)}`;
  const { origin, pathname, hash } = window.location;
  if (hash.startsWith('#/')) return `${origin}${pathname}#/${path}`;
  const base = import.meta.env.BASE_URL || '/';
  return `${origin}${base.endsWith('/') ? base : `${base}/`}${path}`;
}

/** Open the workflow the named Execute Workflow node calls (no-op for other nodes). */
export function openSubWorkflow(nodeName: string): void {
  const node = useWorkflowStore.getState().nodes.find((n) => n.name === nodeName);
  const target = node ? subWorkflowTargets([node])[0] : undefined;
  if (!target) return;
  window.open(workflowUrl(target.workflowId), '_blank', 'noopener,noreferrer');
}

export function openCredential(credentialId: string): void {
  useUiStore.getState().setOpenCredentialId(credentialId);
}
