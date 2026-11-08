/**
 * Webhook registration data derived from node descriptions (ARCHITECTURE.md §11).
 *
 * Path rules:
 * - an empty path becomes the node's `webhookId` (or its id);
 * - a path coming from an expression (user-chosen, e.g. the Webhook node's "Path") or marked
 *   `isFullPath` is used verbatim;
 * - a fixed path in the description (e.g. `webhook` in an app trigger) is relative and gets
 *   prefixed with the node's `webhookId`, so two nodes never collide.
 * Dynamic segments (`users/:id`) match after static paths, fewer dynamic segments first.
 */
import { getResolvedParameters } from '@workflow/core';
import {
  type DataObject,
  evaluateSimple,
  isExpression,
  type NodeType,
  type WebhookDescription,
  type Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import type { Config } from '../config';

export interface NodeWebhook {
  nodeName: string;
  webhookName: string;
  method: string;
  path: string;
  isDynamic: boolean;
  segments: number;
  responseMode: string;
  responseData: string;
  description: WebhookDescription;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function evaluateDescriptionValue(value: string | undefined, parameters: DataObject): unknown {
  if (value === undefined) return undefined;
  let current: unknown = value;
  // a description expression may resolve to a parameter that is itself an expression
  for (let i = 0; i < 2 && isExpression(current); i++) {
    current = evaluateSimple(current, { $parameter: parameters }, { timeoutMs: 200 });
  }
  return current;
}

/**
 * The URL family of a hook: `/form`, `/form-test` for a form hook, `/mcp`, `/mcp-test` (the
 * `config.mcp` endpoints) for an MCP Server Trigger hook, else `/webhook`, `/webhook-test`.
 */
export function webhookUrlBase(
  description: Pick<WebhookDescription, 'nodeType'>,
): 'webhook' | 'form' | 'mcp' {
  if (description.nodeType === 'form') return 'form';
  if (description.nodeType === 'mcp') return 'mcp';
  return 'webhook';
}

/**
 * The public URL of a hook. `/webhook` and `/form` hooks live on `config.baseUrl` with `-test` for
 * test URLs; MCP hooks live on `config.mcp.baseUrl` under `config.mcp.endpoint` or `endpointTest`.
 */
export function hookUrl(
  config: Pick<Config, 'baseUrl' | 'mcp'>,
  description: Pick<WebhookDescription, 'nodeType'>,
  test: boolean,
  slug: string,
  path: string,
): string {
  const family = webhookUrlBase(description);
  if (family === 'mcp') {
    return `${config.mcp.baseUrl}/${test ? config.mcp.endpointTest : config.mcp.endpoint}/${slug}/${path}`;
  }
  return `${config.baseUrl}/${family}${test ? '-test' : ''}/${slug}/${path}`;
}

export function normalizePath(path: string): string {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

export function isDynamicPath(path: string): boolean {
  return path.split('/').some((s) => s.startsWith(':'));
}

/** match `users/:id` against `users/42` → `{ id: '42' }` */
export function matchDynamic(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      if (!s[i]) return null;
      params[p[i].slice(1)] = decodeURIComponent(s[i]);
    } else if (p[i] !== s[i]) return null;
  }
  return params;
}

/** dynamic patterns sorted by specificity: fewer dynamic segments, then later first dynamic segment */
export function sortDynamic<T extends { path: string }>(rows: T[]): T[] {
  const score = (path: string) => {
    const parts = path.split('/');
    const dynamic = parts.filter((s) => s.startsWith(':')).length;
    const firstDynamic = parts.findIndex((s) => s.startsWith(':'));
    return { dynamic, firstDynamic };
  };
  return [...rows].sort((a, b) => {
    const x = score(a.path);
    const y = score(b.path);
    return x.dynamic - y.dynamic || y.firstDynamic - x.firstDynamic;
  });
}

/**
 * Webhooks of a node. `restart` selects resume webhooks (Wait node) instead of regular ones.
 * Throws with a readable message when the method or path is invalid.
 */
export function nodeWebhooks(
  workflow: Workflow,
  node: WorkflowNode,
  nodeType: NodeType,
  options: { restart?: boolean } = {},
): NodeWebhook[] {
  const descriptions = (nodeType.description.webhooks ?? []).filter(
    (w) => Boolean(w.restartWebhook) === Boolean(options.restart),
  );
  if (!descriptions.length) return [];
  const parameters = getResolvedParameters(workflow, node) as DataObject;
  return descriptions.map((description) => {
    const method = String(
      evaluateDescriptionValue(description.httpMethod, parameters) ?? 'GET',
    ).toUpperCase();
    if (!METHODS.has(method)) throw new Error(`Invalid HTTP method "${method}"`);
    const rawPath = String(evaluateDescriptionValue(description.path, parameters) ?? '');
    const base = node.webhookId || node.id;
    let path = normalizePath(rawPath);
    if (!path) path = base;
    else if (!description.isFullPath && !isExpression(description.path)) path = `${base}/${path}`;
    if (path.length > 512) throw new Error('The webhook path is too long');
    if (path.split('/').some((s) => s === ':' || s === '.' || s === '..')) {
      throw new Error(`Invalid webhook path "${path}"`);
    }
    const responseMode = String(
      evaluateDescriptionValue(description.responseMode, parameters) ?? 'onReceived',
    );
    const responseData = String(
      evaluateDescriptionValue(description.responseData, parameters) ?? 'firstEntryJson',
    );
    return {
      nodeName: node.name,
      webhookName: description.name,
      method,
      path,
      isDynamic: isDynamicPath(path),
      segments: path.split('/').length,
      responseMode,
      responseData,
      description,
    };
  });
}

/** every regular webhook of every enabled node of the workflow */
export function workflowWebhooks(workflow: Workflow): Array<NodeWebhook & { node: WorkflowNode }> {
  const out: Array<NodeWebhook & { node: WorkflowNode }> = [];
  for (const node of Object.values(workflow.nodes)) {
    if (node.disabled) continue;
    const type = workflow.nodeTypes.get(node.type);
    if (!type?.webhook && !type?.description.webhooks?.length) continue;
    if (!type) continue;
    for (const hook of nodeWebhooks(workflow, node, type)) out.push({ ...hook, node });
  }
  return out;
}
