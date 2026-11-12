/**
 * P6-58 (S5, L1): audit rows become `audit.*` events. `AUDIT_EVENT_MAP` maps an audit action to its event name
 * (n8n's name less `n8n.`); a few actions map by their metadata (`eventNamesFor`): a member who joined by SSO or
 * LDAP signed up, a review decision, a switch turned on or off, a setting that changed. `AUDIT_ONLY_ACTIONS` are
 * actions that stay in the audit log and send no event (n8n has none for them). The context installs
 * `handleAuditEntry` with `addAuditListener` (repositories/resources.ts), after every audit insert.
 *
 * The payload is built lazily, so a workspace with no destination for the event pays nothing: the user's fields
 * (user-fields.ts: `userId`, `_email`, `_firstName`, `_lastName`, `globalRole`), the resource, and the row's
 * metadata with any key that could hold a secret or a value left out. The client address never goes in.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuditEntry } from '../../repositories/resources';
import { userFieldsFor } from './user-fields';

/** audit action -> event name (every target is in EVENT_CATALOG); an action here may still map by metadata */
export const AUDIT_EVENT_MAP: Readonly<Record<string, string>> = Object.freeze({
  'auth.login': 'audit.user.login.success',
  'auth.sso_login': 'audit.user.login.success',
  'auth.login_failed': 'audit.user.login.failed',
  'auth.sso_login_failed': 'audit.user.login.failed',
  'auth.signup': 'audit.user.signedup',
  // a member who joined: SSO and LDAP sign-ups map to `signedup`, an invitation to `invitation.accepted`
  'member.joined': 'audit.user.invitation.accepted',
  'member.role_changed': 'audit.user.updated',
  'auth.email_changed': 'audit.user.updated',
  'auth.password_changed': 'audit.user.updated',
  'member.removed': 'audit.user.deleted',
  'member.invited': 'audit.user.invited',
  'invitation.resent': 'audit.user.reinvited',
  'auth.password_reset': 'audit.user.reset',
  'auth.password_reset_requested': 'audit.user.reset.requested',
  'credential.created': 'audit.user.credentials.created',
  'credential.updated': 'audit.user.credentials.updated',
  'credential.deleted': 'audit.user.credentials.deleted',
  'credential.shared': 'audit.user.credentials.shared',
  'credential.user_disconnected': 'audit.user.credentials.userDisconnected',
  'apikey.created': 'audit.user.api.created',
  'apikey.deleted': 'audit.user.api.deleted',
  'apikey.revoked_by_admin': 'audit.user.api.deleted',
  'apikey.rotated': 'audit.user.api.rotated',
  'auth.mfa_enabled': 'audit.user.mfa.enabled',
  'auth.mfa_disabled': 'audit.user.mfa.disabled',
  'execution.deleted': 'audit.user.execution.deleted',
  'workflow.created': 'audit.workflow.created',
  'workflow.updated': 'audit.workflow.updated',
  'workflow.deleted': 'audit.workflow.deleted',
  'workflow.archived': 'audit.workflow.archived',
  'workflow.unarchived': 'audit.workflow.unarchived',
  'workflow.activated': 'audit.workflow.activated',
  'workflow.deactivated': 'audit.workflow.deactivated',
  'workflow.version_updated': 'audit.workflow.version.updated',
  'variable.created': 'audit.variable.created',
  'variable.updated': 'audit.variable.updated',
  'variable.deleted': 'audit.variable.deleted',
  'secret_connection.created': 'audit.external-secrets.connection.created',
  'secret_connection.updated': 'audit.external-secrets.connection.updated',
  'secret_connection.deleted': 'audit.external-secrets.connection.deleted',
  'secret_connection.tested': 'audit.external-secrets.connection.tested',
  'secret_connection.reloaded': 'audit.external-secrets.connection.reloaded',
  'workflow_review.created': 'audit.workflow-review.requested',
  'workflow_review.version_updated': 'audit.workflow-review.version-updated',
  // the decision in the metadata picks `approved` or `changes-requested`
  'workflow_review.decided': 'audit.workflow-review.approved',
  'workflow_review.closed': 'audit.workflow-review.closed',
  'type_policy.scope.updated': 'audit.node-type-policy.scope.updated',
  'type_policy.document.created': 'audit.node-type-policy.document.created',
  'type_policy.document.updated': 'audit.node-type-policy.document.updated',
  'type_policy.document.deleted': 'audit.node-type-policy.document.deleted',
  'type_policy.attachments.updated': 'audit.node-type-policy.attachments.updated',
  'policy.blocked': 'audit.policy.decision.blocked',
  'execution.data.revealed': 'audit.execution.data.revealed',
  'execution.data.reveal_failed': 'audit.execution.data.reveal_failure',
  // `metadata.enabled` picks `enabled` or `disabled`
  'public_api_rate_limit.updated': 'audit.public-api-rate-limit.enabled',
  'mcp.tool_called': 'audit.mcp.tool.called',
  'mcp.oauth_consent_granted': 'audit.mcp.oauth.completed',
  'provisioning.roles_resolved': 'audit.role-mapping.roles-resolved',
});

/**
 * audit actions that emit no event: n8n has none for them, or (the last four, plus `otel.settings_updated`) they
 * emit one only when their metadata matches a row of `eventNamesFor`
 */
export const AUDIT_ONLY_ACTIONS: ReadonlySet<string> = new Set<string>([
  'folder.created',
  'folder.updated',
  'folder.deleted',
  'folder.transferred',
  'dataTable.created',
  'dataTable.updated',
  'dataTable.deleted',
  'dataTable.column.added',
  'dataTable.column.renamed',
  'dataTable.column.moved',
  'dataTable.column.deleted',
  'dataTable.rows.inserted',
  'dataTable.rows.updated',
  'dataTable.rows.deleted',
  'dataTable.rows.cleared',
  'dataTable.imported',
  'source_control.connected',
  'source_control.disconnected',
  'source_control.preferences_updated',
  'source_control.key_generated',
  'source_control.pushed',
  'source_control.pulled',
  'source_control.read_only_changed',
  'credentials.exported_decrypted',
  'sso.method_changed',
  'sso.saml_config_updated',
  'sso.oidc_config_updated',
  'scim.token_created',
  'scim.token_revoked',
  'scim.user_created',
  'scim.user_updated',
  'scim.user_deleted',
  'ldap.config_updated',
  'ldap.synced',
  'auth.logout',
  'credential.read',
  'credential.transferred',
  'credential.user_connected',
  'credential.oauth1_connected',
  'credential.oauth2_connected',
  'execution.annotated',
  'annotation_tag.created',
  'annotation_tag.updated',
  'annotation_tag.deleted',
  'apikey.updated',
  'member.disabled',
  'member.enabled',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.member.added',
  'project.member.role_changed',
  'project.member.removed',
  'role.created',
  'role.updated',
  'role.deleted',
  'workflow.transferred',
  'workflow.moved',
  'assistant.draft_accepted',
  'assistant.mcp_connection_created',
  'assistant.mcp_connection_updated',
  'assistant.mcp_connection_deleted',
  'mcp.allowed_redirect_uris_updated',
  'mcp.oauth_grant_revoked',
  'mcp.oauth_client_deleted',
  'mcp.workflows_access_updated',
  'mcp.api_key_created',
  'mcp.api_key_rotated',
  'otel.settings_updated',
  // map by their metadata (`eventNamesFor`); a row whose metadata matches nothing stays in the audit log only
  'provisioning.updated',
  'mcp.settings_updated',
  'tenant.settings_updated',
  'tenant.security_policy_updated',
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const onOff = (base: string, on: boolean): string => `${base}.${on ? 'enabled' : 'disabled'}`;

/** the security policy settings `changed` names, and the event each one maps to */
const POLICY_EVENTS: Record<string, (metadata: Record<string, unknown>) => string> = {
  personalSpacePublishing: (m) =>
    onOff('audit.personal-publishing-restricted', m.personalSpacePublishing === false),
  personalSpaceSharing: (m) => onOff('audit.personal-sharing-restricted', m.personalSpaceSharing === false),
  redactionFloor: () => 'audit.redaction-enforcement.updated',
};

/** the event names an audit row maps to (none for an audit-only row or an unknown action) */
export function eventNamesFor(entry: AuditEntry): string[] {
  const metadata = asRecord(entry.metadata);
  switch (entry.action) {
    case 'member.joined':
      return [
        metadata.jit === true || metadata.method === 'ldap'
          ? 'audit.user.signedup'
          : 'audit.user.invitation.accepted',
      ];
    case 'workflow_review.decided':
      if (metadata.decision === 'approved') return ['audit.workflow-review.approved'];
      if (metadata.decision === 'changes_requested') return ['audit.workflow-review.changes-requested'];
      return [];
    case 'public_api_rate_limit.updated':
      return [onOff('audit.public-api-rate-limit', metadata.enabled === true)];
    case 'mcp.settings_updated':
      return typeof metadata.enabled === 'boolean' ? ['audit.mcp.access.updated'] : [];
    case 'tenant.settings_updated': {
      const names: string[] = [];
      const mfa = asRecord(metadata.mfa);
      if (typeof mfa.enforced === 'boolean') names.push(onOff('audit.2fa-enforcement', mfa.enforced));
      const reviews = asRecord(metadata.workflowReviews);
      if (typeof reviews.enabled === 'boolean') names.push(onOff('audit.workflow-reviews', reviews.enabled));
      return names;
    }
    case 'tenant.security_policy_updated': {
      const changed = Array.isArray(metadata.changed) ? metadata.changed : [];
      const names: string[] = [];
      for (const setting of changed) {
        const name = typeof setting === 'string' ? POLICY_EVENTS[setting]?.(metadata) : undefined;
        if (name) names.push(name);
      }
      return names;
    }
    case 'provisioning.updated': {
      if (entry.resourceType === 'role_mapping_rule') {
        const rule = metadata.rule;
        if (rule === 'created') return ['audit.role-mapping.rule.created'];
        if (rule === 'updated' || rule === 'moved') return ['audit.role-mapping.rule.updated'];
        if (rule === 'deleted') return ['audit.role-mapping.rule.deleted'];
        return [];
      }
      return typeof metadata.projectRulesDeleted === 'number' && metadata.projectRulesDeleted > 0
        ? ['audit.role-mapping.rules.bulk-deleted']
        : [];
    }
    default: {
      const name = AUDIT_EVENT_MAP[entry.action];
      return name ? [name] : [];
    }
  }
}

/** the payload key of a resource id, by the audit row's resource type */
const RESOURCE_KEYS: Record<string, string> = {
  user: 'targetUserId',
  credential: 'credentialId',
  workflow: 'workflowId',
  execution: 'executionId',
  api_key: 'apiKeyId',
  variable: 'variableId',
  workflow_review: 'reviewId',
  project: 'projectId',
  oauth_client: 'clientId',
  role_mapping_rule: 'ruleId',
  secret_connection: 'connectionId',
};

/** a metadata key that could hold a secret or a value never goes into an event */
const SECRET_KEY =
  /secret|token|password|passwd|cookie|authorization|dsn|header|code\b|apikey|privatekey|value/i;
const MAX_TEXT = 500;
const MAX_ITEMS = 100;
const MAX_DEPTH = 3;

function clean(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((item) => clean(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      const kept = clean(item, depth + 1);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return undefined;
}

/** the metadata an event may carry: no secret-looking key, bounded text, lists and depth */
export function eventMetadata(metadata: Record<string, unknown> | undefined): DataObject {
  const out: DataObject = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (SECRET_KEY.test(key)) continue;
    const kept = clean(value, 1);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

async function auditPayload(
  deps: ServiceDeps,
  tenantId: string,
  entry: AuditEntry,
  eventName: string,
): Promise<DataObject> {
  const metadata = eventMetadata(entry.metadata);
  const payload: DataObject = {};
  if (entry.resourceType) payload.resourceType = entry.resourceType;
  if (entry.resourceId) {
    payload[RESOURCE_KEYS[entry.resourceType ?? ''] ?? 'resourceId'] = entry.resourceId;
  }
  if (entry.action.startsWith('variable.')) {
    // the key only, never the value
    payload.variableKey = metadata.key;
    metadata.key = undefined;
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) payload[key] = value;
  }
  if (eventName === 'audit.mcp.oauth.completed' && entry.resourceId) {
    const client = await deps.repos.mcpOAuth.getClient(tenantId, entry.resourceId);
    if (client) payload.clientName = client.name;
  }
  // the user's fields come last: nothing in the metadata overwrites them
  return { ...payload, ...(await userFieldsFor(deps, tenantId, entry.userId)) };
}

/**
 * Called after every audit insert (installed with `addAuditListener`); must never throw. Emits one event per
 * name the row maps to; the payload is built only when a sink accepts the event.
 */
export function handleAuditEntry(deps: ServiceDeps, tenantId: string, entry: AuditEntry): void {
  try {
    const names = eventNamesFor(entry);
    if (names.length === 0) return;
    const { events } = deps.context();
    for (const eventName of names) {
      events.emit(tenantId, eventName, () => auditPayload(deps, tenantId, entry, eventName));
    }
  } catch (error) {
    // the context may not be ready yet; never with the entry in the log
    deps.logger.warn({ err: error, action: entry.action }, 'An audit row could not be turned into an event');
  }
}
