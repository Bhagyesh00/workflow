/**
 * PostgreSQL schema (ARCHITECTURE.md §5). Every table except `users` carries `tenant_id`;
 * repositories always filter by it. Migrations are generated from this file with drizzle-kit
 * (`pnpm db:generate`) into `packages/server/migrations`.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
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

/** workflow folders (P3-07); a folder may sit inside another folder of the same tenant */
export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    parentFolderId: uuid('parent_folder_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('folders_tenant_parent_idx').on(t.tenantId, t.parentFolderId)],
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
    nodeGroups: jsonb('node_groups').$type<unknown[]>().notNull().default([]),
    active: boolean('active').notNull().default(false),
    versionId: uuid('version_id').notNull(),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    isArchived: boolean('is_archived').notNull().default(false),
    /** the published (running) version; null = not published. No FK: compaction may prune versions */
    publishedVersionId: uuid('published_version_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('workflows_tenant_updated_idx').on(t.tenantId, t.updatedAt, t.id),
    index('workflows_active_idx').on(t.active),
    index('workflows_tenant_folder_idx').on(t.tenantId, t.folderId),
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
    nodeGroups: jsonb('node_groups').$type<unknown[]>().notNull().default([]),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    message: text('message'),
    versionName: varchar('version_name', { length: 128 }),
    description: text('description'),
    /** saved by the editor's autosave (P3-17) */
    autosaved: boolean('autosaved').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('workflow_versions_workflow_idx').on(t.tenantId, t.workflowId, t.createdAt)],
);

/** per-user favorites (P3-07): workflows and folders */
export const userFavorites = pgTable(
  'user_favorites',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').$type<'workflow' | 'folder'>().notNull(),
    resourceId: uuid('resource_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.resourceType, t.resourceId] }),
    index('user_favorites_tenant_user_idx').on(t.tenantId, t.userId),
    check('user_favorites_resource_type_check', sql`${t.resourceType} in ('workflow', 'folder')`),
  ],
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

/** tags on folders (P3-07 addendum); same tag table as workflows */
export const folderTags = pgTable(
  'folder_tags',
  {
    folderId: uuid('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.tagId] }), index('folder_tags_tag_idx').on(t.tagId)],
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
    /** the workflow version that ran (no FK: versions can be pruned) */
    workflowVersionId: uuid('workflow_version_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('executions_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    index('executions_tenant_workflow_idx').on(t.tenantId, t.workflowId, t.createdAt),
    index('executions_status_wait_idx').on(t.status, t.waitTill),
    index('executions_stopped_idx').on(t.stoppedAt),
    index('executions_tenant_version_idx').on(t.tenantId, t.workflowVersionId),
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

/** execution annotation tags (P3-09); separate from workflow tags, as n8n */
export const annotationTags = pgTable(
  'annotation_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 24 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('annotation_tags_tenant_name_idx').on(t.tenantId, sql`lower(${t.name})`)],
);

/** one annotation (vote) per execution (P3-09) */
export const executionAnnotations = pgTable(
  'execution_annotations',
  {
    executionId: uuid('execution_id')
      .primaryKey()
      .references(() => executions.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    vote: text('vote').$type<'up' | 'down'>(),
    updatedAt: updatedAt(),
  },
  (t) => [check('execution_annotations_vote_check', sql`${t.vote} in ('up', 'down')`)],
);

export const executionAnnotationTags = pgTable(
  'execution_annotation_tags',
  {
    executionId: uuid('execution_id')
      .notNull()
      .references(() => executions.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => annotationTags.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.executionId, t.tagId] }),
    index('execution_annotation_tags_tag_idx').on(t.tagId),
  ],
);

/** publish timeline (P3-16): one row per publish / unpublish; version_id NULL once the version is pruned */
export const workflowPublishHistory = pgTable(
  'workflow_publish_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => workflowVersions.id, { onDelete: 'set null' }),
    event: text('event').$type<'activated' | 'deactivated'>().notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('workflow_publish_history_workflow_idx').on(t.tenantId, t.workflowId, t.id.desc()),
    check('workflow_publish_history_event_check', sql`${t.event} in ('activated', 'deactivated')`),
  ],
);

// workflow reviews (P3-19): a request pins one version for review before publish

export const workflowReviewRequests = pgTable(
  'workflow_review_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    workflowVersionId: uuid('workflow_version_id').references(() => workflowVersions.id, {
      onDelete: 'set null',
    }),
    /** the published version before an approval's auto-publish (NULL when none) */
    approvedBaselineVersionId: uuid('approved_baseline_version_id').references(() => workflowVersions.id, {
      onDelete: 'set null',
    }),
    state: text('state').$type<'open' | 'closed'>().notNull().default('open'),
    decision: text('decision').$type<'pending' | 'changes_requested' | 'approved'>().notNull().default('pending'),
    title: varchar('title', { length: 128 }).notNull(),
    description: text('description'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workflow_review_requests_open_idx').on(t.workflowId).where(sql`${t.state} = 'open'`),
    index('workflow_review_requests_tenant_idx').on(t.tenantId, t.updatedAt),
    check('workflow_review_requests_state_check', sql`${t.state} in ('open', 'closed')`),
    check(
      'workflow_review_requests_decision_check',
      sql`${t.decision} in ('pending', 'changes_requested', 'approved')`,
    ),
  ],
);

export const workflowReviewReviewers = pgTable(
  'workflow_review_reviewers',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => workflowReviewRequests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.userId] }),
    index('workflow_review_reviewers_user_idx').on(t.tenantId, t.userId),
  ],
);

export const workflowReviewAuthors = pgTable(
  'workflow_review_authors',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => workflowReviewRequests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.userId] }),
    index('workflow_review_authors_user_idx').on(t.tenantId, t.userId),
  ],
);

export const workflowReviewActivity = pgTable(
  'workflow_review_activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => workflowReviewRequests.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('workflow_review_activity_request_idx').on(t.requestId, t.id)],
);

export const workflowReviewComments = pgTable(
  'workflow_review_comments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    activityId: bigint('activity_id', { mode: 'number' })
      .notNull()
      .references(() => workflowReviewActivity.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('workflow_review_comments_activity_idx').on(t.activityId)],
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
export type FolderRow = typeof folders.$inferSelect;
export type UserFavoriteRow = typeof userFavorites.$inferSelect;
export type AnnotationTagRow = typeof annotationTags.$inferSelect;
export type ExecutionAnnotationRow = typeof executionAnnotations.$inferSelect;
export type PublishHistoryRow = typeof workflowPublishHistory.$inferSelect;
export type WorkflowReviewRequestRow = typeof workflowReviewRequests.$inferSelect;
