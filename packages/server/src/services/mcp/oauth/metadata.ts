/**
 * Discovery documents of the MCP OAuth server (P5-14). Issuer `${config.mcp.baseUrl}/mcp-oauth/<slug>`
 * (`mcpOAuthIssuer`); RFC 8414 at `/.well-known/oauth-authorization-server/<base path>/mcp-oauth/<slug>`
 * (path insertion); RFC 9728 at `/.well-known/oauth-protected-resource/<base path>/mcp-server/<slug>/http`
 * and `/.well-known/oauth-protected-resource/<base path>/<endpoint>/<slug>/<path>` (`mcpResourceMetadataUrl`).
 *
 * Also the one place that says which `resource` values a tenant has: its tenant server URL while its MCP
 * access is on, and the URLs of its MCP Server Triggers with workspace sign-in (a published, active one
 * on the production endpoint, a listening one on the test endpoint) whatever the access switch says (as
 * n8n: the switch gates only the tenant server).
 */
import type { WorkflowNode } from '@workflow/workflow';
import type { Config } from '../../../config';
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';
import { loadPublishedDefinition } from '../../published-workflow';
import { findTestWebhook } from '../../test-webhooks';
import { matchDynamic, normalizePath, sortDynamic, webhookUrlBase } from '../../webhook-paths';
import { mcpAccessEnabled } from '../settings';
import { MCP_SCOPES, mcpOAuthIssuer, mcpServerUrl } from '../types';

/** RFC 8414 authorization server metadata of the tenant (S256 only, the four endpoints, `MCP_SCOPES`) */
export function mcpAuthorizationServerMetadata(config: Config, tenantSlug: string): Record<string, unknown> {
  const issuer = mcpOAuthIssuer(config, tenantSlug);
  const authMethods = ['none', 'client_secret_post', 'client_secret_basic'];
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: authMethods,
    revocation_endpoint_auth_methods_supported: authMethods,
    scopes_supported: [...MCP_SCOPES],
    // RFC 9207: the redirect back to the client carries `iss`
    authorization_response_iss_parameter_supported: true,
  };
}

/** which kind of trigger a resource URL names: an MCP Server Trigger, or a Webhook with workspace sign-in */
export type TriggerResourceFamily = 'mcp' | 'webhook';

/** the HTTP methods a Webhook node can listen on; a resource names no method, so every one is tried */
export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

/**
 * the parts of a trigger URL `<mcp base>/<endpoint>/<slug>/<path>` (an MCP Server Trigger), or
 * `<mcp base>/webhook[-test]/<slug>/<path>` (a Webhook with workspace sign-in, P6-87: its resource follows
 * `config.mcp.baseUrl` too); null when it is neither
 */
export function parseMcpTriggerResource(
  config: Config,
  resource: string,
): { test: boolean; slug: string; path: string; family: TriggerResourceFamily } | null {
  const base = `${config.mcp.baseUrl}/`;
  if (typeof resource !== 'string' || !resource.startsWith(base)) return null;
  const rest = resource.slice(base.length);
  if (/[?#\s]/.test(rest)) return null;
  const [endpoint, rawSlug, ...segments] = rest.split('/');
  let family: TriggerResourceFamily = 'mcp';
  let test = endpoint === config.mcp.endpointTest;
  if (!test && endpoint !== config.mcp.endpoint) {
    if (endpoint !== 'webhook' && endpoint !== 'webhook-test') return null;
    family = 'webhook';
    test = endpoint === 'webhook-test';
  }
  let slug: string;
  let decoded: string[];
  try {
    slug = decodeURIComponent(rawSlug ?? '');
    decoded = segments.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  const path = normalizePath(decoded.join('/'));
  // one spelling only: no empty, padded or trailing segments
  if (!slug || !path || path !== decoded.join('/')) return null;
  return { test, slug, path, family };
}

/** an enabled MCP Server Trigger with "Workspace sign-in": only those are resources (as n8n) */
function isMcpTriggerNode(ctx: ServerContext, node: WorkflowNode | undefined): boolean {
  if (!node || node.disabled || node.parameters?.authentication !== 'n8nOAuth2') return false;
  const type = ctx.registries.nodeTypes.get(node.type);
  return Boolean(type?.description.webhooks?.some((hook) => webhookUrlBase(hook) === 'mcp'));
}

/** an enabled Webhook node with "Workspace sign-in (OAuth2)" (P6-87): the only Webhook that is a resource */
export function isWebhookSignInNode(node: WorkflowNode | undefined): boolean {
  return Boolean(
    node && !node.disabled && node.type === 'core.webhook' && node.parameters?.authentication === 'n8nOAuth2',
  );
}

/**
 * the nodes that serve `path` of this tenant now, one per method asked about: a published, active
 * workflow's node on the production endpoint, a listening one on the test endpoint
 */
export async function triggerNodesAt(
  ctx: ServerContext,
  tenantId: string,
  test: boolean,
  path: string,
  methods: readonly string[],
): Promise<Array<WorkflowNode | undefined>> {
  const { repos } = ctx;
  const nodes: Array<WorkflowNode | undefined> = [];
  for (const method of methods) {
    if (test) {
      const found = await findTestWebhook(ctx.testWebhooks, tenantId, method, path);
      if (found) {
        nodes.push(found.registration.workflow.nodes.find((n) => n.name === found.registration.nodeName));
      }
      continue;
    }
    let found = await repos.webhooks.findStatic(tenantId, method, path);
    if (!found) {
      const candidates = sortDynamic(await repos.webhooks.listDynamic(tenantId, method, path.split('/').length));
      found = candidates.find((candidate) => matchDynamic(candidate.path, path) !== null);
    }
    if (!found) continue;
    const { nodeName, workflowId } = found;
    const row = await repos.workflows.get(tenantId, workflowId);
    if (!row?.active) continue;
    try {
      const definition = await loadPublishedDefinition(repos, tenantId, row);
      nodes.push(definition?.nodes.find((n) => n.name === nodeName));
    } catch {
      /* a definition that cannot be read serves nothing */
    }
  }
  return nodes;
}

/** whether `resource` is the URL of one of the tenant's triggers with workspace sign-in that serves now */
export async function isTenantTriggerResource(
  ctx: ServerContext,
  tenant: TenantRow,
  resource: string,
): Promise<boolean> {
  const parsed = parseMcpTriggerResource(ctx.config, resource);
  if (!parsed || parsed.slug !== tenant.slug) return false;
  if (parsed.family === 'webhook') {
    const nodes = await triggerNodesAt(ctx, tenant.id, parsed.test, parsed.path, WEBHOOK_METHODS);
    return nodes.some(isWebhookSignInNode);
  }
  const nodes = await triggerNodesAt(ctx, tenant.id, parsed.test, parsed.path, ['POST']);
  return nodes.some((node) => isMcpTriggerNode(ctx, node));
}

/** whether `resource` is this tenant's server URL (only while MCP access is on) or one of its trigger URLs */
export async function isTenantMcpResource(
  ctx: ServerContext,
  tenant: TenantRow,
  resource: string,
): Promise<boolean> {
  if (resource === mcpServerUrl(ctx.config, tenant.slug)) return mcpAccessEnabled(ctx.config, tenant);
  return isTenantTriggerResource(ctx, tenant, resource);
}

/**
 * RFC 9728 protected resource metadata for a resource path (`mcp-server/<slug>/http`, or a trigger's
 * `<endpoint>/<slug>/<path>`); null when the path names no resource of this tenant (404).
 */
export async function mcpProtectedResourceMetadata(
  ctx: ServerContext,
  tenant: TenantRow,
  resourcePath: string,
): Promise<Record<string, unknown> | null> {
  const path = resourcePath.replace(/^\/+/, '');
  const resource = `${ctx.config.mcp.baseUrl}/${path}`;
  if (!(await isTenantMcpResource(ctx, tenant, resource))) return null;
  const server = resource === mcpServerUrl(ctx.config, tenant.slug);
  return {
    resource,
    authorization_servers: [mcpOAuthIssuer(ctx.config, tenant.slug)],
    bearer_methods_supported: ['header'],
    scopes_supported: [...MCP_SCOPES],
    resource_name: server
      ? `${tenant.name} MCP server`
      : path.startsWith('webhook')
        ? `${tenant.name} Webhook`
        : `${tenant.name} MCP Server Trigger`,
  };
}
