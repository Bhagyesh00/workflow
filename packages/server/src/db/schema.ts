/**
 * PostgreSQL schema (ARCHITECTURE.md §5). Every table except `users` carries `tenant_id`;
 * repositories always filter by it. Migrations are generated from this file with drizzle-kit
 * (`pnpm db:generate`) into `packages/server/migrations`.
 */
import type {
  AiContentPart,
  AiToolCall,
  AssistantAttachmentRef,
  AssistantConfirmAnswer,
  AssistantConfirmation,
  AssistantEvent,
  AssistantPermissionMode,
  AssistantTask,
  BinaryData,
  BuilderMessage,
  DataObject,
  EvaluationMetrics,
  Scope,
  TestCaseErrorCode,
  TestCaseStatus,
  TestRunErrorCode,
  TestRunStatus,
  WorkflowDefinition,
} from '@workflow/workflow';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { Role } from './role-types';

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
    /** P6-02: the workspace whose SCIM client created this user; only it may change name and email */
    managedByTenantId: uuid('managed_by_tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
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
    /** P6-01: this member may still sign in with a password while SSO is on */
    allowSsoManualLogin: boolean('allow_sso_manual_login').notNull().default(false),
    /** P6-20: last request of this member in this workspace, written at most once a day */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    /** P6-20: set while the member is disabled; a disabled member cannot sign in to this workspace */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    /** P6-02: the SCIM client's id for this member, unique per workspace */
    externalId: text('external_id'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index('memberships_user_idx').on(t.userId),
    uniqueIndex('memberships_tenant_external_id_idx')
      .on(t.tenantId, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

/** project icon as n8n stores it: an icon name or an emoji */
export interface ProjectIcon {
  type: 'icon' | 'emoji';
  value: string;
}

/**
 * Projects (P6-01): every workflow, credential, folder and data table belongs to one. Each workspace has team
 * projects (shared, members join through `project_relations`) and one personal project per member, owned by
 * `owner_user_id`. Removing the member removes the personal project; the app moves or wipes its work first.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    type: text('type').$type<'personal' | 'team'>().notNull(),
    icon: jsonb('icon').$type<ProjectIcon>(),
    description: varchar('description', { length: 512 }),
    /** the member a personal project belongs to; null for team projects */
    ownerUserId: uuid('owner_user_id'),
    creatorId: uuid('creator_id').references(() => users.id, { onDelete: 'set null' }),
    /** custom telemetry tags (P6-67) */
    customTelemetryTags: jsonb('custom_telemetry_tags').$type<unknown[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('projects_tenant_id_unique').on(t.tenantId, t.id),
    uniqueIndex('projects_tenant_personal_owner_idx')
      .on(t.tenantId, t.ownerUserId)
      .where(sql`${t.type} = 'personal'`),
    index('projects_tenant_type_idx').on(t.tenantId, t.type),
    check('projects_type_check', sql`${t.type} in ('personal', 'team')`),
    foreignKey({
      name: 'projects_owner_membership_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
  ],
);

/**
 * A member's role in a project (`project:admin`, `project:editor`, `project:viewer`, `project:personalOwner`
 * or a custom project role slug). Composite keys keep both ends inside the tenant.
 */
export const projectRelations = pgTable(
  'project_relations',
  {
    tenantId: uuid('tenant_id').notNull(),
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    foreignKey({
      name: 'project_relations_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_relations_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    index('project_relations_tenant_user_idx').on(t.tenantId, t.userId),
  ],
);

/** custom roles (P6-11): a project or global role with its own scope list, per workspace */
export const roles = pgTable(
  'roles',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    roleType: text('role_type').$type<'project' | 'global'>().notNull(),
    scopes: text('scopes').array().$type<Scope[]>().notNull().default(sql`'{}'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('roles_tenant_slug_unique').on(t.tenantId, t.slug),
    unique('roles_tenant_display_name_unique').on(t.tenantId, t.displayName),
    check('roles_role_type_check', sql`${t.roleType} in ('project', 'global')`),
  ],
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
    /** P6-01: how the session was opened; SSO sessions are fenced from global account changes */
    authMethod: text('auth_method')
      .$type<'password' | 'saml' | 'oidc' | 'ldap'>()
      .notNull()
      .default('password'),
    /** P6-18: the second factor was checked when the session opened (or the IdP did it, for SSO) */
    mfaVerified: boolean('mfa_verified').notNull().default(false),
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
    /**
     * P5-04: who the key is for, `public-api` (the API keys page) or `mcp-server-api` (the MCP
     * server); a key works only on its own audience
     */
    audience: text('audience').notNull().default('public-api'),
    /** P6-21: the key stops working after this time; null never expires */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('api_keys_tenant_idx').on(t.tenantId),
    index('api_keys_tenant_user_audience_idx').on(t.tenantId, t.userId, t.audience),
  ],
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
    /** owning project (P6-01) */
    projectId: uuid('project_id').notNull(),
    parentFolderId: uuid('parent_folder_id').references((): AnyPgColumn => folders.id, {
      onDelete: 'cascade',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('folders_tenant_parent_idx').on(t.tenantId, t.parentFolderId),
    index('folders_tenant_project_parent_idx').on(t.tenantId, t.projectId, t.parentFolderId),
    foreignKey({
      name: 'folders_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }),
  ],
);

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** owning project (P6-01) */
    projectId: uuid('project_id').notNull(),
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
    index('workflows_tenant_project_updated_idx').on(t.tenantId, t.projectId, t.updatedAt, t.id),
    unique('workflows_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'workflows_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }),
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

/** per-user favorites (P3-07, P4-03, P6-01): workflows, folders, data tables and projects */
export const userFavorites = pgTable(
  'user_favorites',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').$type<'workflow' | 'folder' | 'dataTable' | 'project'>().notNull(),
    resourceId: uuid('resource_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.resourceType, t.resourceId] }),
    index('user_favorites_tenant_user_idx').on(t.tenantId, t.userId),
    check(
      'user_favorites_resource_type_check',
      sql`${t.resourceType} in ('workflow', 'folder', 'dataTable', 'project')`,
    ),
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
    /** external secret names the credential reads (P4-07), never their values */
    secretKeys: text('secret_keys').array().notNull().default(sql`'{}'`),
    /** owning project (P6-01) */
    projectId: uuid('project_id').notNull(),
    /** usable by every project of the workspace (n8n's `isGlobal`) */
    isGlobal: boolean('is_global').notNull().default(false),
    /** P6-15: a private credential, each user connects their own account (rows in `credential_user_entries`) */
    isResolvable: boolean('is_resolvable').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('credentials_tenant_idx').on(t.tenantId, t.type),
    index('credentials_tenant_project_type_idx').on(t.tenantId, t.projectId, t.type),
    unique('credentials_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'credentials_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }),
  ],
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
    /** P6-15: the run used a user's own connection of a private credential (its data stays hidden) */
    usedPrivateCredentials: boolean('used_private_credentials').notNull().default(false),
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
    /** null = a workspace variable; else a project variable, which wins over the workspace one in its project */
    projectId: uuid('project_id'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('variables_tenant_key_global_idx').on(t.tenantId, t.key).where(sql`${t.projectId} is null`),
    uniqueIndex('variables_tenant_project_key_idx')
      .on(t.tenantId, t.projectId, t.key)
      .where(sql`${t.projectId} is not null`),
    foreignKey({
      name: 'variables_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('cascade'),
  ],
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
    /** the reviewed version; no FK (as executions): the id stays after compaction prunes the version */
    workflowVersionId: uuid('workflow_version_id'),
    /** the published version before an approval's auto-publish (NULL when none); no FK, kept when pruned */
    approvedBaselineVersionId: uuid('approved_baseline_version_id'),
    state: text('state').$type<'open' | 'closed'>().notNull().default('open'),
    decision: text('decision')
      .$type<'pending' | 'changes_requested' | 'approved'>()
      .notNull()
      .default('pending'),
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

/**
 * Data tables (P4-03): user tables kept per workspace. Cell values live in `data_table_rows.data`, keyed by column name;
 * `next_row_id` hands out the per-table row ids. Unique constraints, not indexes: the composite foreign keys need
 * (tenant_id, id) to exist before they are added.
 */
export const dataTables = pgTable(
  'data_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    /** owning project (P6-01) */
    projectId: uuid('project_id').notNull(),
    nextRowId: bigint('next_row_id', { mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('data_tables_tenant_project_name_unique').on(t.tenantId, t.projectId, t.name),
    unique('data_tables_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'data_tables_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }),
  ],
);

export const dataTableColumns = pgTable(
  'data_table_columns',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    tableId: uuid('table_id').notNull(),
    name: varchar('name', { length: 63 }).notNull(),
    type: text('type').$type<'string' | 'number' | 'boolean' | 'date'>().notNull(),
    position: integer('position').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('data_table_columns_table_name_unique').on(t.tableId, t.name),
    foreignKey({
      name: 'data_table_columns_table_fk',
      columns: [t.tenantId, t.tableId],
      foreignColumns: [dataTables.tenantId, dataTables.id],
    }).onDelete('cascade'),
    index('data_table_columns_table_position_idx').on(t.tableId, t.position),
    check('data_table_columns_type_check', sql`${t.type} in ('string', 'number', 'boolean', 'date')`),
  ],
);

export const dataTableRows = pgTable(
  'data_table_rows',
  {
    tenantId: uuid('tenant_id').notNull(),
    tableId: uuid('table_id').notNull(),
    rowId: bigint('row_id', { mode: 'number' }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** size of `data` in bytes, summed for the workspace storage limit */
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tableId, t.rowId] }),
    foreignKey({
      name: 'data_table_rows_table_fk',
      columns: [t.tenantId, t.tableId],
      foreignColumns: [dataTables.tenantId, dataTables.id],
    }).onDelete('cascade'),
    index('data_table_rows_tenant_table_idx').on(t.tenantId, t.tableId),
  ],
);

/** External secrets vault connections (P4-07). `settings_enc` is a CredentialCipher payload. */
export const secretConnections = pgTable(
  'secret_connections',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    providerKey: text('provider_key').notNull(),
    type: text('type').notNull(),
    settingsEnc: text('settings_enc').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    state: text('state')
      .$type<'initializing' | 'initialized' | 'connecting' | 'connected' | 'error' | 'retrying'>()
      .notNull()
      .default('initializing'),
    lastError: text('last_error'),
    /** owning project (P6-28); null = a workspace connection. The provider key stays unique per workspace */
    projectId: uuid('project_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('secret_connections_tenant_provider_key_unique').on(t.tenantId, t.providerKey),
    unique('secret_connections_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'secret_connections_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('cascade'),
  ],
);

/** a workflow shared with another project (P6-29); the sharee gets `role` (`workflow:editor`) */
export const workflowShares = pgTable(
  'workflow_shares',
  {
    tenantId: uuid('tenant_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    projectId: uuid('project_id').notNull(),
    role: text('role').notNull().default('workflow:editor'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workflowId, t.projectId] }),
    foreignKey({
      name: 'workflow_shares_workflow_fk',
      columns: [t.tenantId, t.workflowId],
      foreignColumns: [workflows.tenantId, workflows.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_shares_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('cascade'),
    index('workflow_shares_tenant_project_idx').on(t.tenantId, t.projectId),
  ],
);

/** a credential shared with another project (P6-29); the sharee gets `role` (`credential:user`) */
export const credentialShares = pgTable(
  'credential_shares',
  {
    tenantId: uuid('tenant_id').notNull(),
    credentialId: uuid('credential_id').notNull(),
    projectId: uuid('project_id').notNull(),
    role: text('role').notNull().default('credential:user'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.credentialId, t.projectId] }),
    foreignKey({
      name: 'credential_shares_credential_fk',
      columns: [t.tenantId, t.credentialId],
      foreignColumns: [credentials.tenantId, credentials.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'credential_shares_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('cascade'),
    index('credential_shares_tenant_project_idx').on(t.tenantId, t.projectId),
  ],
);

/** a project's access to a vault connection (P6-28); `role` is `secretsProviderConnection:user` */
export const projectSecretAccess = pgTable(
  'project_secret_access',
  {
    tenantId: uuid('tenant_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    projectId: uuid('project_id').notNull(),
    role: text('role').notNull().default('secretsProviderConnection:user'),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.projectId] }),
    foreignKey({
      name: 'project_secret_access_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [secretConnections.tenantId, secretConnections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_secret_access_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('cascade'),
    index('project_secret_access_tenant_project_idx').on(t.tenantId, t.projectId),
  ],
);

/**
 * Evaluation test runs (P5-02). One row per run of a workflow's evaluation; `updated_at` is the
 * heartbeat the sweep reads. `workflow_version_id` has no FK: versions can be pruned.
 */
export const testRuns = pgTable(
  'test_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).$type<TestRunStatus>().notNull().default('new'),
    runAt: timestamp('run_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    metrics: jsonb('metrics').$type<EvaluationMetrics>(),
    errorCode: varchar('error_code', { length: 64 }).$type<TestRunErrorCode>(),
    errorDetails: jsonb('error_details').$type<DataObject>(),
    runningInstanceId: text('running_instance_id'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    workflowVersionId: uuid('workflow_version_id'),
    concurrency: integer('concurrency').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('test_runs_tenant_workflow_idx').on(t.tenantId, t.workflowId, t.createdAt.desc().nullsFirst()),
    // the sweep reads only unfinished runs
    index('test_runs_active_status_idx').on(t.status).where(sql`${t.status} in ('new', 'running')`),
  ],
);

/**
 * One row per dataset row of a test run (P5-02); `run_index` is the dataset index. `execution_id` has
 * no FK: pruning deletes executions and the case row stays.
 */
export const testCaseExecutions = pgTable(
  'test_case_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    testRunId: uuid('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id'),
    status: varchar('status', { length: 24 }).$type<TestCaseStatus>().notNull().default('new'),
    runIndex: integer('run_index').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 64 }).$type<TestCaseErrorCode>(),
    errorDetails: jsonb('error_details').$type<DataObject>(),
    metrics: jsonb('metrics').$type<EvaluationMetrics>(),
    inputs: jsonb('inputs').$type<DataObject>(),
    outputs: jsonb('outputs').$type<DataObject>(),
    createdAt: createdAt(),
  },
  (t) => [index('test_case_executions_run_idx').on(t.testRunId, t.runIndex)],
);

/** P5-14: how an MCP OAuth client authenticates at the token endpoint (RFC 7591) */
export type OAuthClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/**
 * MCP OAuth clients registered per workspace (P5-14, RFC 7591). `id` is the public client id; only the
 * SHA-256 of a client secret is stored.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    grantTypes: jsonb('grant_types').$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').$type<OAuthClientAuthMethod>().notNull(),
    clientSecretHash: text('client_secret_hash'),
    clientSecretExpiresAt: timestamp('client_secret_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_clients_tenant_idx').on(t.tenantId)],
);

/** P5-14: authorization codes, stored as SHA-256, single use (`used`), 10 minutes */
export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull(),
  state: text('state'),
  /** the MCP server or trigger URL the code is bound to (RFC 8707) */
  resource: text('resource').notNull(),
  scope: text('scope').array().notNull().default(sql`'{}'::text[]`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  used: boolean('used').notNull().default(false),
});

/** columns shared by the access and the refresh token tables (P5-14); tokens stored as SHA-256 */
const oauthTokenColumns = () => ({
  tokenHash: text('token_hash').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  resource: text('resource').notNull(),
  scope: text('scope').array().notNull().default(sql`'{}'::text[]`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const oauthAccessTokens = pgTable('oauth_access_tokens', oauthTokenColumns(), (t) => [
  index('oauth_access_tokens_tenant_user_idx').on(t.tenantId, t.userId),
  index('oauth_access_tokens_expires_idx').on(t.expiresAt),
]);

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', oauthTokenColumns(), (t) => [
  index('oauth_refresh_tokens_tenant_user_idx').on(t.tenantId, t.userId),
  index('oauth_refresh_tokens_expires_idx').on(t.expiresAt),
]);

/** P5-14: the scopes a user granted a client, one row per user and client */
export const oauthUserConsents = pgTable(
  'oauth_user_consents',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    scope: text('scope').array().notNull().default(sql`'{}'::text[]`),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().default(nowMs),
  },
  (t) => [unique('oauth_user_consents_tenant_user_client_unique').on(t.tenantId, t.userId, t.clientId)],
);

/**
 * The AI builder chat of one user on one workflow (P5-66). `previous_summary` holds the compacted
 * history; `allowed_web_domains` the hosts the user approved for web fetch in this session (P5-64).
 */
export const workflowBuilderSessions = pgTable(
  'workflow_builder_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messages: jsonb('messages').$type<BuilderMessage[]>().notNull().default([]),
    previousSummary: text('previous_summary'),
    activeVersionCardId: text('active_version_card_id'),
    resumeAfterRestoreMessageId: text('resume_after_restore_message_id'),
    allowedWebDomains: jsonb('allowed_web_domains').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('workflow_builder_sessions_tenant_workflow_user_unique').on(t.tenantId, t.workflowId, t.userId),
  ],
);

/**
 * A workflow the Assistant built on a thread and the user has not accepted yet (P5-67, filled by L7).
 * Keyed by its id in `assistant_threads.drafts`; the lane may store more keys than these.
 */
export interface AssistantStoredDraft {
  id: string;
  name: string;
  /** the workflow the draft changes; null for a new workflow */
  workflowId: string | null;
  /** the version the draft was built on, so Accept can refuse a workflow changed since */
  baseVersionId: string | null;
  definition: WorkflowDefinition;
  createdAt: string;
  [key: string]: unknown;
}

/** an attachment as a message stores it: the reference the DTO shows plus the stored binary */
export type AssistantStoredAttachment = AssistantAttachmentRef & { binary: BinaryData };

/**
 * Assistant threads (P5-67): one user's chat in one tenant. `active_run_id` is the run lock
 * (`acquireRun` sets it only while it is null) and `run_heartbeat_at` the heartbeat the sweep reads.
 * `grants` holds the session "always allow" keys, `drafts` the unaccepted workflows by id.
 */
export const assistantThreads = pgTable(
  'assistant_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    observations: text('observations'),
    tasks: jsonb('tasks').$type<AssistantTask[]>().notNull().default([]),
    grants: jsonb('grants').$type<string[]>().notNull().default([]),
    drafts: jsonb('drafts').$type<Record<string, AssistantStoredDraft>>().notNull().default({}),
    activeRunId: text('active_run_id'),
    runHeartbeatAt: timestamp('run_heartbeat_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('assistant_threads_tenant_user_updated_idx').on(t.tenantId, t.userId, t.updatedAt),
    index('assistant_threads_run_heartbeat_idx').on(t.runHeartbeatAt),
  ],
);

/**
 * Assistant messages (P5-67), in `seq` order. `content`, `tool_calls`, `tool_call_id` and `name` are
 * the agent loop's message; `summarized` rows were folded into the thread's observations.
 */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid('id').notNull().unique().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => assistantThreads.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    role: text('role').$type<'system' | 'user' | 'assistant' | 'tool'>().notNull(),
    content: jsonb('content').$type<string | AiContentPart[]>().notNull(),
    toolCalls: jsonb('tool_calls').$type<AiToolCall[]>(),
    toolCallId: text('tool_call_id'),
    name: text('name'),
    attachments: jsonb('attachments').$type<AssistantStoredAttachment[]>(),
    summarized: boolean('summarized').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('assistant_messages_tenant_thread_seq_idx').on(t.tenantId, t.threadId, t.seq)],
);

/** Assistant durable events (P5-67): the replay log of a thread's stream, in `id` order. */
export const assistantEvents = pgTable(
  'assistant_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => assistantThreads.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    type: text('type').$type<AssistantEvent['type']>().notNull(),
    payload: jsonb('payload').$type<AssistantEvent>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('assistant_events_tenant_thread_id_idx').on(t.tenantId, t.threadId, t.id)],
);

/** the answer a card gets from the server, not a person: a cancel, a timeout, a stopped run */
export interface AssistantSystemAnswer {
  kind: 'system';
  reason: string;
}

/**
 * Assistant confirmation cards (P5-68): one row per tool call that waits for a person. Status moves
 * `pending` to `approved`, `denied` or `expired` (one atomic claim), and `approved` to `executed`
 * once the tool ran. `expires_at` null means no timeout. `grant_key` null offers no "always allow".
 */
export const assistantPendingConfirmations = pgTable(
  'assistant_pending_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => assistantThreads.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    toolCallId: text('tool_call_id').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').$type<DataObject>().notNull(),
    inputType: text('input_type').$type<AssistantConfirmation['inputType']>().notNull(),
    details: jsonb('details').$type<AssistantConfirmation['details']>().notNull(),
    grantKey: text('grant_key'),
    /** `pending`, `approved`, `denied`, `expired`, `executed` */
    status: text('status')
      .$type<'pending' | 'approved' | 'denied' | 'expired' | 'executed'>()
      .notNull()
      .default('pending'),
    answer: jsonb('answer').$type<AssistantConfirmAnswer | AssistantSystemAnswer>(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    unique('assistant_pending_confirmations_thread_tool_call_unique').on(t.threadId, t.toolCallId),
    index('assistant_pending_confirmations_tenant_user_status_idx').on(t.tenantId, t.userId, t.status),
    index('assistant_pending_confirmations_expires_idx').on(t.expiresAt),
  ],
);

/**
 * The workspace's MCP servers for the Assistant (P5-72). Holds a credential id, never a secret;
 * `tool_permissions` (tool name to mode) may only tighten the workspace's `mcpRead`/`mcpWrite`.
 */
export const assistantMcpConnections = pgTable(
  'assistant_mcp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    transport: text('transport').$type<'httpStreamable' | 'sse'>().notNull().default('httpStreamable'),
    /** as the MCP Client node: `none`, `bearerAuth`, `headerAuth`, `multipleHeadersAuth`, `mcpOAuth2Api` */
    authentication: text('authentication')
      .$type<'none' | 'bearerAuth' | 'headerAuth' | 'multipleHeadersAuth' | 'mcpOAuth2Api'>()
      .notNull()
      .default('none'),
    credentialId: uuid('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    toolPermissions: jsonb('tool_permissions')
      .$type<Record<string, AssistantPermissionMode>>()
      .notNull()
      .default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('assistant_mcp_connections_tenant_name_unique').on(t.tenantId, t.name)],
);

/**
 * P6-01: a workspace's sign-in method and its SAML, OIDC and LDAP settings, one row per workspace.
 * Secrets (`oidc_secret_enc`, `ldap_password_enc`) are CredentialCipher payloads, never plain text.
 */
export const tenantAuthSettings = pgTable(
  'tenant_auth_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    method: text('method').$type<'email' | 'saml' | 'oidc' | 'ldap'>().notNull().default('email'),
    saml: jsonb('saml').$type<Record<string, unknown>>(),
    /** the identity provider's metadata XML as saved */
    samlMetadata: text('saml_metadata'),
    oidc: jsonb('oidc').$type<Record<string, unknown>>(),
    oidcSecretEnc: text('oidc_secret_enc'),
    ldap: jsonb('ldap').$type<Record<string, unknown>>(),
    ldapPasswordEnc: text('ldap_password_enc'),
    /** P6-11: which claims drive workspace and project roles */
    provisioning: jsonb('provisioning').$type<Record<string, unknown>>(),
    /** create a member on the first SSO sign-in (just in time) */
    jit: boolean('jit').notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [check('tenant_auth_settings_method_check', sql`${t.method} in ('email', 'saml', 'oidc', 'ldap')`)],
);

/** P6-01: the SAML, OIDC or LDAP identity a member signs in with, unique per workspace and provider */
export const authIdentities = pgTable(
  'auth_identities',
  {
    tenantId: uuid('tenant_id').notNull(),
    providerType: text('provider_type').$type<'saml' | 'oidc' | 'ldap'>().notNull(),
    /** the provider's id for the person (SAML NameID, OIDC `sub`, LDAP login id) */
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.providerType, t.providerId] }),
    foreignKey({
      name: 'auth_identities_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    index('auth_identities_tenant_user_idx').on(t.tenantId, t.userId),
    check('auth_identities_provider_type_check', sql`${t.providerType} in ('saml', 'oidc', 'ldap')`),
  ],
);

/**
 * P6-18: a user's authenticator (TOTP) secret and recovery codes. Global like `users`, so no tenant_id and no
 * RLS. `secret_enc` is a CredentialCipher payload (binding `user:<id>`); recovery codes are SHA-256 hex.
 */
export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEnc: text('secret_enc').notNull(),
  recoveryHashes: text('recovery_hashes').array().notNull().default(sql`'{}'`),
  /** null while setup is not finished */
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  /** the last TOTP time step used, so a code works once */
  lastStep: bigint('last_step', { mode: 'number' }),
  createdAt: createdAt(),
});

/**
 * P6-19: password reset and email change tokens, global like `users`. Only the SHA-256 of a token is
 * stored; `used_at` makes it single use.
 */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'password_reset' | 'email_change'>().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** what the token carries, for example the new email address */
    data: jsonb('data').$type<Record<string, unknown>>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('user_tokens_user_kind_idx').on(t.userId, t.kind),
    check('user_tokens_kind_check', sql`${t.kind} in ('password_reset', 'email_change')`),
  ],
);

/**
 * P6-11: role mapping rules. An `instance` rule gives a workspace role, a `project` rule a project role in the
 * projects listed in `role_mapping_rule_projects`, when its expression matches the SSO claims. Rules run by
 * `order`, unique per workspace and type.
 */
export const roleMappingRules = pgTable(
  'role_mapping_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').$type<'instance' | 'project'>().notNull(),
    expression: text('expression').notNull(),
    /** a workspace role slug for `instance` rules, a project role slug for `project` rules */
    role: text('role').notNull(),
    order: integer('order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('role_mapping_rules_tenant_id_unique').on(t.tenantId, t.id),
    unique('role_mapping_rules_tenant_type_order_unique').on(t.tenantId, t.type, t.order),
    check('role_mapping_rules_type_check', sql`${t.type} in ('instance', 'project')`),
  ],
);

/** P6-11: the projects a `project` role mapping rule applies to; both ends inside the tenant */
export const roleMappingRuleProjects = pgTable(
  'role_mapping_rule_projects',
  {
    tenantId: uuid('tenant_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    projectId: uuid('project_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ruleId, t.projectId] }),
    foreignKey({
      name: 'role_mapping_rule_projects_rule_fk',
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [roleMappingRules.tenantId, roleMappingRules.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'role_mapping_rule_projects_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete('cascade'),
    index('role_mapping_rule_projects_tenant_project_idx').on(t.tenantId, t.projectId),
  ],
);

/**
 * P6-12: one row per directory sync run (LDAP today), per workspace. `run_mode` is `dry` or `live`, `status`
 * `success` or `error`, as n8n's sync history.
 */
export const authProviderSyncHistory = pgTable(
  'auth_provider_sync_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    providerType: text('provider_type').notNull(),
    runMode: text('run_mode').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().default(nowMs),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    scanned: integer('scanned').notNull().default(0),
    created: integer('created').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    disabled: integer('disabled').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('auth_provider_sync_history_tenant_started_idx').on(t.tenantId, t.startedAt.desc())],
);

/** P6-02: a workspace's SCIM bearer token, one per workspace; only its SHA-256 and a short hint are stored */
export const scimTokens = pgTable('scim_tokens', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  /** the last characters of the token, shown in the settings page */
  tokenHint: text('token_hint').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/**
 * P6-15: one user's own connection of a private credential (`credentials.is_resolvable`). `data_enc` is a
 * CredentialCipher payload. Both ends stay inside the tenant; removing the member removes the row.
 */
export const credentialUserEntries = pgTable(
  'credential_user_entries',
  {
    tenantId: uuid('tenant_id').notNull(),
    credentialId: uuid('credential_id').notNull(),
    userId: uuid('user_id').notNull(),
    dataEnc: text('data_enc').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.credentialId, t.userId] }),
    foreignKey({
      name: 'credential_user_entries_credential_fk',
      columns: [t.tenantId, t.credentialId],
      foreignColumns: [credentials.tenantId, credentials.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'credential_user_entries_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    index('credential_user_entries_tenant_user_idx').on(t.tenantId, t.userId),
  ],
);

/**
 * P6-16: a workspace's RSA keys for JWE token responses of OAuth2 credentials (`jweEnabled`), served as JWKS
 * at `/.well-known/jwks/:slug.json`. `private_enc` is a CredentialCipher payload (binding `jwe:<kid>`).
 */
export const oauthJweKeys = pgTable(
  'oauth_jwe_keys',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kid: text('kid').notNull(),
    privateEnc: text('private_enc').notNull(),
    publicJwk: jsonb('public_jwk').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kid] })],
);

export type { LegacyRole, Role, SystemRole } from './role-types';

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
export type DataTableRow = typeof dataTables.$inferSelect;
export type DataTableColumnRow = typeof dataTableColumns.$inferSelect;
export type DataTableRowRow = typeof dataTableRows.$inferSelect;
export type SecretConnectionRow = typeof secretConnections.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectRelationRow = typeof projectRelations.$inferSelect;
export type CustomRoleRow = typeof roles.$inferSelect;
export type WorkflowShareRow = typeof workflowShares.$inferSelect;
export type CredentialShareRow = typeof credentialShares.$inferSelect;
export type ProjectSecretAccessRow = typeof projectSecretAccess.$inferSelect;
export type TestRunRow = typeof testRuns.$inferSelect;
export type TestCaseExecutionRow = typeof testCaseExecutions.$inferSelect;
export type AnnotationTagRow = typeof annotationTags.$inferSelect;
export type ExecutionAnnotationRow = typeof executionAnnotations.$inferSelect;
export type PublishHistoryRow = typeof workflowPublishHistory.$inferSelect;
export type WorkflowReviewRequestRow = typeof workflowReviewRequests.$inferSelect;
export type TenantAuthSettingsRow = typeof tenantAuthSettings.$inferSelect;
export type AuthIdentityRow = typeof authIdentities.$inferSelect;
export type UserMfaRow = typeof userMfa.$inferSelect;
export type UserTokenRow = typeof userTokens.$inferSelect;
export type RoleMappingRuleRow = typeof roleMappingRules.$inferSelect;
export type RoleMappingRuleProjectRow = typeof roleMappingRuleProjects.$inferSelect;
export type AuthProviderSyncHistoryRow = typeof authProviderSyncHistory.$inferSelect;
export type ScimTokenRow = typeof scimTokens.$inferSelect;
export type CredentialUserEntryRow = typeof credentialUserEntries.$inferSelect;
export type OAuthJweKeyRow = typeof oauthJweKeys.$inferSelect;
