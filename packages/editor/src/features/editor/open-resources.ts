/**
 * Open sub-workflows and credentials from the editor (P3-12, as n8n useWorkflowCommands):
 * - a sub-workflow per Execute Workflow node whose workflowId has a value (name, else id), opened
 *   in a new tab (noreferrer); also Ctrl/Cmd+Shift+O and the node context menu;
 * - a credential per distinct credential the nodes use, opened in the editor's credential modal
 *   (ui.openCredentialId, rendered by OpenCredentialHost).
 */
import type { WorkflowNode } from '@workflow/workflow';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

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
