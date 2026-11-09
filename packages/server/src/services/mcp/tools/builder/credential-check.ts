/**
 * The credential check of the MCP build tools (P5-13): a client may only attach credentials of its
 * own workspace. Every reference in `node.credentials` is checked, whatever the node's parameters say:
 * an expression as the node's auth type, or a display rule that hides the slot, never skips it. A
 * node of an inline workflow (a JSON text in a `workflowJson` parameter, as Execute Workflow takes it)
 * is read as data and checked the same way. Nothing is evaluated.
 *
 * P6-35: with a `projectId` the same references are also checked with `assertCredentialsUsable`: a credential
 * of another project that is not shared with it, not global, is refused with n8n's text.
 */
import type { WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import type { ServerContext } from '../../../../context';
import {
  assertCredentialsUsable,
  InaccessibleCredentialError,
  InvalidCredentialError,
} from '../../../credential-usable';
import { McpToolError } from '../../workflow-gate';

/** how deep inline workflows may nest before the rest is refused */
const MAX_INLINE_DEPTH = 5;
/** how deep into a node's parameters the scan for `workflowJson` goes */
const MAX_PARAMETER_DEPTH = 12;

export const MCP_CREDENTIAL_TEXTS = {
  notInWorkspace: (id: string) => `Credential "${id}" was not found in this workspace`,
  badReference: 'A credential reference must be an object with a string "id" (or null) and a "name"',
  tooDeep: 'Inline workflows are nested too deep',
} as const;

/** the parsed inline workflows found in the parameters of a node (strings only; expressions are skipped) */
function inlineWorkflows(value: unknown, depth: number, found: unknown[]): void {
  if (depth > MAX_PARAMETER_DEPTH || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) inlineWorkflows(entry, depth + 1, found);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'workflowJson' && typeof entry === 'string' && !entry.trimStart().startsWith('=')) {
      try {
        found.push(JSON.parse(entry));
      } catch {
        // not JSON: the node fails when it runs; there is nothing to check
      }
    } else if (key === 'workflowJson' && entry !== null && typeof entry === 'object') {
      found.push(entry);
    } else {
      inlineWorkflows(entry, depth + 1, found);
    }
  }
}

/** every credential id a list of nodes refers to, inline workflows included */
function collectCredentialIds(
  nodes: unknown,
  depth: number,
  ids: Set<string>,
  flat: WorkflowNode[] = [],
): void {
  if (!Array.isArray(nodes)) return;
  if (depth > MAX_INLINE_DEPTH) throw new McpToolError(MCP_CREDENTIAL_TEXTS.tooDeep);
  for (const raw of nodes) {
    if (raw === null || typeof raw !== 'object') continue;
    const node = raw as { credentials?: unknown; parameters?: unknown };
    flat.push(raw as WorkflowNode);
    if (node.credentials !== undefined && node.credentials !== null) {
      if (typeof node.credentials !== 'object' || Array.isArray(node.credentials)) {
        throw new McpToolError(MCP_CREDENTIAL_TEXTS.badReference);
      }
      for (const ref of Object.values(node.credentials as Record<string, unknown>)) {
        if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
          throw new McpToolError(MCP_CREDENTIAL_TEXTS.badReference);
        }
        const id = (ref as { id?: unknown }).id;
        if (id === undefined || id === null) continue;
        if (typeof id !== 'string') throw new McpToolError(MCP_CREDENTIAL_TEXTS.badReference);
        if (id) ids.add(id);
      }
    }
    const inline: unknown[] = [];
    inlineWorkflows(node.parameters, 0, inline);
    for (const workflow of inline) {
      if (workflow !== null && typeof workflow === 'object') {
        collectCredentialIds((workflow as { nodes?: unknown }).nodes, depth + 1, ids, flat);
      }
    }
  }
}

/**
 * Throws on the first credential reference that is not a credential of `tenantId`. A reference with
 * no id is a lookup by name inside the tenant at run time and cannot reach another workspace. With a
 * `projectId`, every reference (the inline workflows' too) must also be usable in that project.
 */
export async function assertCredentialsInTenant(
  ctx: ServerContext,
  tenantId: string,
  definition: WorkflowDefinition,
  projectId?: string,
): Promise<void> {
  const ids = new Set<string>();
  const flat: WorkflowNode[] = [];
  collectCredentialIds(definition.nodes, 0, ids, flat);
  for (const id of ids) {
    const row = await ctx.repos.credentials.get(tenantId, id);
    if (!row || row.tenantId !== tenantId) throw new McpToolError(MCP_CREDENTIAL_TEXTS.notInWorkspace(id));
  }
  if (!projectId || !flat.length) return;
  try {
    await assertCredentialsUsable(ctx, tenantId, projectId, { ...definition, nodes: flat });
  } catch (error) {
    if (error instanceof InaccessibleCredentialError || error instanceof InvalidCredentialError) {
      throw new McpToolError(`${error.message}. ${error.description}`);
    }
    throw error;
  }
}
