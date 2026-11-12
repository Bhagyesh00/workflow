/**
 * In-memory implementation of the REST + SSE contract (docs/ARCHITECTURE.md section 14). It
 * backs the self-contained demo build and the test suite (behind MSW), so both exercise the
 * real client code paths. It is a stand-in: no persistence, a single browser session.
 */
import {
  CHAT_TRIGGER_TYPE,
  type Connections,
  type DataObject,
  diffWorkflows,
  type ExecutionState,
  GLOBAL_ROLE_SCOPES,
  type Item,
  isParameterDisplayed,
  MANDATORY_INSTANCE_SCOPES,
  PROJECT_ROLE_SCOPES,
  personalOwnerScopes,
  type RedactionFloor,
  type RunData,
  resolveNodeParameters,
  type Scope,
  type StickyNote,
  splitTemplate,
  type TaskData,
  type TelemetryTag,
  type WorkflowNode,
  type WorkflowNodeGroup,
  type WorkflowSettings,
} from '@workflow/workflow';
import type { ApiRequest, ApiResponse } from '../api/client';
import type {
  AiBuilderFeature,
  ApiKey,
  AssistantFeature,
  CredentialSummary,
  ExecutionDetail,
  ExecutionSummary,
  ProjectIcon,
  ProjectRef,
  ProjectType,
  ProvisioningConfig,
  PushEvent,
  Role,
  SecurityPolicy,
  Settings,
  SsoOptions,
  Tag,
  Variable,
  VersionSummary,
  WorkflowDTO,
  WorkflowSummary,
} from '../api/types';
import { REDACTED } from '../api/types';
import { newId } from '../lib/ids';
import { getAncestors, getMainParents, listConnections } from '../lib/workflow-ops';
import {
  demoContacts,
  demoCredentialTypes,
  demoLoadOptions,
  demoNodeTypes,
  demoResourceMapping,
} from './fixtures';
import { registerAiRoutes } from './mock-ai';
import { filterExecutionList, registerAnnotationRoutes } from './mock-annotations';
import { registerApiKeyRoutes } from './mock-api-keys';
import { registerAssistantRoutes } from './mock-assistant';
import { registerAssistantConfirmRoutes } from './mock-assistant-confirm';
import { registerAssistantDraftRoutes } from './mock-assistant-drafts';
import { registerAssistantMcpRoutes } from './mock-assistant-mcp';
import { registerAssistantSettingsRoutes } from './mock-assistant-settings';
import { registerChatRoutes } from './mock-chat';
import { registerCollaborationRoutes } from './mock-collaboration';
import { registerDataTableRoutes, searchDataTables } from './mock-data-tables';
import { registerDependencyRoutes } from './mock-dependencies';
import { DEMO_EVALUATION_CONCURRENCY_LIMIT, registerEvaluationRoutes } from './mock-evaluations';
import { registerExecutionBulkRoutes } from './mock-execution-bulk';
import { filterWorkflowList, registerFolderRoutes } from './mock-folders';
import { registerFormAuthRoutes } from './mock-form-auth';
import { copy, HttpError, now, page } from './mock-http';
import { registerInsightsRoutes } from './mock-insights';
import { registerLdapRoutes } from './mock-ldap';
import { registerLogStreamingRoutes } from './mock-log-streaming';
import { registerMcpRoutes } from './mock-mcp';
import { registerMemberRoutes } from './mock-members';
import { registerMfaRoutes } from './mock-mfa';
import { registerOtelRoutes } from './mock-otel';
import { registerPasswordRoutes } from './mock-password';
import { registerPrivateCredentialRoutes } from './mock-private-credentials';
import { registerProjectRoutes, visibleProjects } from './mock-projects';
import { registerProvisioningRoutes, setDemoProvisioningConfig } from './mock-provisioning';
import { registerPublishRoutes } from './mock-publish';
import { registerRateLimitRoutes } from './mock-rate-limits';
import { redactDemoExecution, registerRedactionRoutes } from './mock-redaction';
import { registerReviewRoutes } from './mock-reviews';
import { findCustomRole, registerRoleRoutes } from './mock-roles';
import { registerScimRoutes } from './mock-scim';
import { registerSecretRoutes } from './mock-secrets';
import { demoShares, registerSharingRoutes } from './mock-sharing';
import { registerSourceControlRoutes } from './mock-source-control';
import { registerSsoRoutes, setDemoSsoOptions } from './mock-sso';
import {
  DEMO_MCP_TRIGGER_TYPE,
  demoHookFamily,
  demoHookMethod,
  demoHookUrl,
  registerTriggerListenRoutes,
} from './mock-triggers';
import { registerTypePolicyRoutes, restrictedDemoTypes } from './mock-type-policies';
import { type SimulationInput, type SimulationResult, simulateExecution } from './simulator';

/** body field `agentRequest` of POST /workflows/:id/run (P5-76 Test a tool) */
interface AgentRequest {
  query: DataObject;
  toolName: string;
}

/**
 * The webhook path of a trigger in the demo's URLs: a Webhook or Form Trigger's own path, else its
 * webhook id; a Chat Trigger's hook path is `chat` under it (`<webhookId or id>/chat`, as on the server).
 */
function hookPath(node: WorkflowNode): string {
  if (node.type === CHAT_TRIGGER_TYPE) return `${node.webhookId || node.id}/chat`;
  return String(node.parameters.path || node.webhookId || node.id);
}

/** The node a tool hangs under: non-main connections up to the first node without one. */
function toolRootName(connections: Connections, toolNode: string): string {
  const references = listConnections(connections);
  const seen = new Set([toolNode]);
  const parentOf = (name: string) =>
    references.find((c) => c.source === name && c.sourceType !== 'main' && !seen.has(c.target))?.target;
  let current = toolNode;
  let parent = parentOf(current);
  while (parent) {
    seen.add(parent);
    current = parent;
    parent = parentOf(current);
  }
  return current;
}

interface StoredUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

interface StoredTenant {
  id: string;
  name: string;
  slug: string;
}

export interface StoredWorkflow extends WorkflowDTO {
  tenantId: string;
}

export interface StoredVersion {
  versionId: string;
  workflowId: string;
  authorName: string;
  message: string | null;
  createdAt: string;
  /** P3-10 (absent = null) */
  versionName?: string | null;
  description?: string | null;
  /** P3-17 (absent = false) */
  autosaved?: boolean;
  snapshot: {
    name: string;
    nodes: WorkflowNode[];
    connections: Connections;
    settings: WorkflowSettings;
    nodeGroups?: WorkflowNodeGroup[];
  };
}

export interface StoredExecution extends ExecutionDetail {
  tenantId: string;
  cancel?: { canceled: boolean };
}

/** per-workspace settings PATCH /settings changes */
interface StoredTenantSettings {
  workflowReviews: { enabled: boolean };
  /** P6-33: the personal space policy (POST /settings/security), both on by default */
  securityPolicy: { personalSpacePublishing: boolean; personalSpaceSharing: boolean };
  /** P6-53 (C0): the workspace's redaction floor (POST /settings/security `redaction`), `off` by default */
  redaction: { floor: RedactionFloor };
}

/** P6-53: the floors POST /settings/security takes */
const REDACTION_FLOORS: readonly RedactionFloor[] = ['off', 'production', 'all'];

/** P6-03: a workspace membership of the demo; `role` is the workspace role (owner, admin, member or a custom global slug) */
export interface DemoMembership {
  tenantId: string;
  userId: string;
  role: Role;
  /** P6-20 (C0, optional; absent is today's answer): `active` when absent, `disabled` for a deactivated member */
  status?: 'active' | 'pending' | 'disabled';
  /** P6-20: the member's last request in this workspace (ISO time; absent or null: never) */
  lastActiveAt?: string | null;
  /** P6-02: the member came from a SCIM directory */
  managedByScim?: boolean;
  /** P6-13: the member may sign in with a password while SSO is on */
  allowSsoManualLogin?: boolean;
}

/** P6-03: a project of the demo (a workspace's team projects and each member's personal project) */
export interface StoredProject {
  id: string;
  tenantId: string;
  name: string;
  type: ProjectType;
  icon: ProjectIcon | null;
  description: string | null;
  /** the member a personal project belongs to (null for a team project) */
  ownerUserId: string | null;
  creatorId: string | null;
  /** P6-67: the project's custom telemetry tags (key and value pairs a span carries; [] when none) */
  customTelemetryTags: TelemetryTag[];
  createdAt: string;
  updatedAt: string;
}

/** P6-03: a member of a project with a project role slug (`project:admin`, ..., or a custom one) */
export interface StoredProjectRelation {
  tenantId: string;
  projectId: string;
  userId: string;
  role: string;
}

/** the 403 message of a missing scope, as the server's `requireScope` (n8n's) */
export const MISSING_SCOPE = 'User is missing a scope required to perform this action';

export type MockHandler = Handler;

/** a "Listen for test event" registration (POST /workflows/:id/listen-test-webhook), one per workflow */
export interface TestListen {
  nodeName: string;
  expiresAt: number;
  /** S3: the node a chat test run stops at (a step run downstream of a Chat Trigger) */
  destinationNode?: string;
  /** S3: a Chat Trigger's token, sent back by the chat panel in `x-chat-test-token` */
  chatTestToken?: string;
}

/**
 * S3 (P5-61): GET /executions `customDataKey` (the key, exact), `customDataValue` (a part of the value,
 * case-sensitive as SQL LIKE, or the whole value with `customDataExact=true`). No key: no filter.
 */
export function matchesCustomData(
  customData: Record<string, string> | null,
  query: Record<string, string>,
): boolean {
  const key = query.customDataKey;
  if (!key) return true;
  if (!customData || !Object.hasOwn(customData, key)) return false;
  const value = String(customData[key]);
  const wanted = query.customDataValue;
  if (wanted === undefined || wanted === '') return true;
  return query.customDataExact === 'true' ? value === wanted : value.includes(wanted);
}

interface StoredCredential extends CredentialSummary {
  tenantId: string;
  data: Record<string, unknown>;
}

/** P6-15: the server's texts for a private credential that is not allowed */
export const PRIVATE_TYPE_ERROR = 'Only OAuth1 and OAuth2 credentials can be private';
export const PRIVATE_PERSONAL_ERROR = "Private credentials can't be used in a personal project";
export const PRIVATE_MOVE_PERSONAL_ERROR = "A private credential can't be moved to a personal project";

export interface MockBackendOptions {
  stepDelayMs?: number;
  /** demo: simulate a call to the test URL this many ms after "Listen for test event" */
  autoWebhookMs?: number;
  brand?: Settings['brand'];
  signupEnabled?: boolean;
  /** P5-09: `features.aiBuilder` of GET /settings; on and set up when left out */
  aiBuilder?: AiBuilderFeature;
  /** P5-67: `features.assistant` of GET /settings; on and with a model when left out */
  assistant?: AssistantFeature;
  /** P6-84: `limits.activeWorkflows` of GET /settings (the plan's limit); null (no limit) when left out */
  activeWorkflowsLimit?: number | null;
}

type Handler = (ctx: {
  params: string[];
  query: Record<string, string>;
  body: Record<string, unknown>;
}) => unknown | Promise<unknown>;

export { HttpError };

/** P5-09: the demo builder is on and has a model (`features.aiBuilder`) */
const DEMO_AI_BUILDER: AiBuilderFeature = { enabled: true, setup: true };

/** P5-67: the demo Assistant is on and has a model (`features.assistant`) */
const DEMO_ASSISTANT: AssistantFeature = { enabled: true, modelSet: true };

/** P3-13: the n8n messages of GET /from-url */
const NOT_JSON = 'The URL does not point to valid JSON file!';
const NOT_WORKFLOW = 'The data in the file does not seem to be a workflow JSON file!';

export class MockBackend {
  users: StoredUser[] = [];
  tenants: StoredTenant[] = [];
  memberships: DemoMembership[] = [];
  invitations: Array<{ token: string; tenantId: string; email: string; role: Role }> = [];
  /** P6-03: team and personal projects (mock-projects serves them) and their members */
  projects: StoredProject[] = [];
  projectRelations: StoredProjectRelation[] = [];
  workflows: StoredWorkflow[] = [];
  versions: StoredVersion[] = [];
  executions: StoredExecution[] = [];
  credentials: StoredCredential[] = [];
  /** P6-15: the users who connected their own account, per private credential id (tests and demo seeds) */
  privateConnections = new Map<string, Set<string>>();
  tags: Array<Tag & { tenantId: string }> = [];
  variables: Array<Variable & { tenantId: string }> = [];
  apiKeys: Array<ApiKey & { tenantId: string }> = [];
  session: { userId: string; tenantId: string } | null = null;
  /** last request bodies, for assertions in tests */
  requests: ApiRequest[] = [];
  /** state of the Phase 3 route modules (mock-folders, mock-annotations, mock-publish, mock-reviews) */
  ext: Record<string, unknown> = {};
  /**
   * P6-18 (C0): the users with two-factor sign-in on (global, as the server's `user_mfa`). `/auth/me` answers
   * `mfaEnabled` from it and `/auth/login` asks for a code; mock-mfa.ts (L2) and `setDemoMfa` write it.
   */
  mfaEnabledUsers = new Set<string>();
  /** P6-18 (C0): the workspaces that enforce two-factor sign-in; GET /settings answers `mfa.enforced`, mock-mfa.ts (L2) writes it */
  mfaEnforcedTenants = new Set<string>();
  /**
   * P6-77 (C0): the protected workspaces (the server's `sourceControl.readOnly` tenant setting); GET /settings
   * answers `sourceControl.readOnly` from it; `setDemoProtected` writes it.
   */
  private protectedTenants = new Set<string>();
  /**
   * P6-18 (C0): whether a sign-in code or recovery code of `userId` is good. The C0 default takes any 6-digit code
   * or a non-empty recovery code; mock-mfa.ts (L2) replaces it with the demo's fixed secret.
   */
  mfaCheck: (userId: string, code: string | undefined, recoveryCode: string | undefined) => boolean = (
    _userId,
    code,
    recoveryCode,
  ) => (code !== undefined && /^\d{6}$/.test(code)) || (recoveryCode !== undefined && recoveryCode !== '');
  /** P3-13: what POST /workflows/from-url answers per URL (the demo never fetches) */
  private urlFixtures = new Map<string, unknown>();
  private tenantSettings = new Map<string, StoredTenantSettings>();
  /** the execution simulator; tests may spy on it (P3-06 runData / dirtyNodeNames reach it) */
  simulate: typeof simulateExecution = simulateExecution;
  private listeners = new Set<(event: PushEvent) => void>();
  private routes: Array<[string, RegExp, Handler]> = [];
  private listening = new Map<string, TestListen>();

  constructor(readonly options: MockBackendOptions = {}) {
    this.registerRoutes();
    registerFolderRoutes(this);
    registerAnnotationRoutes(this);
    registerPublishRoutes(this);
    registerReviewRoutes(this);
    registerDataTableRoutes(this);
    registerSecretRoutes(this);
    registerTriggerListenRoutes(this);
    registerFormAuthRoutes(this);
    registerChatRoutes(this);
    registerEvaluationRoutes(this);
    registerAiRoutes(this);
    registerMcpRoutes(this);
    registerAssistantRoutes(this);
    registerAssistantConfirmRoutes(this);
    registerAssistantDraftRoutes(this);
    registerAssistantSettingsRoutes(this);
    registerAssistantMcpRoutes(this);
    registerProjectRoutes(this);
    registerRoleRoutes(this);
    registerSharingRoutes(this);
    // Phase 6 S2 (C0): members and API keys moved out of `registerRoutes` (FULL), the rest per lane
    registerMemberRoutes(this);
    registerApiKeyRoutes(this);
    registerMfaRoutes(this);
    registerPasswordRoutes(this);
    registerSsoRoutes(this);
    registerProvisioningRoutes(this);
    registerLdapRoutes(this);
    registerScimRoutes(this);
    registerPrivateCredentialRoutes(this);
    // Phase 6 S3 (C0): one file per lane, each 501 until its lane fills it
    registerTypePolicyRoutes(this);
    registerRedactionRoutes(this);
    registerInsightsRoutes(this);
    registerCollaborationRoutes(this);
    registerRateLimitRoutes(this);
    registerExecutionBulkRoutes(this);
    registerDependencyRoutes(this);
    // Phase 6 S4 (C0): the Git environment routes, 501 until L6 fills them
    registerSourceControlRoutes(this);
    // Phase 6 S5 (C0): log streaming (L8) and OpenTelemetry (L12), 501 until each lane fills it
    registerLogStreamingRoutes(this);
    registerOtelRoutes(this);
  }

  // -------------------------------------------------------------------------------------------
  // push
  // -------------------------------------------------------------------------------------------

  subscribe(listener: (event: PushEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PushEvent): void {
    for (const listener of this.listeners) listener(copy(event));
  }

  // -------------------------------------------------------------------------------------------
  // seeding helpers (tests and demo)
  // -------------------------------------------------------------------------------------------

  createAccount(input: { email: string; password: string; name: string; workspaceName: string }) {
    const user: StoredUser = {
      id: newId(),
      email: input.email.toLowerCase(),
      name: input.name,
      password: input.password,
    };
    const tenant: StoredTenant = {
      id: newId(),
      name: input.workspaceName,
      slug: input.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    };
    this.users.push(user);
    this.tenants.push(tenant);
    this.memberships.push({ tenantId: tenant.id, userId: user.id, role: 'owner' });
    // P6-03: the workspace's team project and the owner's personal one (the demo keeps its team project; the
    // server's signup makes only the personal one since P6-39)
    this.createProject({ tenantId: tenant.id, name: tenant.name, type: 'team', creatorId: user.id });
    this.personalProject(tenant.id, user.id);
    return { user, tenant };
  }

  // -------------------------------------------------------------------------------------------
  // P6-03 projects (mock-projects serves the routes; L18 owns that file)
  // -------------------------------------------------------------------------------------------

  /** adds a project; a personal one also gets its owner's `project:personalOwner` relation */
  createProject(input: {
    tenantId: string;
    name: string;
    type: ProjectType;
    id?: string;
    icon?: ProjectIcon | null;
    description?: string | null;
    ownerUserId?: string | null;
    creatorId?: string | null;
  }): StoredProject {
    const project: StoredProject = {
      id: input.id ?? newId(),
      tenantId: input.tenantId,
      name: input.name.slice(0, 255),
      type: input.type,
      icon: input.icon ?? null,
      description: input.description ?? null,
      ownerUserId: input.type === 'personal' ? (input.ownerUserId ?? null) : null,
      creatorId: input.creatorId ?? input.ownerUserId ?? null,
      customTelemetryTags: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.projects.push(project);
    if (project.type === 'personal' && project.ownerUserId) {
      this.projectRelations.push({
        tenantId: project.tenantId,
        projectId: project.id,
        userId: project.ownerUserId,
        role: 'project:personalOwner',
      });
    }
    return project;
  }

  /** the member's personal project in the workspace, made on first use (named after the user) */
  personalProject(tenantId: string, userId: string): StoredProject {
    const found = this.projects.find(
      (p) => p.tenantId === tenantId && p.type === 'personal' && p.ownerUserId === userId,
    );
    if (found) return found;
    const user = this.users.find((u) => u.id === userId);
    return this.createProject({
      tenantId,
      name: user?.name || user?.email || 'Personal',
      type: 'personal',
      ownerUserId: userId,
    });
  }

  /**
   * The workspace's oldest team project (made, named after the workspace, when a test built none): where the
   * demo seeds and `seedWorkflow` put their rows, and where `setDemoRole` gives a project role.
   */
  oldestTeamProject(tenantId: string): StoredProject {
    const team = this.projects
      .filter((p) => p.tenantId === tenantId && p.type === 'team')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (team) return team;
    const tenant = this.tenants.find((t) => t.id === tenantId);
    return this.createProject({ tenantId, name: tenant?.name ?? 'Workspace', type: 'team' });
  }

  /**
   * `targetProject`: the named project of the signed-in workspace (404 otherwise), or the caller's personal
   * project (the server's rule since the cutover, P6-39)
   */
  targetProject(projectId?: unknown): StoredProject {
    const { tenant, user } = this.auth();
    if (projectId === undefined || projectId === null || projectId === '')
      return this.personalProject(tenant.id, user.id);
    const project = this.projects.find((p) => p.id === projectId && p.tenantId === tenant.id);
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    return project;
  }

  /** a project as rows name it (`homeProject`); null when unknown */
  projectRef(projectId: string | null | undefined): ProjectRef | null {
    const p = projectId ? this.projects.find((x) => x.id === projectId) : undefined;
    return p ? { id: p.id, name: p.name, type: p.type, icon: p.icon ? copy(p.icon) : null } : null;
  }

  /** `projectId` and `homeProject` of a project-owned row (nothing for a row a test built without one) */
  projectFields(row: { projectId?: string | null }): { projectId?: string; homeProject?: ProjectRef | null } {
    if (!row.projectId) return {};
    return { projectId: row.projectId, homeProject: this.projectRef(row.projectId) };
  }

  /**
   * The signed-in user's scopes in a project: the workspace role's, plus the project role's when the user is
   * a member of it (a personal project's owner through the workspace's personal space policy).
   */
  projectScopes(project: StoredProject): Scope[] {
    const auth = this.auth();
    return this.scopesOfUserIn(project, auth.user.id, auth.role);
  }

  /**
   * A user's scopes in a project (`role`: the user's workspace role, read from the membership when omitted): the
   * workspace role's, plus the project role's when the user is a member of it, as the server's `scopesFor`.
   */
  scopesOfUserIn(project: StoredProject, userId: string, role?: Role): Scope[] {
    const workspaceRole =
      role ?? this.memberships.find((m) => m.tenantId === project.tenantId && m.userId === userId)?.role;
    const scopes = new Set(
      workspaceRole === undefined ? [] : this.globalScopesOf(workspaceRole, project.tenantId),
    );
    const relation = this.projectRelations.find((r) => r.projectId === project.id && r.userId === userId);
    if (relation) {
      const slug = relation.role;
      const roleScopes =
        slug === 'project:personalOwner'
          ? personalOwnerScopes(this.settingsOf(project.tenantId).securityPolicy)
          : slug in PROJECT_ROLE_SCOPES
            ? PROJECT_ROLE_SCOPES[slug as keyof typeof PROJECT_ROLE_SCOPES]
            : (findCustomRole(this, project.tenantId, slug, 'project')?.scopes ?? []);
      for (const s of roleScopes) scopes.add(s);
    }
    return [...scopes];
  }

  /**
   * P6-43: the signed-in user's scopes on a row (`scopes` of the answers the lists and details send): the
   * workspace role's plus the role in the row's project. A row with no project holds the workspace role's only.
   */
  rowScopes(row: { projectId?: string | null }): Scope[] {
    const project = row.projectId ? this.projects.find((p) => p.id === row.projectId) : undefined;
    if (project) return this.projectScopes(project);
    const auth = this.auth();
    return this.globalScopesOf(auth.role, auth.tenant.id);
  }

  /** 403 unless the user holds `scope` globally or in at least one project of the workspace (a create with no target) */
  requireScopeAnywhere(scope: Scope) {
    const auth = this.auth();
    if (this.globalScopesOf(auth.role, auth.tenant.id).includes(scope)) return auth;
    const some = this.projects.some(
      (p) => p.tenantId === auth.tenant.id && this.projectScopes(p).includes(scope),
    );
    if (!some) throw new HttpError(403, 'forbidden', MISSING_SCOPE);
    return auth;
  }

  /** the projects a workflow or credential is shared with (L21 fills the share store) */
  sharedWith(resourceType: 'workflow' | 'credential', resourceId: string): ProjectRef[] {
    const { tenant } = this.auth();
    return demoShares(this)
      .filter(
        (s) => s.tenantId === tenant.id && s.resourceType === resourceType && s.resourceId === resourceId,
      )
      .map((s) => this.projectRef(s.projectId))
      .filter((p): p is ProjectRef => p !== null);
  }

  /**
   * Overview and Shared with you list the rows of the projects the caller can see, or shared into one. A
   * workspace role with `project:list` (owner, admin and the old words) sees every row, as before.
   */
  rowVisible(row: { projectId?: string | null }, sharedWith: ProjectRef[] = []): boolean {
    const auth = this.auth();
    if (this.globalScopesOf(auth.role, auth.tenant.id).includes('project:list')) return true;
    if (!row.projectId) return true;
    const visible = this.visibleProjectIds();
    return visible.has(row.projectId) || sharedWith.some((p) => visible.has(p.id));
  }

  /** the ids of the projects the signed-in user can see (Overview, Shared with you) */
  visibleProjectIds(): Set<string> {
    return new Set(visibleProjects(this).map((p) => p.id));
  }

  signIn(email: string) {
    const user = this.users.find((u) => u.email === email.toLowerCase());
    const membership = user && this.memberships.find((m) => m.userId === user.id);
    if (!user || !membership) throw new Error(`No account for ${email}`);
    this.session = { userId: user.id, tenantId: membership.tenantId };
  }

  seedWorkflow(input: Partial<WorkflowDTO> & { name: string }): WorkflowDTO {
    const tenantId = this.session?.tenantId ?? this.tenants[0]?.id ?? 'tenant';
    const wf: StoredWorkflow = {
      id: input.id ?? newId(),
      name: input.name,
      nodes: input.nodes ?? [],
      connections: input.connections ?? {},
      settings: input.settings ?? {},
      pinData: input.pinData ?? {},
      stickyNotes: input.stickyNotes ?? [],
      active: input.active ?? false,
      versionId: newId(),
      tags: input.tags ?? [],
      createdAt: input.createdAt ?? now(),
      updatedAt: input.updatedAt ?? now(),
      nodeGroups: input.nodeGroups ?? [],
      folderId: input.folderId ?? null,
      isArchived: input.isArchived ?? false,
      publishedVersionId: null,
      // a seeded row: the named project, else the workspace's oldest team project
      projectId: input.projectId ?? this.oldestTeamProject(tenantId).id,
      tenantId,
    };
    // a seeded active workflow is published at its version (as migration 0006 backfills)
    if (wf.active) wf.publishedVersionId = wf.versionId;
    this.workflows.push(wf);
    this.recordVersion(wf, 'Created');
    return this.toDto(wf);
  }

  /** P3-13: POST /workflows/from-url with this URL answers `json` (anything else: n8n's 400) */
  setUrlFixture(url: string, json: unknown): void {
    this.urlFixtures.set(url, copy(json));
  }

  // -------------------------------------------------------------------------------------------
  // request handling
  // -------------------------------------------------------------------------------------------

  async handle(request: ApiRequest): Promise<ApiResponse> {
    this.requests.push(copy({ ...request, signal: undefined }));
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.query ?? {}))
      if (v !== undefined && v !== null) query[k] = String(v);
    const path = request.path.split('?')[0];
    for (const [method, pattern, handler] of this.routes) {
      if (method !== request.method) continue;
      const match = pattern.exec(path);
      if (!match) continue;
      try {
        const data = await handler({
          params: match.slice(1).map(decodeURIComponent),
          query,
          body: (request.body ?? {}) as Record<string, unknown>,
        });
        if (data && typeof data === 'object' && '__list' in data) {
          const { __list, ...rest } = data as { __list: true };
          void __list;
          return { status: 200, body: rest };
        }
        return { status: 200, body: { data } };
      } catch (error) {
        if (error instanceof HttpError) {
          return {
            status: error.status,
            body: { error: { code: error.code, message: error.message, details: error.details } },
          };
        }
        return { status: 500, body: { error: { code: 'internal', message: (error as Error).message } } };
      }
    }
    return {
      status: 404,
      body: { error: { code: 'not_found', message: `No route for ${request.method} ${path}` } },
    };
  }

  /** register a route; `:name` segments become handler params (in order). First match wins. */
  on(method: string, path: string, handler: Handler) {
    const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    this.routes.push([method, pattern, handler]);
  }

  /** The signed-in user, workspace and workspace role (401 when signed out). */
  auth() {
    if (!this.session) throw new HttpError(401, 'unauthorized', 'Sign in to continue');
    const user = this.users.find((u) => u.id === this.session!.userId)!;
    const tenant = this.tenants.find((t) => t.id === this.session!.tenantId)!;
    const membership = this.memberships.find((m) => m.userId === user.id && m.tenantId === tenant.id);
    const role: Role = membership?.role ?? 'member';
    return { user, tenant, role };
  }

  /**
   * P6-03: the global scopes of a workspace role, as the server's `globalScopes`: owner, admin and member from
   * `GLOBAL_ROLE_SCOPES`, a custom global role's scopes plus n8n's baseline (`MANDATORY_INSTANCE_SCOPES`); an
   * unknown slug holds none.
   */
  globalScopesOf(role: Role, tenantId: string): Scope[] {
    if (Object.hasOwn(GLOBAL_ROLE_SCOPES, role))
      return [...GLOBAL_ROLE_SCOPES[role as keyof typeof GLOBAL_ROLE_SCOPES]];
    const custom = findCustomRole(this, tenantId, role, 'global');
    return custom ? [...new Set<Scope>([...custom.scopes, ...MANDATORY_INSTANCE_SCOPES])] : [];
  }

  private authResult() {
    const { user, tenant, role } = this.auth();
    return {
      user: { id: user.id, email: user.email, name: user.name },
      tenant: { ...tenant },
      role,
      globalScopes: this.globalScopesOf(role, tenant.id),
    };
  }

  /**
   * P6-03: 403 with n8n's message unless the signed-in user holds `scope` globally or on the row
   * (`resource.scopes`, e.g. `projectScopes(project)`), as the server's `requireScope`.
   */
  requireScope(scope: Scope, resource?: { scopes?: readonly Scope[] } | null) {
    const auth = this.auth();
    const global = this.globalScopesOf(auth.role, auth.tenant.id);
    if (!global.includes(scope) && !resource?.scopes?.includes(scope))
      throw new HttpError(403, 'forbidden', MISSING_SCOPE);
    return auth;
  }

  /**
   * Tests and demo: the signed-in user's workspace role (the first membership when signed out). A project role
   * name (`editor`, `viewer`: the old test names) makes the user a `member` holding `project:<name>` on the
   * workspace's oldest team project (in place of the one it held there), as the server's cutover (P6-39); any
   * other role is the workspace role and leaves the project relations as they are.
   */
  setDemoRole(role: Role): void {
    const membership = this.session
      ? this.memberships.find(
          (m) => m.userId === this.session!.userId && m.tenantId === this.session!.tenantId,
        )
      : this.memberships[0];
    if (!membership) throw new Error('No membership to set a role on');
    const projectRole = `project:${role}`;
    const asProjectRole = role !== 'admin' && Object.hasOwn(PROJECT_ROLE_SCOPES, projectRole);
    membership.role = asProjectRole ? 'member' : role;
    if (asProjectRole) {
      const team = this.oldestTeamProject(membership.tenantId);
      this.projectRelations = this.projectRelations.filter(
        (r) => !(r.projectId === team.id && r.userId === membership.userId),
      );
      this.projectRelations.push({
        tenantId: membership.tenantId,
        projectId: team.id,
        userId: membership.userId,
        role: projectRole,
      });
    }
  }

  /** the workspace the demo setters act on: the signed-in one, else the first membership's */
  private demoTenantId(): string {
    const tenantId = this.session?.tenantId ?? this.memberships[0]?.tenantId;
    if (!tenantId) throw new Error('No workspace to set the protected flag on');
    return tenantId;
  }

  /**
   * P6-77 (C0), tests and demo: makes the signed-in workspace (the first membership's when signed out, as
   * `setDemoRole`) protected (read only, as the server's `sourceControl.readOnly`) or writable again. GET
   * /settings answers it as `sourceControl.readOnly`; L6's PATCH `/source-control/preferences` calls it.
   */
  setDemoProtected(on: boolean): void {
    const tenantId = this.demoTenantId();
    if (on) this.protectedTenants.add(tenantId);
    else this.protectedTenants.delete(tenantId);
  }

  /** P6-77 (C0): whether the workspace `setDemoProtected` acts on is protected */
  isDemoProtected(): boolean {
    const tenantId = this.session?.tenantId ?? this.memberships[0]?.tenantId;
    return tenantId !== undefined && this.protectedTenants.has(tenantId);
  }

  /**
   * P6-18 (C0), tests and demo: turns two-factor sign-in on or off for the signed-in user (the first membership's
   * user when signed out, as `setDemoRole`), or for the user with `email`. On, `/auth/login` answers 401
   * `mfa_required` until the body carries `mfaCode` or `mfaRecoveryCode`.
   */
  setDemoMfa(enabled: boolean, email?: string): void {
    const userId =
      email !== undefined
        ? this.users.find((u) => u.email === email.toLowerCase())?.id
        : (this.session?.userId ?? this.memberships[0]?.userId);
    if (!userId) throw new Error('No user to set two-factor sign-in on');
    if (enabled) this.mfaEnabledUsers.add(userId);
    else this.mfaEnabledUsers.delete(userId);
  }

  /**
   * P6-01 (C0), tests and demo: what `GET /auth/sso-options` answers (state in mock-sso.ts, L11); null goes back
   * to email and password.
   */
  setDemoSso(options: SsoOptions | null): void {
    setDemoSsoOptions(this, options);
  }

  /**
   * P6-11 (C0), tests and demo: what `GET /sso/provisioning/config` answers (state in mock-provisioning.ts, L9);
   * null turns provisioning off.
   */
  setDemoProvisioning(config: ProvisioningConfig | null): void {
    setDemoProvisioningConfig(this, config);
  }

  /**
   * the workspace roles the member routes take: owner, admin, `member`, or a custom global role slug
   * (P6-20: public for mock-members.ts)
   */
  assignableRole(value: unknown, tenantId: string): Role {
    const role = typeof value === 'string' ? value : '';
    if (role === 'owner' || role === 'admin' || role === 'member') return role;
    if (role && findCustomRole(this, tenantId, role, 'global')) return role;
    throw new HttpError(400, 'invalid_role', 'Choose a valid role');
  }

  toDto(wf: StoredWorkflow): WorkflowDTO {
    const { tenantId, ...dto } = wf;
    void tenantId;
    return {
      ...copy(dto),
      ...this.projectFields(wf),
      scopes: this.rowScopes(wf),
      sharedWithProjects: this.sharedWith('workflow', wf.id),
    };
  }

  /** the workflow in the signed-in workspace (404 otherwise) */
  workflow(id: string): StoredWorkflow {
    const { tenant } = this.auth();
    const wf = this.workflows.find((w) => w.id === id && w.tenantId === tenant.id);
    if (!wf) throw new HttpError(404, 'not_found', 'Workflow not found');
    return wf;
  }

  recordVersion(wf: StoredWorkflow, message: string | null, options: { autosaved?: boolean } = {}) {
    const author = this.session ? this.users.find((u) => u.id === this.session!.userId)?.name : undefined;
    this.versions.unshift({
      versionId: wf.versionId,
      workflowId: wf.id,
      authorName: author ?? 'Demo user',
      message,
      createdAt: now(),
      versionName: null,
      description: null,
      autosaved: options.autosaved ?? false,
      snapshot: copy({
        name: wf.name,
        nodes: wf.nodes,
        connections: wf.connections,
        settings: wf.settings,
        nodeGroups: wf.nodeGroups ?? [],
      }),
    });
  }

  versionSummary(v: StoredVersion): VersionSummary {
    return {
      versionId: v.versionId,
      authorName: v.authorName,
      message: v.message,
      createdAt: v.createdAt,
      versionName: v.versionName ?? null,
      description: v.description ?? null,
      autosaved: v.autosaved ?? false,
    };
  }

  /** the execution in the signed-in workspace (404 otherwise) */
  execution(id: string): StoredExecution {
    const { tenant } = this.auth();
    const e = this.executions.find((x) => x.id === id && x.tenantId === tenant.id);
    if (!e) throw new HttpError(404, 'not_found', 'Execution not found');
    return e;
  }

  /**
   * P6-15: the private fields of a credential row, as the server: `isResolvable`, and for a private one the
   * caller's `connectedByMe` and the `connectedCount` of every user. A fixed row gets none (absent is false).
   */
  privateFields(c: { id: string; isResolvable?: boolean }): {
    isResolvable?: true;
    connectedByMe?: boolean;
    connectedCount?: number;
  } {
    if (!c.isResolvable) return {};
    const users = this.privateConnections.get(c.id) ?? new Set<string>();
    return { isResolvable: true, connectedByMe: users.has(this.auth().user.id), connectedCount: users.size };
  }

  /** P6-15: a private credential is an OAuth type in a team project (the route checks createEndUser) */
  assertCanBePrivate(type: string, project: StoredProject): void {
    const description = demoCredentialTypes.find((t) => t.name === type);
    if (!description?.isOAuth1 && !description?.isOAuth2)
      throw new HttpError(400, 'bad_request', PRIVATE_TYPE_ERROR);
    if (project.type === 'personal') throw new HttpError(400, 'bad_request', PRIVATE_PERSONAL_ERROR);
  }

  executionSummary(e: StoredExecution): ExecutionSummary {
    return {
      id: e.id,
      workflowId: e.workflowId,
      workflowName: e.workflowName,
      mode: e.mode,
      status: e.status,
      startedAt: e.startedAt,
      stoppedAt: e.stoppedAt,
      durationMs: e.durationMs,
      errorMessage: e.errorMessage,
      customData: e.customData,
      workflowVersionId: e.workflowVersionId ?? null,
      ...(e.usedPrivateCredentials ? { usedPrivateCredentials: true } : {}),
      annotation: e.annotation ? copy(e.annotation) : null,
    };
  }

  workflowSummary(w: StoredWorkflow): WorkflowSummary {
    return {
      id: w.id,
      name: w.name,
      active: w.active,
      tags: copy(w.tags),
      updatedAt: w.updatedAt,
      createdAt: w.createdAt,
      nodeTypes: w.nodes.map((n) => n.type),
      isArchived: w.isArchived,
      folderId: w.folderId,
      publishedVersionId: w.publishedVersionId,
      ...this.projectFields(w),
      scopes: this.rowScopes(w),
      sharedWithProjects: this.sharedWith('workflow', w.id),
      // P6-15: a node names a private credential (the card's icon)
      ...(w.nodes.some((n) =>
        Object.values(n.credentials ?? {}).some(
          (ref) => ref.id && this.credentials.some((c) => c.id === ref.id && c.isResolvable),
        ),
      )
        ? { usesPrivateCredentials: true }
        : {}),
    };
  }

  private settingsOf(tenantId: string): StoredTenantSettings {
    let settings = this.tenantSettings.get(tenantId);
    if (!settings) {
      settings = {
        workflowReviews: { enabled: false },
        securityPolicy: { personalSpacePublishing: true, personalSpaceSharing: true },
        redaction: { floor: 'off' },
      };
      this.tenantSettings.set(tenantId, settings);
    }
    return settings;
  }

  /** P6-33: GET /settings/security: the policy and what personal projects publish and share today */
  private securityPolicy(tenantId: string): SecurityPolicy {
    const personal = new Set(
      this.projects.filter((p) => p.tenantId === tenantId && p.type === 'personal').map((p) => p.id),
    );
    const inPersonal = (projectId: string | undefined) => projectId !== undefined && personal.has(projectId);
    const workflows = this.workflows.filter((w) => w.tenantId === tenantId && inPersonal(w.projectId));
    const credentials = this.credentials.filter((c) => c.tenantId === tenantId && inPersonal(c.projectId));
    const shares = demoShares(this).filter((s) => s.tenantId === tenantId);
    const sharedIds = (type: 'workflow' | 'credential') =>
      new Set(shares.filter((s) => s.resourceType === type).map((s) => s.resourceId));
    const sharedWorkflows = sharedIds('workflow');
    const sharedCredentials = sharedIds('credential');
    return {
      ...copy(this.settingsOf(tenantId).securityPolicy),
      publishedPersonalWorkflowsCount: workflows.filter((w) => w.publishedVersionId !== null).length,
      sharedPersonalWorkflowsCount: workflows.filter((w) => sharedWorkflows.has(w.id)).length,
      sharedPersonalCredentialsCount: credentials.filter((c) => sharedCredentials.has(c.id)).length,
      // P6-53 (C0): the workspace's redaction floor
      redaction: copy(this.settingsOf(tenantId).redaction),
    };
  }

  /** P6-53: the workspace's redaction floor (`/settings/security` `redaction.floor`; mock-redaction.ts reads it) */
  redactionFloorOf(tenantId: string): RedactionFloor {
    return this.settingsOf(tenantId).redaction.floor;
  }

  /**
   * P6-84: GET /settings `usage` of the signed-in workspace, as the server's: this month's executions and their
   * run time, and the published (active) workflows counted against `limits.activeWorkflows`.
   */
  private usageOf(tenantId: string): NonNullable<Settings['usage']> {
    const period = new Date().toISOString().slice(0, 7);
    const runs = this.executions.filter((e) => e.tenantId === tenantId && e.startedAt.startsWith(period));
    const executionMs = runs.reduce(
      (sum, e) => sum + (e.stoppedAt ? Math.max(0, Date.parse(e.stoppedAt) - Date.parse(e.startedAt)) : 0),
      0,
    );
    const activeWorkflows = this.workflows.filter((w) => w.tenantId === tenantId && w.active).length;
    return { period, executions: runs.length, executionMs, activeWorkflows };
  }

  validateForActivation(wf: StoredWorkflow) {
    const details: Array<{ node: string; message: string }> = [];
    const byName = new Map(demoNodeTypes.map((d) => [d.name, d]));
    const triggers = wf.nodes.filter(
      (n) => !n.disabled && byName.get(n.type)?.group.includes('trigger') && n.type !== 'core.manualTrigger',
    );
    if (!triggers.length)
      details.push({
        node: '',
        message: 'Add a trigger other than the manual trigger, so the workflow can start on its own.',
      });
    for (const node of wf.nodes) {
      const description = byName.get(node.type);
      if (!description) {
        details.push({ node: node.name, message: `Unknown node type "${node.type}"` });
        continue;
      }
      const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
        nodeVersion: node.typeVersion,
      });
      for (const cred of description.credentials ?? []) {
        if (
          cred.required &&
          isParameterDisplayed(cred.displayOptions, params) &&
          !node.credentials?.[cred.name]?.id
        ) {
          details.push({ node: node.name, message: `Select a credential for "${cred.name}"` });
        }
      }
    }
    if (details.length) throw new HttpError(400, 'validation_failed', 'The workflow has problems', details);
  }

  /** start a simulated run; route modules use it (S3: mock-evaluations runs a case with mode `evaluation`) */
  startExecution(
    wf: StoredWorkflow,
    data: {
      nodes: WorkflowNode[];
      connections: Connections;
      name: string;
      settings?: WorkflowSettings;
      pinData?: Record<string, Item[]>;
    },
    options: {
      mode: 'manual' | 'webhook' | 'retry' | 'evaluation';
      destinationNode?: string;
      startNode?: string;
      triggerItems?: Item[];
      retryOf?: string;
      /** P3-06 partial run */
      runData?: RunData;
      dirtyNodeNames?: string[];
      /** P3-10: the saved version the run used (null for unsaved editor data) */
      workflowVersionId?: string | null;
      /** P5-76: test the tool `destinationNode` names */
      agentRequest?: AgentRequest;
    },
  ): string {
    const executionId = newId();
    const cancel = { canceled: false };
    const execution: StoredExecution = {
      id: executionId,
      tenantId: wf.tenantId,
      workflowId: wf.id,
      workflowName: data.name,
      mode: options.mode,
      status: 'running',
      startedAt: now(),
      stoppedAt: null,
      durationMs: null,
      errorMessage: null,
      customData: null,
      workflowVersionId: options.workflowVersionId ?? null,
      annotation: null,
      workflowData: copy({ id: wf.id, ...data }),
      state: {
        // a tool test runs up to the tool's root, as on the engine
        startData: {
          destinationNode:
            options.agentRequest && data.nodes.some((n) => n.name === options.destinationNode)
              ? toolRootName(data.connections, options.destinationNode as string)
              : options.destinationNode,
        },
        resultData: { runData: {} },
        executionData: {
          nodeExecutionStack: [],
          waitingExecution: {},
          waitingExecutionSource: {},
          contextData: {},
        },
      },
      cancel,
    };
    this.executions.unshift(execution);
    const variables = Object.fromEntries(
      this.variables.filter((v) => v.tenantId === wf.tenantId).map((v) => [v.key, v.value]),
    );
    // start asynchronously so the HTTP response (with the id) can win or lose the race, like on a real server
    setTimeout(() => {
      const input: SimulationInput = {
        executionId,
        workflow: {
          id: wf.id,
          name: data.name,
          active: wf.active,
          nodes: data.nodes,
          connections: data.connections,
          pinData: options.mode === 'manual' || options.mode === 'evaluation' ? data.pinData : undefined,
        },
        mode: options.mode,
        destinationNode: options.destinationNode,
        startNode: options.startNode,
        triggerItems: options.triggerItems,
        runData: options.runData,
        dirtyNodeNames: options.dirtyNodeNames,
        variables,
        emit: (event) => {
          if (event.type === 'nodeExecuteAfter') {
            const runs = (execution.state.resultData.runData[event.data.nodeName] ??= []);
            runs[event.data.runIndex] = event.data.taskData;
          }
          this.emit(event);
        },
        stepDelayMs: this.options.stepDelayMs ?? 0,
        signal: cancel,
      };
      void (
        options.agentRequest ? this.simulateToolTest(input, options.agentRequest) : this.simulate(input)
      ).then((result: SimulationResult) => this.finishExecution(execution, result));
    }, 0);
    return executionId;
  }

  /**
   * P5-76 Test a tool, as the engine runs it: the root's parents run as usual, the root only hands
   * their items on and leaves no run, and the tool node gets the one run. The query is data: it goes
   * into the run as it came and is never evaluated.
   */
  private async simulateToolTest(input: SimulationInput, request: AgentRequest): Promise<SimulationResult> {
    const { workflow, executionId, emit } = input;
    const workflowId = workflow.id ?? '';
    const refuse = (message: string): SimulationResult => {
      const error = { name: 'WorkflowOperationError', message };
      emit({ type: 'executionStarted', data: { executionId, workflowId, mode: input.mode } });
      emit({ type: 'executionFinished', data: { executionId, workflowId, status: 'error', error } });
      return { status: 'error', runData: {}, error };
    };
    const toolName = input.destinationNode;
    if (!toolName) return refuse('A tool test needs a destination node');
    if (!workflow.nodes.some((n) => n.name === toolName))
      return refuse(`Destination node "${toolName}" does not exist`);

    const root = toolRootName(workflow.connections, toolName);
    const ancestors = getAncestors(workflow.connections, root);
    const heads = workflow.nodes.filter(
      (n) => ancestors.includes(n.name) && getMainParents(workflow.connections, n.name).length === 0,
    );
    const held: PushEvent[] = [];
    const upstream = await this.simulate({
      ...input,
      workflow: {
        ...workflow,
        // a pass-through in the root's place: no parameter of it is evaluated, no sub-node logs a run
        nodes: workflow.nodes.map((n) =>
          n.name === root ? { ...n, type: 'core.noOp', parameters: {}, disabled: false } : n,
        ),
      },
      destinationNode: root,
      startNode:
        input.startNode ?? (heads.find((n) => /trigger|webhook/i.test(n.type)) ?? heads[0])?.name ?? root,
      emit: (event) => {
        if (event.type === 'executionFinished') held.push(event);
        else if (
          (event.type !== 'nodeExecuteBefore' && event.type !== 'nodeExecuteAfter') ||
          event.data.nodeName !== root
        )
          emit(event);
      },
    });
    const runData: RunData = Object.fromEntries(
      Object.entries(upstream.runData).filter(([name]) => name !== root),
    );
    if (upstream.status !== 'success') {
      for (const event of held) emit(event);
      return { ...upstream, runData };
    }

    emit({ type: 'nodeExecuteBefore', data: { executionId, nodeName: toolName } });
    const delayMs = input.stepDelayMs;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const task: TaskData = {
      startTime: Date.now(),
      executionTime: delayMs ? 120 : 0,
      executionStatus: 'success',
      inputOverride: { ai_tool: [[{ json: copy(request.query ?? {}) }]] },
      data: { ai_tool: [[{ json: { response: 'demo response', toolName: request.toolName } }]] },
      source: root === toolName ? [] : [{ previousNode: root }],
    };
    const runs = (runData[toolName] ??= []);
    runs.push(task);
    emit({
      type: 'nodeExecuteAfter',
      data: { executionId, nodeName: toolName, runIndex: runs.length - 1, taskData: task },
    });
    for (const event of held) emit(event);
    return { status: 'success', runData, lastNodeExecuted: toolName };
  }

  private finishExecution(execution: StoredExecution, result: SimulationResult) {
    execution.status = result.status;
    execution.stoppedAt = now();
    execution.durationMs = new Date(execution.stoppedAt).getTime() - new Date(execution.startedAt).getTime();
    execution.errorMessage = result.error?.message ?? null;
    const state: ExecutionState = execution.state;
    state.resultData = {
      runData: result.runData,
      lastNodeExecuted: result.lastNodeExecuted,
      error: result.error,
    };
    if (result.error?.node) {
      state.executionData.failedExecuteData = { node: result.error.node, data: { main: [[]] }, source: null };
    }
  }

  /**
   * Simulate the call to a test URL that "Listen for test event" registered. S3: `triggerItems` is what the
   * request brought (the chat item of a Chat Trigger); the run stops at the listen's `destinationNode`.
   */
  receiveTestWebhook(workflowId: string, triggerItems?: Item[]): string | null {
    const listen = this.listening.get(workflowId);
    if (!listen || listen.expiresAt < Date.now()) return null;
    this.listening.delete(workflowId);
    const wf = this.workflows.find((w) => w.id === workflowId);
    if (!wf) return null;
    const executionId = this.startExecution(wf, wf, {
      mode: 'webhook',
      startNode: listen.nodeName,
      destinationNode: listen.destinationNode,
      triggerItems,
      workflowVersionId: wf.versionId,
    });
    this.emit({ type: 'testWebhookReceived', data: { workflowId, executionId } });
    return executionId;
  }

  /** S3: the live chat test listen that issued `token` (null when unknown or expired) */
  testListenByChatToken(token: string): { workflowId: string; listen: TestListen } | null {
    if (!token) return null;
    for (const [workflowId, listen] of this.listening) {
      if (listen.chatTestToken === token && listen.expiresAt >= Date.now()) return { workflowId, listen };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // routes
  // -------------------------------------------------------------------------------------------

  private registerRoutes() {
    // --- auth -----------------------------------------------------------------------------------
    this.on('POST', '/auth/signup', ({ body }) => {
      if (this.options.signupEnabled === false)
        throw new HttpError(403, 'signup_disabled', 'Sign-up is disabled on this server');
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      const password = String(body.password ?? '');
      if (!/^\S+@\S+\.\S+$/.test(email))
        throw new HttpError(400, 'invalid_email', 'Enter a valid email address');
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw new HttpError(400, 'weak_password', 'Use at least 8 characters with a letter and a digit');
      }
      if (this.users.some((u) => u.email === email))
        throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      const { user, tenant } = this.createAccount({
        email,
        password,
        name: String(body.name ?? ''),
        workspaceName: String(body.workspaceName ?? 'My workspace'),
      });
      this.session = { userId: user.id, tenantId: tenant.id };
      return this.authResult();
    });
    this.on('POST', '/auth/login', ({ body }) => {
      const user = this.users.find((u) => u.email === String(body.email ?? '').toLowerCase());
      if (!user || user.password !== body.password)
        throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');
      // P6-18 (C0, FULL): with two-factor sign-in on, the password alone answers 401 `mfa_required` and a bad
      // code n8n's text; no session either way
      if (this.mfaEnabledUsers.has(user.id)) {
        const code = typeof body.mfaCode === 'string' && body.mfaCode !== '' ? body.mfaCode : undefined;
        const recoveryCode =
          typeof body.mfaRecoveryCode === 'string' && body.mfaRecoveryCode !== ''
            ? body.mfaRecoveryCode
            : undefined;
        if (code === undefined && recoveryCode === undefined)
          throw new HttpError(401, 'mfa_required', 'Enter the code from your authenticator app');
        if (!this.mfaCheck(user.id, code, recoveryCode))
          throw new HttpError(401, 'invalid_mfa', 'Invalid mfa token or recovery code');
      }
      // P6-01 (C0): `workspace` (a workspace slug) picks that membership; unknown or absent, the first
      const workspace = typeof body.workspace === 'string' ? body.workspace : undefined;
      const chosen = workspace
        ? this.memberships.find(
            (m) => m.userId === user.id && this.tenants.find((t) => t.id === m.tenantId)?.slug === workspace,
          )
        : undefined;
      const membership = chosen ?? this.memberships.find((m) => m.userId === user.id)!;
      this.session = { userId: user.id, tenantId: membership.tenantId };
      return this.authResult();
    });
    this.on('POST', '/auth/logout', () => {
      this.session = null;
      return { ok: true };
    });
    this.on('GET', '/auth/me', () => {
      const result = this.authResult();
      return {
        ...result,
        // P6-01, P6-18 (C0): the demo signs in by password only; `mfaEnabled` from `mfaEnabledUsers` (mock-mfa.ts)
        authMethod: 'password',
        mfaEnabled: this.mfaEnabledUsers.has(result.user.id),
        ssoFenced: false,
        tenants: this.memberships
          .filter((m) => m.userId === result.user.id)
          .map((m) => ({ ...this.tenants.find((t) => t.id === m.tenantId)!, role: m.role })),
      };
    });
    this.on('POST', '/auth/switch-tenant', ({ body }) => {
      const { user } = this.auth();
      const membership = this.memberships.find((m) => m.userId === user.id && m.tenantId === body.tenantId);
      if (!membership) throw new HttpError(403, 'forbidden', 'You are not a member of that workspace');
      this.session = { userId: user.id, tenantId: membership.tenantId };
      return this.authResult();
    });
    this.on('POST', '/invitations/:token/accept', ({ params, body }) => {
      const invitation = this.invitations.find((i) => i.token === params[0]);
      if (!invitation) throw new HttpError(404, 'not_found', 'Invitation not found or expired');
      let user = this.users.find((u) => u.email === invitation.email);
      if (!user) {
        user = {
          id: newId(),
          email: invitation.email,
          name: String(body.name ?? ''),
          password: String(body.password ?? ''),
        };
        this.users.push(user);
      }
      this.memberships.push({
        tenantId: invitation.tenantId,
        userId: user.id,
        role: invitation.role,
      });
      // P6-03: every member has a personal project
      this.personalProject(invitation.tenantId, user.id);
      this.invitations = this.invitations.filter((i) => i !== invitation);
      this.session = { userId: user.id, tenantId: invitation.tenantId };
      return this.authResult();
    });

    // --- settings & types -------------------------------------------------------------------------
    this.on(
      'GET',
      '/settings',
      (): Settings => ({
        brand: this.options.brand ?? { name: 'Workflow', logoUrl: null, primaryColor: '#3346d3' },
        baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
        webhookBaseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
        timezone: 'Europe/Berlin',
        // P6-84: the plan's active workflow limit (null: no limit), as the server's `limits`
        limits: { executionTimeoutMax: 3600, activeWorkflows: this.options.activeWorkflowsLimit ?? null },
        features: {
          demo: true,
          aiBuilder: copy(this.options.aiBuilder ?? DEMO_AI_BUILDER),
          assistant: copy(this.options.assistant ?? DEMO_ASSISTANT),
          // P6-17, P6-18, P6-21 (C0): the demo sends no mail, offers two-factor sign-in and the public API
          mail: false,
          mfa: true,
          publicApi: true,
        },
        autosaveEnabled: true,
        evaluationConcurrencyLimit: DEMO_EVALUATION_CONCURRENCY_LIMIT,
        workflowReviews: copy(
          this.session ? this.settingsOf(this.session.tenantId).workflowReviews : { enabled: false },
        ),
        // P6-33: the personal space policy (absent when signed out)
        ...(this.session
          ? { securityPolicy: copy(this.settingsOf(this.session.tenantId).securityPolicy) }
          : {}),
        // P6-18 (C0): whether the workspace enforces two-factor sign-in
        mfa: { enforced: this.session ? this.mfaEnforcedTenants.has(this.session.tenantId) : false },
        // P6-77 (C0): whether the workspace is protected (read only); false when signed out, as the server
        sourceControl: { readOnly: this.session ? this.protectedTenants.has(this.session.tenantId) : false },
        // P6-84 (usage, sent only when signed in, as the server) and P6-53 (the redaction floor)
        ...(this.session
          ? {
              usage: this.usageOf(this.session.tenantId),
              redactionFloor: this.redactionFloorOf(this.session.tenantId),
            }
          : {}),
      }),
    );
    // P6-33 (L12 owns the server route; FULL in the demo): the personal space policy and its counts
    this.on('GET', '/settings/security', () => {
      const { tenant } = this.requireScope('securitySettings:manage');
      return this.securityPolicy(tenant.id);
    });
    this.on('POST', '/settings/security', ({ body }) => {
      const { tenant } = this.requireScope('securitySettings:manage');
      const policy = this.settingsOf(tenant.id).securityPolicy;
      // P6-53 (C0): `redaction: { floor }`, checked before anything is kept
      const floor =
        body.redaction === undefined ? undefined : (body.redaction as { floor?: unknown } | null)?.floor;
      if (body.redaction !== undefined && !REDACTION_FLOORS.includes(floor as RedactionFloor))
        throw new HttpError(400, 'invalid_body', 'redaction.floor must be off, production or all');
      for (const key of ['personalSpacePublishing', 'personalSpaceSharing'] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'boolean')
          throw new HttpError(400, 'invalid_body', `${key} must be true or false`);
        // turning a flag off does not undo what is published or shared already (P6-33)
        policy[key] = body[key];
      }
      if (floor !== undefined) this.settingsOf(tenant.id).redaction = { floor: floor as RedactionFloor };
      return this.securityPolicy(tenant.id);
    });
    this.on('PATCH', '/settings', ({ body }) => {
      const { tenant } = this.requireScope('securitySettings:manage');
      const settings = this.settingsOf(tenant.id);
      const reviews = body.workflowReviews as { enabled?: unknown } | undefined;
      if (reviews && typeof reviews.enabled === 'boolean')
        settings.workflowReviews = { enabled: reviews.enabled };
      // the server's PATCH answer: brand, timezone and the two P3 fields
      return {
        brand: this.options.brand ?? { name: 'Workflow', logoUrl: null, primaryColor: '#3346d3' },
        timezone: 'Europe/Berlin',
        autosaveEnabled: true,
        workflowReviews: copy(settings.workflowReviews),
      };
    });
    this.on('GET', '/node-types', () => {
      this.auth();
      return copy(demoNodeTypes);
    });
    this.on('GET', '/credential-types', () => {
      this.auth();
      return copy(demoCredentialTypes);
    });
    this.on('POST', '/node-types/options', ({ body }) => {
      this.auth();
      // P6-27: a call names the saved workflow or the project whose credentials it may use
      const named = (value: unknown) => typeof value === 'string' && value !== '';
      if (!named(body.workflowId) && !named(body.projectId))
        throw new HttpError(400, 'bad_request', 'workflowId or projectId is required');
      if (named(body.projectId)) this.targetProject(body.projectId);
      const node = body.node as WorkflowNode;
      if (body.kind === 'loadOptions') {
        const fn = demoLoadOptions[String(body.method)];
        if (!fn) throw new HttpError(400, 'unknown_method', `Unknown method ${String(body.method)}`);
        return fn(node?.parameters ?? {});
      }
      if (body.kind === 'resourceMapping') {
        // P5-80, the role of the server's route
        this.requireScopeAnywhere('workflow:update');
        const fn = demoResourceMapping[String(body.method)];
        if (!fn) throw new HttpError(400, 'unknown_method', `Unknown method ${String(body.method)}`);
        return fn(node?.parameters ?? {});
      }
      // P4-05: the Data Table node's locator lists the demo's tables
      if (body.method === 'tableSearch') return searchDataTables(String(body.filter ?? ''));
      const filter = String(body.filter ?? '').toLowerCase();
      const matches = demoContacts.filter((c) => !filter || c.name.toLowerCase().includes(filter));
      const offset = Number(body.paginationToken ?? 0) || 0;
      const results = matches.slice(offset, offset + 10);
      return { results, paginationToken: offset + 10 < matches.length ? String(offset + 10) : undefined };
    });

    // --- workflows ------------------------------------------------------------------------------
    this.on('GET', '/workflows', ({ query }) => {
      const { tenant } = this.auth();
      const search = (query.search ?? '').toLowerCase();
      // P3-01 command bar search: name, or a node of one of `nodeTypes`, or (matchTags) a tag named like it
      const nodeTypes = new Set((query.nodeTypes ?? '').split(',').filter(Boolean).slice(0, 20));
      const matchTags = query.matchTags === 'true';
      const matches = (w: StoredWorkflow) =>
        w.name.toLowerCase().includes(search) ||
        w.nodes.some((n) => nodeTypes.has(n.type)) ||
        (matchTags && w.tags.some((t) => t.name.toLowerCase().includes(search)));
      const scoped = filterWorkflowList(
        this,
        this.workflows.filter((w) => w.tenantId === tenant.id),
        query,
      );
      // P6-50 (C0): `executionBlockedBy=restrictedNode` keeps the workflows holding a node type the policy of the
      // workspace or of the workflow's project blocks (mock-type-policies.ts; none until L5)
      const blocked = (w: StoredWorkflow) => {
        const restricted = new Set(restrictedDemoTypes(this, tenant.id, w.projectId, 'node'));
        return w.nodes.some((n) => restricted.has(n.type));
      };
      const list = scoped
        .filter((w) => !search || matches(w))
        .filter((w) => !query.tagId || w.tags.some((t) => t.id === query.tagId))
        .filter((w) => query.active === undefined || String(w.active) === query.active)
        .filter((w) => query.executionBlockedBy !== 'restrictedNode' || blocked(w))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((w) => this.workflowSummary(w));
      return { __list: true, ...page(list, query) };
    });
    // P3-13: the server fetches the URL; the demo answers fixtures set with setUrlFixture
    this.on('POST', '/workflows/from-url', ({ body }) => {
      // `workflow:create` in the body's project, else the caller's personal project (as the server's createTarget)
      this.requireScope('workflow:create', {
        scopes: this.projectScopes(this.targetProject(body.projectId)),
      });
      const url = typeof body.url === 'string' ? body.url : '';
      if (!/^https?:\/\/.+/i.test(url) || url.length > 2048)
        throw new HttpError(400, 'invalid_url', 'Enter a URL that starts with http:// or https://');
      if (!this.urlFixtures.has(url)) throw new HttpError(400, 'invalid_json', NOT_JSON);
      const data = this.urlFixtures.get(url) as { nodes?: unknown; connections?: unknown } | null;
      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray(data.nodes) ||
        !data.connections ||
        typeof data.connections !== 'object'
      ) {
        throw new HttpError(400, 'invalid_workflow', NOT_WORKFLOW);
      }
      return copy(data);
    });
    this.on('POST', '/workflows', ({ body }) => {
      // P6-39: `workflow:create` in the body's project, else the caller's personal project (as the server)
      const project = this.targetProject(body.projectId);
      const { tenant } = this.requireScope('workflow:create', { scopes: this.projectScopes(project) });
      const tagIds = (body.tagIds as string[] | undefined) ?? [];
      const wf: StoredWorkflow = {
        id: newId(),
        tenantId: tenant.id,
        name: String(body.name ?? 'My workflow'),
        nodes: (body.nodes as WorkflowNode[]) ?? [],
        connections: (body.connections as Connections) ?? {},
        settings: (body.settings as WorkflowSettings) ?? {},
        pinData: (body.pinData as Record<string, Item[]>) ?? {},
        stickyNotes: (body.stickyNotes as StickyNote[]) ?? [],
        active: false,
        versionId: newId(),
        tags: this.tags.filter((t) => tagIds.includes(t.id)).map(({ id, name }) => ({ id, name })),
        createdAt: now(),
        updatedAt: now(),
        nodeGroups: (body.nodeGroups as WorkflowNodeGroup[]) ?? [],
        folderId: typeof body.folderId === 'string' ? body.folderId : null,
        isArchived: false,
        publishedVersionId: null,
        projectId: project.id,
      };
      this.workflows.push(wf);
      this.recordVersion(wf, null);
      return this.toDto(wf);
    });
    this.on('GET', '/workflows/:id', ({ params }) => this.toDto(this.workflow(params[0])));
    this.on('PATCH', '/workflows/:id', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      if (body.versionId !== wf.versionId)
        throw new HttpError(409, 'version_conflict', 'The workflow was changed by someone else');
      for (const key of [
        'name',
        'nodes',
        'connections',
        'settings',
        'pinData',
        'stickyNotes',
        'nodeGroups',
      ] as const) {
        if (body[key] !== undefined) (wf as unknown as Record<string, unknown>)[key] = copy(body[key]);
      }
      const tagIds =
        (body.tagIds as string[] | undefined) ?? (body.tags as Tag[] | undefined)?.map((t) => t.id);
      if (tagIds)
        wf.tags = this.tags.filter((t) => tagIds.includes(t.id)).map(({ id, name }) => ({ id, name }));
      wf.versionId = newId();
      wf.updatedAt = now();
      this.recordVersion(wf, null, { autosaved: body.autosaved === true });
      return this.toDto(wf);
    });
    this.on('DELETE', '/workflows/:id', ({ params }) => {
      const wf = this.workflow(params[0]);
      this.workflows = this.workflows.filter((w) => w !== wf);
      return { ok: true };
    });
    // POST /workflows/:id/activate and /deactivate: mock-publish.ts
    this.on('POST', '/workflows/:id/run', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      const data = (body.workflowData as typeof wf | undefined) ?? wf;
      const executionId = this.startExecution(
        wf,
        {
          name: data.name ?? wf.name,
          nodes: data.nodes ?? wf.nodes,
          connections: data.connections ?? wf.connections,
          settings: data.settings ?? wf.settings,
          pinData: (body.pinData as Record<string, Item[]>) ?? data.pinData ?? wf.pinData,
        },
        {
          mode: 'manual',
          destinationNode: body.destinationNode as string | undefined,
          startNode: body.startNode as string | undefined,
          triggerItems: body.triggerItems as Item[] | undefined,
          runData: body.runData as RunData | undefined,
          dirtyNodeNames: body.dirtyNodeNames as string[] | undefined,
          workflowVersionId: body.workflowData ? null : wf.versionId,
          agentRequest: body.agentRequest as AgentRequest | undefined,
        },
      );
      return { executionId };
    });
    this.on('DELETE', '/workflows/:id/listen-test-webhook', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      if (this.listening.get(wf.id)?.nodeName === String(body.nodeName ?? '')) this.listening.delete(wf.id);
      return { ok: true };
    });
    this.on('POST', '/workflows/:id/listen-test-webhook', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      const nodeName = String(body.nodeName ?? '');
      const node = wf.nodes.find((n) => n.name === nodeName);
      if (!node) throw new HttpError(400, 'unknown_node', `Node "${nodeName}" is not in the saved workflow`);
      const expiresAt = Date.now() + 120_000;
      const isChat = node.type === CHAT_TRIGGER_TYPE;
      // S3: a chat test run gets a token per registration (the server signs one, kind chat-test, 120 s)
      const chatTestToken = isChat ? `demo-chat-test-${newId()}` : undefined;
      const destinationNode = typeof body.destinationNode === 'string' ? body.destinationNode : undefined;
      this.listening.set(wf.id, { nodeName, expiresAt, destinationNode, chatTestToken });
      // a chat message comes from the chat panel, never from the demo timer
      if (this.options.autoWebhookMs && !isChat)
        setTimeout(() => this.receiveTestWebhook(wf.id), this.options.autoWebhookMs);
      const { tenant } = this.auth();
      const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      const family = demoHookFamily(node.type);
      const isForm = family === 'form';
      const testUrl = demoHookUrl(origin, family, true, tenant.slug, hookPath(node));
      return {
        testUrl,
        expiresAt: new Date(expiresAt).toISOString(),
        formTestUrls: isForm ? [testUrl] : [],
        ...(chatTestToken ? { chatTestToken } : {}),
      };
    });
    this.on('GET', '/workflows/:id/webhook-urls', ({ params }) => {
      const wf = this.workflow(params[0]);
      const { tenant } = this.auth();
      const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      return wf.nodes
        .filter(
          (n) =>
            n.type === 'core.webhook' ||
            n.type === 'core.formTrigger' ||
            n.type === CHAT_TRIGGER_TYPE ||
            n.type === DEMO_MCP_TRIGGER_TYPE,
        )
        .map((n) => {
          const path = hookPath(n);
          const family = demoHookFamily(n.type);
          return {
            nodeName: n.name,
            method: demoHookMethod(family, n.parameters.httpMethod),
            testUrl: demoHookUrl(origin, family, true, tenant.slug, path),
            productionUrl: demoHookUrl(origin, family, false, tenant.slug, path),
          };
        });
    });
    this.on('GET', '/workflows/:id/versions', ({ params, query }) => {
      const wf = this.workflow(params[0]);
      const list: VersionSummary[] = this.versions
        .filter((v) => v.workflowId === wf.id)
        .map((v) => this.versionSummary(v));
      return { __list: true, ...page(list, query) };
    });
    this.on('GET', '/workflows/:id/versions/:versionId', ({ params }) => {
      const wf = this.workflow(params[0]);
      const version = this.versions.find((v) => v.workflowId === wf.id && v.versionId === params[1]);
      if (!version) throw new HttpError(404, 'not_found', 'Version not found');
      return {
        versionId: version.versionId,
        createdAt: version.createdAt,
        versionName: version.versionName ?? null,
        description: version.description ?? null,
        autosaved: version.autosaved ?? false,
        ...copy(version.snapshot),
      };
    });
    // structural diff: `against` = a version id, 'current' (the saved workflow) or 'published'
    this.on('GET', '/workflows/:id/versions/:versionId/diff', ({ params, query }) => {
      const wf = this.workflow(params[0]);
      const find = (id: string | null) => {
        const v = id ? this.versions.find((x) => x.workflowId === wf.id && x.versionId === id) : undefined;
        if (!v) throw new HttpError(404, 'not_found', 'Version not found');
        return v.snapshot;
      };
      const against = query.against || 'current';
      const from = find(params[1]);
      const to = against === 'current' ? wf : find(against === 'published' ? wf.publishedVersionId : against);
      return {
        from: params[1],
        to: against,
        ...diffWorkflows(
          { name: from.name, nodes: from.nodes, connections: from.connections, settings: from.settings },
          { name: to.name, nodes: to.nodes, connections: to.connections, settings: to.settings ?? {} },
        ),
      };
    });
    this.on('POST', '/workflows/:id/versions/:versionId/restore', ({ params }) => {
      const wf = this.workflow(params[0]);
      const version = this.versions.find((v) => v.workflowId === wf.id && v.versionId === params[1]);
      if (!version) throw new HttpError(404, 'not_found', 'Version not found');
      Object.assign(wf, copy(version.snapshot));
      wf.versionId = newId();
      wf.updatedAt = now();
      this.recordVersion(wf, 'Restored an earlier version');
      return this.toDto(wf);
    });

    // --- executions -----------------------------------------------------------------------------
    const summary = (e: StoredExecution) => this.executionSummary(e);
    const execution = (id: string) => this.execution(id);
    this.on('GET', '/executions', ({ query }) => {
      const { tenant } = this.auth();
      const list = filterExecutionList(
        this,
        this.executions.filter((e) => e.tenantId === tenant.id),
        query,
      )
        .filter((e) => !query.workflowId || e.workflowId === query.workflowId)
        .filter(
          (e) =>
            !query.projectId ||
            this.workflows.find((w) => w.id === e.workflowId)?.projectId === query.projectId,
        )
        .filter((e) => !query.status || e.status === query.status)
        .filter((e) => !query.workflowVersionId || e.workflowVersionId === query.workflowVersionId)
        .filter((e) => matchesCustomData(e.customData, query))
        .map(summary);
      return { __list: true, ...page(list, query) };
    });
    this.on('GET', '/executions/:id', ({ params, query }) => {
      const e = execution(params[0]);
      // the caller's scopes come from the execution's workflow (its project)
      const scopes = this.rowScopes(this.workflows.find((w) => w.id === e.workflowId) ?? {});
      // P6-53 (C0): redacted for the caller by mock-redaction.ts (a pass-through until L8)
      return redactDemoExecution(
        { ...summary(e), workflowData: copy(e.workflowData), state: copy(e.state), scopes },
        query,
        this,
      );
    });
    this.on('POST', '/executions/:id/retry', ({ params, body }) => {
      const e = execution(params[0]);
      if (!['error', 'crashed', 'canceled'].includes(e.status)) {
        throw new HttpError(409, 'conflict', 'Only failed or stopped executions can be retried');
      }
      const wf = this.workflow(e.workflowId);
      const data = body.useCurrentWorkflow ? wf : { ...wf, ...e.workflowData, name: e.workflowData.name };
      return {
        executionId: this.startExecution(wf, data, {
          mode: 'retry',
          retryOf: e.id,
          workflowVersionId: body.useCurrentWorkflow ? wf.versionId : e.workflowVersionId,
        }),
      };
    });
    this.on('POST', '/executions/:id/stop', ({ params }) => {
      const e = execution(params[0]);
      if (e.cancel) e.cancel.canceled = true;
      if (e.status === 'running' || e.status === 'waiting') e.status = 'canceled';
      return { status: e.status };
    });
    this.on('DELETE', '/executions/:id', ({ params }) => {
      const e = execution(params[0]);
      this.executions = this.executions.filter((x) => x !== e);
      return { ok: true };
    });

    // --- credentials ------------------------------------------------------------------------------
    const credential = (id: string) => {
      const { tenant } = this.auth();
      const c = this.credentials.find((x) => x.id === id && x.tenantId === tenant.id);
      // `credential:read` on the credential's project (old viewers hold none), as the server's gate
      if (!c) {
        this.requireScope('credential:read');
        throw new HttpError(404, 'not_found', 'Credential not found');
      }
      this.requireScope('credential:read', { scopes: this.rowScopes(c) });
      return c;
    };
    const secretKeys = (type: string) =>
      new Set(
        demoCredentialTypes
          .find((t) => t.name === type)
          ?.properties.filter((p) => p.typeOptions?.password)
          .map((p) => p.name) ?? [],
      );
    this.on('GET', '/credentials', ({ query }) => {
      const { tenant } = this.auth();
      const visible = this.visibleProjectIds();
      const sharedTo = (credentialId: string) =>
        demoShares(this).filter(
          (s) => s.tenantId === tenant.id && s.resourceType === 'credential' && s.resourceId === credentialId,
        );
      return (
        this.credentials
          .filter((c) => c.tenantId === tenant.id && (!query.type || c.type === query.type))
          .filter((c) => this.rowVisible(c, this.sharedWith('credential', c.id)))
          // a project's pickers: its own credentials, those shared to it, and the global ones
          .filter(
            (c) =>
              !query.projectId ||
              c.projectId === query.projectId ||
              c.isGlobal === true ||
              sharedTo(c.id).some((s) => s.projectId === query.projectId),
          )
          // Shared with you: shared to a project of the caller, owned by none of them
          .filter(
            (c) =>
              query.onlySharedWithMe !== 'true' ||
              (!visible.has(c.projectId ?? '') && sharedTo(c.id).some((s) => visible.has(s.projectId))),
          )
          .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            ...this.projectFields(c),
            ...(c.isGlobal ? { isGlobal: true } : {}),
            ...this.privateFields(c),
            scopes: this.rowScopes(c),
            sharedWithProjects: this.sharedWith('credential', c.id),
          }))
      );
    });
    this.on('POST', '/credentials', ({ body }) => {
      // P6-39: `credential:create` in the body's project, else the caller's personal project (as the server)
      const project = this.targetProject(body.projectId);
      const { tenant } = this.requireScope('credential:create', { scopes: this.projectScopes(project) });
      // P6-15: a private credential needs `credential:createEndUser` there, an OAuth type and a team project
      if (body.isResolvable === true) {
        this.requireScope('credential:createEndUser', { scopes: this.projectScopes(project) });
        this.assertCanBePrivate(String(body.type ?? ''), project);
      }
      const c: StoredCredential = {
        id: newId(),
        tenantId: tenant.id,
        name: String(body.name ?? 'Credential'),
        type: String(body.type ?? ''),
        data: copy((body.data as Record<string, unknown>) ?? {}),
        createdAt: now(),
        updatedAt: now(),
        projectId: project.id,
        isGlobal: false,
        ...(body.isResolvable === true ? { isResolvable: true } : {}),
      };
      this.credentials.push(c);
      return { id: c.id, name: c.name, type: c.type };
    });
    this.on('GET', '/credentials/:id', ({ params }) => {
      const c = credential(params[0]);
      const secrets = secretKeys(c.type);
      // as the server: a saved expression stays visible, it is a reference and not the secret
      const isExpression = (v: unknown) =>
        typeof v === 'string' &&
        v.startsWith('=') &&
        splitTemplate(v.slice(1)).some((segment) => segment.type === 'code');
      const data = Object.fromEntries(
        Object.entries(c.data).map(([k, v]) => [k, secrets.has(k) && v && !isExpression(v) ? REDACTED : v]),
      );
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        data,
        ...this.projectFields(c),
        ...(c.isGlobal ? { isGlobal: true } : {}),
        ...this.privateFields(c),
        scopes: this.rowScopes(c),
        sharedWithProjects: this.sharedWith('credential', c.id),
      };
    });
    this.on('PATCH', '/credentials/:id', ({ params, body }) => {
      const c = credential(params[0]);
      // P6-24 (FULL in the demo): usable by every member, read only; needs `credential:shareGlobally`
      if (body.isGlobal !== undefined) {
        if (typeof body.isGlobal !== 'boolean')
          throw new HttpError(400, 'invalid_body', 'isGlobal must be true or false');
        this.requireScope('credential:shareGlobally');
        c.isGlobal = body.isGlobal;
      }
      // P6-15: the switch between fixed and private needs `credential:createEndUser` on the credential
      const wasPrivate = c.isResolvable === true;
      if (typeof body.isResolvable === 'boolean' && body.isResolvable !== wasPrivate) {
        this.requireScope('credential:createEndUser', { scopes: this.rowScopes(c) });
        if (body.isResolvable) {
          const project = this.projects.find((p) => p.id === c.projectId);
          if (project) this.assertCanBePrivate(c.type, project);
          c.isResolvable = true;
        } else {
          delete c.isResolvable;
        }
      }
      if (typeof body.name === 'string') c.name = body.name;
      let sharedChanged = false;
      if (body.data && typeof body.data === 'object') {
        const next = copy(body.data as Record<string, unknown>);
        for (const [k, v] of Object.entries(next)) if (v === REDACTED) next[k] = c.data[k];
        const keys = new Set([...Object.keys(next), ...Object.keys(c.data)]);
        sharedChanged = [...keys].some((k) => JSON.stringify(next[k]) !== JSON.stringify(c.data[k]));
        c.data = next;
      }
      // as the server: back to fixed, or a changed shared field, removes every user's connection
      if (wasPrivate && (!c.isResolvable || sharedChanged)) this.privateConnections.delete(c.id);
      c.updatedAt = now();
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        ...this.privateFields(c),
        scopes: this.rowScopes(c),
      };
    });
    this.on('DELETE', '/credentials/:id', ({ params }) => {
      const c = credential(params[0]);
      // P6-15: deleting a private credential also needs `credential:createEndUser`
      if (c.isResolvable) this.requireScope('credential:createEndUser', { scopes: this.rowScopes(c) });
      this.credentials = this.credentials.filter((x) => x !== c);
      this.privateConnections.delete(c.id);
      return { ok: true };
    });
    this.on('POST', '/credentials/test', ({ body }) => {
      this.auth();
      const data = (body.data as Record<string, unknown>) ?? {};
      const filled = Object.values(data).some((v) => v !== '' && v !== undefined && v !== null);
      return filled
        ? { status: 'OK', message: 'Connection works' }
        : { status: 'Error', message: 'Fill in the fields first' };
    });
    this.on('GET', '/oauth2/authorize', () => {
      throw new HttpError(
        400,
        'not_available',
        'OAuth2 sign-in needs a running server; it is not available in this demo.',
      );
    });
    this.on('GET', '/oauth1/authorize', () => {
      throw new HttpError(
        400,
        'not_available',
        'OAuth1 sign-in needs a running server; it is not available in this demo.',
      );
    });

    // --- tags, variables -----------------------------------------------------------------------------
    this.on('GET', '/tags', () => {
      const { tenant } = this.auth();
      return this.tags.filter((t) => t.tenantId === tenant.id).map(({ id, name }) => ({ id, name }));
    });
    // P6-39: tag scopes as the server's (every member writes tags, only owner and admin delete one)
    this.on('POST', '/tags', ({ body }) => {
      const { tenant } = this.requireScope('tag:create');
      const name = String(body.name ?? '').trim();
      if (this.tags.some((t) => t.tenantId === tenant.id && t.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, 'tag_exists', 'A tag with this name exists');
      }
      const tag = { id: newId(), name, tenantId: tenant.id };
      this.tags.push(tag);
      return { id: tag.id, name: tag.name };
    });
    this.on('PATCH', '/tags/:id', ({ params, body }) => {
      const { tenant } = this.requireScope('tag:update');
      const tag = this.tags.find((t) => t.id === params[0] && t.tenantId === tenant.id);
      if (!tag) throw new HttpError(404, 'not_found', 'Tag not found');
      tag.name = String(body.name ?? tag.name);
      return { id: tag.id, name: tag.name };
    });
    this.on('DELETE', '/tags/:id', ({ params }) => {
      const { tenant } = this.requireScope('tag:delete');
      if (!this.tags.some((t) => t.id === params[0] && t.tenantId === tenant.id))
        throw new HttpError(404, 'not_found', 'Tag not found');
      this.tags = this.tags.filter((t) => t.id !== params[0]);
      return { ok: true };
    });
    // P6-31 (FULL in the demo, L22 does not own this file): a variable with `projectId` is a project variable
    // (`projectVariable:*` on that project), one without a global one (`variable:*`, owner and admin today)
    const variableOut = (v: Variable) =>
      v.projectId
        ? { id: v.id, key: v.key, value: v.value, projectId: v.projectId }
        : { id: v.id, key: v.key, value: v.value };
    const variableInTenant = (id: string) => {
      const { tenant } = this.auth();
      const v = this.variables.find((x) => x.id === id && x.tenantId === tenant.id);
      if (!v) throw new HttpError(404, 'not_found', 'Variable not found');
      return v;
    };
    const requireVariableScope = (
      action: 'create' | 'update' | 'delete',
      projectId: string | null | undefined,
    ) => {
      if (!projectId) return this.requireScope(`variable:${action}`);
      const project = this.targetProject(projectId);
      return this.requireScope(`projectVariable:${action}`, { scopes: this.projectScopes(project) });
    };
    this.on('GET', '/variables', ({ query }) => {
      const { tenant } = this.auth();
      if (query.projectId) this.targetProject(query.projectId);
      return this.variables
        .filter((v) => v.tenantId === tenant.id)
        .filter((v) => !query.projectId || v.projectId === query.projectId)
        .map(variableOut);
    });
    this.on('POST', '/variables', ({ body }) => {
      const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
      const { tenant } = requireVariableScope('create', projectId);
      const v = {
        id: newId(),
        key: String(body.key ?? ''),
        value: String(body.value ?? ''),
        projectId,
        tenantId: tenant.id,
      };
      this.variables.push(v);
      return variableOut(v);
    });
    this.on('PATCH', '/variables/:id', ({ params, body }) => {
      const v = variableInTenant(params[0]);
      requireVariableScope('update', v.projectId);
      v.key = String(body.key ?? v.key);
      v.value = String(body.value ?? v.value);
      return variableOut(v);
    });
    this.on('DELETE', '/variables/:id', ({ params }) => {
      const v = variableInTenant(params[0]);
      requireVariableScope('delete', v.projectId);
      this.variables = this.variables.filter((x) => x !== v);
      return { ok: true };
    });
  }
}
