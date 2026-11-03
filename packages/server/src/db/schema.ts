/**
 * PostgreSQL schema (ARCHITECTURE.md §5). Every table except `users` carries `tenant_id`;
 * repositories always filter by it. Migrations are generated from this file with drizzle-kit
 * (`pnpm db:generate`) into `packages/server/migrations`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// millisecond precision so keyset cursors (JS Dates) round-trip exactly
const nowMs = sql`date_trunc('milliseconds', now())`;
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().default(nowMs);
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().default(nowMs);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('unlimited'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** stored lower-cased */
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] }), index('memberships_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256(token) hex */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<Role>().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('invitations_tenant_idx').on(t.tenantId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('api_keys_tenant_idx').on(t.tenantId)],
);

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nodes: jsonb('nodes').$type<unknown[]>().notNull().default([]),
    connections: jsonb('connections').$type<Record<string, unknown>>().notNull().default({}),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    pinData: jsonb('pin_data').$type<Record<string, unknown>>().notNull().default({}),
    staticData: jsonb('static_data').$type<Record<string, unknown>>().notNull().default({}),
    stickyNotes: jsonb('sticky_notes').$type<unknown[]>().notNull().default([]),
    active: boolean('active').notNull().default(false),
    versionId: uuid('version_id').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('workflows_tenant_updated_idx').on(t.tenantId, t.updatedAt, t.id),
    index('workflows_active_idx').on(t.active),
  ],
);

export const workflowVersions = pgTable(
  'workflow_versions',
  {
    /** = workflows.version_id at the time of the save */
    id: uuid('id').primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nodes: jsonb('nodes').$type<unknown[]>().notNull(),
    connections: jsonb('connections').$type<Record<string, unknown>>().notNull(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
    stickyNotes: jsonb('sticky_notes').$type<unknown[]>().notNull().default([]),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    message: text('message'),
    createdAt: createdAt(),
  },
  (t) => [index('workflow_versions_workflow_idx').on(t.tenantId, t.workflowId, t.createdAt)],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tags_tenant_name_idx').on(t.tenantId, t.name)],
);

export const workflowTags = pgTable(
  'workflow_tags',
  {
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.tagId] }), index('workflow_tags_tag_idx').on(t.tagId)],
);

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    /** CredentialCipher payload, AAD = tenantId:credentialId */
    dataEnc: text('data_enc').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('credentials_tenant_idx').on(t.tenantId, t.type)],
);

export const executions = pgTable(
  'executions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
    /** name at the time of the run (inline sub-workflows have no row in `workflows`) */
    workflowName: text('workflow_name').notNull().default(''),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    waitTill: timestamp('wait_till', { withTimezone: true }),
    retryOf: uuid('retry_of'),
    retrySuccessId: uuid('retry_success_id'),
    parentExecutionId: uuid('parent_execution_id'),
    customData: jsonb('custom_data').$type<Record<string, string>>().notNull().default({}),
    errorMessage: text('error_message'),
    errorNode: text('error_node'),
    createdAt: createdAt(),
  },
  (t) => [
    index('executions_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    index('executions_tenant_workflow_idx').on(t.tenantId, t.workflowId, t.createdAt),
    index('executions_status_wait_idx').on(t.status, t.waitTill),
    index('executions_stopped_idx').on(t.stoppedAt),
  ],
);

export const executionData = pgTable('execution_data', {
  executionId: uuid('execution_id')
    .primaryKey()
    .references(() => executions.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** workflow snapshot used for the run */
  workflowData: jsonb('workflow_data').$type<Record<string, unknown>>().notNull(),
  /** ExecutionState */
  state: jsonb('state').$type<Record<string, unknown> | null>(),
  /** how to start / resume the run (start node, trigger items, pin data, resume output...) */
  runOptions: jsonb('run_options').$type<Record<string, unknown>>().notNull().default({}),
});

export const webhooks = pgTable(
  'webhooks',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    nodeName: text('node_name').notNull(),
    webhookName: text('webhook_name').notNull().default('default'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    isDynamic: boolean('is_dynamic').notNull().default(false),
    segments: integer('segments').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.method, t.path] }),
    index('webhooks_workflow_idx').on(t.workflowId),
    index('webhooks_dynamic_idx').on(t.tenantId, t.method, t.isDynamic, t.segments),
  ],
);

export const variables = pgTable(
  'variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('variables_tenant_key_idx').on(t.tenantId, t.key)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_tenant_idx').on(t.tenantId, t.id)],
);

export const usageCounters = pgTable(
  'usage_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** YYYY-MM */
    period: text('period').notNull(),
    executions: integer('executions').notNull().default(0),
    executionMs: bigint('execution_ms', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.period] })],
);

/** Webhook idempotency keys (platform extension): duplicate deliveries replay the first response. */
export const webhookIdempotency = pgTable(
  'webhook_idempotency',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    executionId: uuid('execution_id'),
    /** null while the first request is still in progress */
    response: jsonb('response').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.workflowId, t.key] }),
    index('webhook_idempotency_created_idx').on(t.createdAt),
  ],
);

/**
 * Last cron slot a Schedule Trigger rule fired or dropped, so a restart can find the missed slots
 * and two leaders cannot both run one. `rule_key` is a hash of the cron expression and timezone.
 */
export const scheduleSlots = pgTable(
  'schedule_slots',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    nodeName: text('node_name').notNull(),
    ruleKey: text('rule_key').notNull(),
    lastSlot: timestamp('last_slot', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.nodeName, t.ruleKey] })],
);

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export type TenantRow = typeof tenants.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type CredentialRow = typeof credentials.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type ExecutionDataRow = typeof executionData.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type VariableRow = typeof variables.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
