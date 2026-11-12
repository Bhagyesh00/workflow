// Event names for log streaming (P6-58, P6-59). n8n's event names less the `n8n.` root (owner note 5).
// No node: import: the editor bundles this file.

export type EventGroup = 'workflow' | 'node' | 'ai' | 'queue' | 'runner' | 'worker' | 'audit';

/** the 14 AI events a sub-node or AI root node reports through `logAiEvent` */
export const AI_EVENT_NAMES = [
  'ai.memory.get.messages',
  'ai.memory.added.message',
  'ai.output.parser.parsed',
  'ai.retriever.get.relevant.documents',
  'ai.embeddings.embedded.document',
  'ai.embeddings.embedded.query',
  'ai.document.processed',
  'ai.text.splitter.split',
  'ai.tool.called',
  'ai.vector.store.searched',
  'ai.llm.generated',
  'ai.llm.error',
  'ai.vector.store.populated',
  'ai.vector.store.updated',
] as const;

export type AiEventName = (typeof AI_EVENT_NAMES)[number];

const WORKFLOW_EVENTS = [
  'workflow.started',
  'workflow.success',
  'workflow.failed',
  'workflow.cancelled',
] as const;

const NODE_EVENTS = ['node.started', 'node.finished'] as const;

const QUEUE_EVENTS = [
  'queue.job.enqueued',
  'queue.job.dequeued',
  'queue.job.completed',
  'queue.job.failed',
  'queue.job.stalled',
] as const;

const RUNNER_EVENTS = ['runner.task.requested', 'runner.response.received'] as const;

const WORKER_EVENTS = ['worker.started', 'worker.stopped'] as const;

/** audit events with a producer here (an audit action mapped by the log streaming relay, or a run event) */
const AUDIT_EVENTS = [
  // users and sign-in
  'audit.user.login.success',
  'audit.user.login.failed',
  'audit.user.signedup',
  'audit.user.updated',
  'audit.user.deleted',
  'audit.user.invited',
  'audit.user.invitation.accepted',
  'audit.user.reinvited',
  'audit.user.reset',
  'audit.user.reset.requested',
  'audit.user.mfa.enabled',
  'audit.user.mfa.disabled',
  'audit.user.api.created',
  'audit.user.api.deleted',
  'audit.user.api.rotated',
  'audit.user.execution.deleted',
  // credentials
  'audit.user.credentials.created',
  'audit.user.credentials.updated',
  'audit.user.credentials.deleted',
  'audit.user.credentials.shared',
  'audit.user.credentials.userDisconnected',
  // workflows and runs
  'audit.workflow.created',
  'audit.workflow.updated',
  'audit.workflow.deleted',
  'audit.workflow.archived',
  'audit.workflow.unarchived',
  'audit.workflow.activated',
  'audit.workflow.deactivated',
  'audit.workflow.version.updated',
  'audit.workflow.executed',
  'audit.workflow.resumed',
  'audit.workflow.waiting',
  // variables
  'audit.variable.created',
  'audit.variable.updated',
  'audit.variable.deleted',
  // external secrets connections
  'audit.external-secrets.connection.created',
  'audit.external-secrets.connection.updated',
  'audit.external-secrets.connection.deleted',
  'audit.external-secrets.connection.tested',
  'audit.external-secrets.connection.reloaded',
  // workflow reviews
  'audit.workflow-review.requested',
  'audit.workflow-review.version-updated',
  'audit.workflow-review.approved',
  'audit.workflow-review.changes-requested',
  'audit.workflow-review.closed',
  'audit.workflow-reviews.enabled',
  'audit.workflow-reviews.disabled',
  // node type policies
  'audit.node-type-policy.scope.updated',
  'audit.node-type-policy.document.created',
  'audit.node-type-policy.document.updated',
  'audit.node-type-policy.document.deleted',
  'audit.node-type-policy.attachments.updated',
  'audit.policy.decision.blocked',
  // execution data redaction
  'audit.execution.data.revealed',
  'audit.execution.data.reveal_failure',
  'audit.redaction-enforcement.updated',
  // workspace security settings
  'audit.public-api-rate-limit.enabled',
  'audit.public-api-rate-limit.disabled',
  'audit.personal-publishing-restricted.enabled',
  'audit.personal-publishing-restricted.disabled',
  'audit.personal-sharing-restricted.enabled',
  'audit.personal-sharing-restricted.disabled',
  'audit.2fa-enforcement.enabled',
  'audit.2fa-enforcement.disabled',
  // MCP
  'audit.mcp.tool.called',
  'audit.mcp.oauth.completed',
  'audit.mcp.access.updated',
  // SSO role mapping
  'audit.role-mapping.rule.created',
  'audit.role-mapping.rule.updated',
  'audit.role-mapping.rule.deleted',
  'audit.role-mapping.rules.bulk-deleted',
  'audit.role-mapping.roles-resolved',
] as const;

export type EventName =
  | (typeof WORKFLOW_EVENTS)[number]
  | (typeof NODE_EVENTS)[number]
  | AiEventName
  | (typeof QUEUE_EVENTS)[number]
  | (typeof RUNNER_EVENTS)[number]
  | (typeof WORKER_EVENTS)[number]
  | (typeof AUDIT_EVENTS)[number];

function entries(group: EventGroup, names: readonly EventName[]): Array<{ name: string; group: EventGroup }> {
  return names.map((name) => ({ name, group }));
}

/** every event a destination can subscribe to, with its group */
export const EVENT_CATALOG: ReadonlyArray<{ name: string; group: EventGroup }> = Object.freeze([
  ...entries('workflow', WORKFLOW_EVENTS),
  ...entries('node', NODE_EVENTS),
  ...entries('ai', AI_EVENT_NAMES),
  ...entries('queue', QUEUE_EVENTS),
  ...entries('runner', RUNNER_EVENTS),
  ...entries('worker', WORKER_EVENTS),
  ...entries('audit', AUDIT_EVENTS),
]);

/** the event a destination test sends (never stored, never in the catalog) */
export const DESTINATION_TEST_EVENT = 'destination.test';

/** the group of an event name: its first segment (`audit.user.login.success` -> `audit`) */
export function eventGroupOf(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/**
 * true when `name` is subscribed: `*` takes every event, any other entry matches as a prefix (a group or one name).
 * An empty entry matches nothing.
 */
export function matchesSubscription(name: string, subscribed: string[]): boolean {
  for (const entry of subscribed) {
    if (entry === '*') return true;
    if (entry !== '' && name.startsWith(entry)) return true;
  }
  return false;
}
