/**
 * DTOs of the REST contract (docs/ARCHITECTURE.md section 14). Field names here must match the
 * contract exactly; the server is built against the same document.
 */
import type {
  AssistantArtifact,
  AssistantConfirmation,
  AssistantDraftDTO,
  AssistantMcpAuthentication,
  AssistantMcpTransport,
  AssistantPermissionMode,
  AssistantPermissions,
  AssistantThreadDTO,
  BuilderMessage,
  Connections,
  CredentialTypeDescription,
  DataObject,
  DataTableColumnInput,
  DataTableDryRunOption,
  ExecutionErrorShape,
  ExecutionMode,
  ExecutionState,
  ExecutionStatus,
  Item,
  NodeProperty,
  NodeTypeDescription,
  RunData,
  Scope,
  StickyNote,
  TaskData,
  TestRunStatus,
  DataTableInfo as WorkflowDataTableInfo,
  WorkflowDiff,
  WorkflowNode,
  WorkflowNodeGroup,
  WorkflowSettings,
} from '@workflow/workflow';

export type { Scope };

/** P6-39: the old words, mapped by the server's legacy role map until L24 removes them */
export type LegacyRole = 'editor' | 'viewer';
/** P6-03: the system workspace roles */
export type SystemRole = 'owner' | 'admin' | 'member';
/** a workspace role: a system role, an old word, or a custom global role slug (as the server's db/role-types.ts) */
export type Role = SystemRole | LegacyRole | (string & {});

/** the roles the member pages offer today; L24 changes the list */
export const ROLES: Role[] = ['owner', 'admin', 'editor', 'viewer'];

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
}

export interface AuthResult {
  user: User;
  tenant: Tenant;
  role: Role;
  /** P6-03: the workspace role's scopes (`/auth/switch-tenant` answers them too) */
  globalScopes?: Scope[];
}

export interface TenantMembership extends Tenant {
  role: Role;
}

export interface Me extends AuthResult {
  tenants: TenantMembership[];
  /** P6-03: the scopes of the workspace role; `can()` (lib/permissions.ts) reads them */
  globalScopes: Scope[];
}

export interface Brand {
  name: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
}

export interface Settings {
  brand: Brand;
  baseUrl: string;
  webhookBaseUrl: string;
  timezone: string;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
  /** false when the server sets WORKFLOWS_AUTOSAVE_DISABLED (P3-17) */
  autosaveEnabled: boolean;
  /** tenant setting, off by default; admins change it in Settings > Security (P3-19) */
  workflowReviews: { enabled: boolean };
  /** read only (P5-11): how many evaluation cases run at once at most; the server caps a run to it */
  evaluationConcurrencyLimit?: number;
  /** P5-09: the AI builder's model; admins only (the credential id never reaches a lower role) */
  ai?: TenantAiSettings;
  /** P6-33: the personal space policy (absent flags are on) */
  securityPolicy?: { personalSpacePublishing?: boolean; personalSpaceSharing?: boolean };
}

/** body of PATCH /settings (admin) */
export interface SettingsPatchBody {
  brand?: Partial<Brand>;
  timezone?: string;
  workflowReviews?: { enabled: boolean };
  /** P5-09: the credential must be this workspace's, the node type a chat model node; null removes the setup */
  ai?: TenantAiSettings | null;
}

export interface Tag {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------------------------
// Projects, roles, sharing and moving (Phase 6 S1: P6-03, P6-29, P6-30, P6-32, P6-33)
// ---------------------------------------------------------------------------------------------

export type ProjectType = 'personal' | 'team';

/** n8n's project icon: an emoji or a named icon */
export interface ProjectIcon {
  type: 'emoji' | 'icon';
  value: string;
  color?: string;
}

/** a project as rows name it (`homeProject`, `sharedWithProjects`, pickers) */
export interface ProjectRef {
  id: string;
  name: string;
  type: ProjectType;
  icon: ProjectIcon | null;
}

/** a row of GET /projects, /projects/my-projects; `role` and `scopes` are the caller's in it */
export interface Project extends ProjectRef {
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /** the caller's project role slug (system or custom); absent when the caller reaches it through a global role */
  role?: string;
  scopes?: Scope[];
}

/** a member of a project (GET /projects/:id `relations`) */
export interface ProjectRelation {
  id: string;
  email: string;
  name: string;
  /** a project role slug: `project:admin`, `project:editor`, `project:viewer`, `project:personalOwner` or a custom one */
  role: string;
}

/** a user who reaches a team project through a global role (owner, admin); never part of `relations` */
export interface ProjectImplicitMember {
  id: string;
  email: string;
  name: string;
  globalRole: { slug: string; displayName: string };
}

/** GET /projects/:id, /projects/personal */
export interface ProjectDetail extends Project {
  relations: ProjectRelation[];
  implicitMembers: ProjectImplicitMember[];
  /** what the caller may do in this project */
  scopes: Scope[];
  customTelemetryTags?: Array<{ key: string; value: string }>;
  creatorId?: string | null;
}

/** GET /projects with `take` or `skip` */
export interface ProjectPage {
  count: number;
  data: Project[];
}

/** GET /projects/count */
export type ProjectCount = Record<ProjectType, number>;

/** GET /projects query: no `take` and no `skip` answers a bare array */
export interface ProjectListQuery {
  take?: number;
  skip?: number;
  search?: string;
  type?: ProjectType;
}

/** POST /projects */
export interface ProjectCreateBody {
  name: string;
  icon?: ProjectIcon;
}

/** PATCH /projects/:id */
export interface ProjectPatchBody {
  name?: string;
  icon?: ProjectIcon;
  description?: string;
  customTelemetryTags?: Array<{ key: string; value: string }>;
}

/** one member in POST /projects/:id/users */
export interface ProjectRelationInput {
  userId: string;
  role: string;
}

/** POST /projects/:id/users: 201 with `conflicts` when some were already members, 409 when none was added */
export interface ProjectAddUsersResult {
  conflicts?: Array<{ userId: string; currentRole: string; requestedRole: string }>;
}

export type RoleType = 'global' | 'project' | 'workflow' | 'credential' | 'secretsProviderConnection';

/** a role of GET /roles: a system role (in code) or a custom one (`roles` table) */
export interface CustomRole {
  slug: string;
  displayName: string;
  description: string | null;
  systemRole: boolean;
  roleType: RoleType;
  scopes: Scope[];
  usedByUsers?: number;
  usedByProjects?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** GET /roles: every role by type, as n8n's `AllRolesMap` */
export interface RolesMap {
  global: CustomRole[];
  project: CustomRole[];
  workflow: CustomRole[];
  credential: CustomRole[];
  secretsProviderConnection: CustomRole[];
}

/** POST /roles */
export interface RoleCreateBody {
  /** 2 to 100 characters */
  displayName: string;
  /** at most 500 characters */
  description?: string;
  roleType: 'project' | 'global';
  scopes: Scope[];
}

/** PATCH /roles/:slug */
export interface RolePatchBody {
  displayName?: string;
  description?: string;
  scopes?: Scope[];
}

/** a project that uses a project role (GET /roles/:slug/assignments) */
export interface RoleAssignment {
  projectId: string;
  projectName: string;
  projectIcon: ProjectIcon | null;
  memberCount: number;
  lastAssigned: string | null;
}

export interface RoleAssignmentsPage {
  projects: RoleAssignment[];
  totalProjects: number;
}

/** GET /roles/:slug/members, /roles/:slug/assignments/:projectId/members */
export interface RoleMember {
  userId: string;
  name: string;
  email: string;
  role: string;
}

export interface RoleMembersPage {
  members: RoleMember[];
  total?: number;
}

/** what the access fields of a project-owned row carry (lists with `includeScopes`, GET one) */
export interface ProjectOwnedFields {
  projectId?: string;
  homeProject?: ProjectRef | null;
  sharedWithProjects?: ProjectRef[];
  /** the caller's scopes on this row */
  scopes?: Scope[];
}

/** the project filter of the list calls */
export interface ProjectListFilter {
  projectId?: string;
  /** only rows shared with the caller's projects (the Shared page) */
  onlySharedWithMe?: boolean;
  /** each row carries the caller's `scopes` */
  includeScopes?: boolean;
}

/** one reason a move leaves something restricted (n8n's PolicyViolation; open strings) */
export interface PolicyViolation {
  kind: string;
  checkId: string;
  message: string;
  subject?: string;
  subjectType?: string;
  scope?: string;
  matchedRuleId?: string;
  projectId?: string;
  optInAvailable?: boolean;
}

/** GET /{workflows,credentials,folders}/:id/transfer-preview?destinationProjectId= (advisory) */
export interface TransferPreview {
  /** types the destination project does not allow */
  restricted: PolicyViolation[];
  /** a policy check failed, so the lists can be incomplete */
  checkFailed: boolean;
  /** workflow: why the move would unpublish it (empty when it would not) */
  unpublishReasons?: PolicyViolation[];
  /** folder: published workflows in the tree the move would unpublish */
  workflowsToUnpublish?: Array<{ id: string; name: string }>;
}

/** PUT /workflows/:id/transfer */
export interface WorkflowTransferBody {
  destinationProjectId: string;
  /** credential ids the move shares into the destination */
  shareCredentials?: string[];
  destinationParentFolderId?: string;
}

/** PUT /credentials/:id/transfer */
export interface CredentialTransferBody {
  destinationProjectId: string;
}

/** PUT /folders/:id/transfer (the whole tree) */
export interface FolderTransferBody {
  destinationProjectId: string;
  destinationParentFolderId?: string;
  shareCredentials?: string[];
}

/** GET /settings/security (`securitySettings:manage`): the personal space policy with its existing counts */
export interface SecurityPolicy {
  personalSpacePublishing: boolean;
  personalSpaceSharing: boolean;
  publishedPersonalWorkflowsCount: number;
  sharedPersonalWorkflowsCount: number;
  sharedPersonalCredentialsCount: number;
}

/** POST /settings/security */
export interface SecurityPolicyPatch {
  personalSpacePublishing?: boolean;
  personalSpaceSharing?: boolean;
}

/** DELETE /members/:userId (P6-31): the removed member's personal work moves to a project or is deleted */
export type MemberRemovalChoice = { transferToProjectId: string } | { deleteData: true };

export interface WorkflowSummary extends ProjectOwnedFields {
  id: string;
  name: string;
  active: boolean;
  tags: Tag[];
  updatedAt: string;
  createdAt: string;
  nodeTypes: string[];
  isArchived: boolean;
  folderId: string | null;
  publishedVersionId: string | null;
}

export interface WorkflowDTO extends ProjectOwnedFields {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings: WorkflowSettings;
  pinData: Record<string, Item[]>;
  stickyNotes: StickyNote[];
  active: boolean;
  versionId: string;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
  /** canvas groups (P3-04) */
  nodeGroups: WorkflowNodeGroup[];
  /** P3-07: null = the root folder */
  folderId: string | null;
  isArchived: boolean;
  /** P3-10: the published version (null = not published); active = publishedVersionId !== null */
  publishedVersionId: string | null;
  /** set when a save or restore of an active workflow failed to re-register it and the server deactivated it */
  activationError?: { message: string; details?: ActivationErrorDetail[] };
}

export interface WorkflowCreateBody {
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  pinData?: Record<string, Item[]>;
  stickyNotes?: StickyNote[];
  tagIds?: string[];
  nodeGroups?: WorkflowNodeGroup[];
  /** P3-07: create inside this folder (null or omitted = root) */
  folderId?: string | null;
  /** P6-22: the project the workflow goes to (omitted = the server's default project) */
  projectId?: string;
}

export type WorkflowPatchBody = Partial<
  Omit<
    WorkflowDTO,
    | 'id'
    | 'createdAt'
    | 'updatedAt'
    | 'folderId'
    | 'isArchived'
    | 'publishedVersionId'
    | keyof ProjectOwnedFields
  >
> & {
  versionId: string;
  tagIds?: string[];
  /** P3-17: the version this save creates is an autosave */
  autosaved?: boolean;
};

/** workflow JSON fetched by POST /workflows/from-url (P3-13): a nodes array and a connections object */
export interface WorkflowImportData {
  name?: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  pinData?: Record<string, Item[]>;
  stickyNotes?: StickyNote[];
  nodeGroups?: WorkflowNodeGroup[];
  [key: string]: unknown;
}

/** body of POST /workflows/:id/activate (P3-10 publish); empty = publish the current version */
export interface PublishBody {
  versionId?: string;
  /** 1..128 */
  versionName?: string;
  /** at most 2000 */
  description?: string;
}

/** body of PATCH /workflows/:id/versions/:versionId (at least one field) */
export interface VersionPatchBody {
  versionName?: string | null;
  description?: string | null;
}

/** GET /workflows/:id/versions/:versionId/diff (`against`: a version id, 'current' or 'published') */
export type VersionDiff = WorkflowDiff & { from: string; to: string };

/** body of POST /workflows/move */
export interface MoveWorkflowsBody {
  /** at most 100 */
  workflowIds: string[];
  folderId: string | null;
}

/** body of POST /workflows/:id/run */
export interface RunWorkflowBody {
  workflowData?: WorkflowCreateBody & { id?: string };
  startNode?: string;
  destinationNode?: string;
  pinData?: Record<string, Item[]>;
  triggerItems?: Item[];
  /** partial run: the last run data of this workflow */
  runData?: RunData;
  /** P3-06: nodes changed since the run data was produced (max 2000 names) */
  dirtyNodeNames?: string[];
  /** P5-76 test a tool: `destinationNode` is the tool node, `query` its arguments, `toolName` its name for the model */
  agentRequest?: { query: DataObject; toolName: string };
}

export interface ActivationErrorDetail {
  node: string;
  message: string;
}

export interface WebhookUrlInfo {
  nodeName: string;
  method: string;
  testUrl: string;
  productionUrl: string;
}

export interface VersionSummary {
  versionId: string;
  authorName: string;
  message: string | null;
  createdAt: string;
  /** P3-10 named versions (null = unnamed) */
  versionName: string | null;
  description: string | null;
  /** P3-17: made by an autosave */
  autosaved: boolean;
}

export interface VersionSnapshot {
  versionId?: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  stickyNotes?: StickyNote[];
  nodeGroups?: WorkflowNodeGroup[];
  versionName?: string | null;
  description?: string | null;
  autosaved?: boolean;
  createdAt?: string;
}

/** one publish-timeline row (P3-16), newest first */
export interface PublishTimelineEntry {
  id: string;
  event: 'activated' | 'deactivated';
  /** null when the version was pruned (the row shows "Published a version") */
  versionId: string | null;
  versionName: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// Folders and favorites (P3-07)
// ---------------------------------------------------------------------------------------------

export interface Folder extends ProjectOwnedFields {
  id: string;
  name: string;
  /** null = top level */
  parentFolderId: string | null;
  /** folder tags (n8n has them in the API only) */
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface FolderPathItem {
  id: string;
  name: string;
}

export interface FolderDetail extends Folder {
  /** ancestors from the top level down to this folder (breadcrumb) */
  path: FolderPathItem[];
  /** recursive; archived workflows are not counted */
  workflowCount: number;
  /** recursive */
  subFolderCount: number;
}

export interface FolderListQuery extends ProjectListFilter {
  /** a folder id, or 'root' for the top level; omitted = every folder */
  parentFolderId?: string;
  search?: string;
  /** tag names; a folder must have all of them */
  tags?: string[];
  limit?: number;
  cursor?: string;
}

export interface FolderCreateBody {
  name: string;
  parentFolderId?: string | null;
  /** P6-26: the project the folder goes to (omitted = the server's default project) */
  projectId?: string;
}

export interface FolderUpdateBody {
  name?: string;
  parentFolderId?: string | null;
  /** replaces the folder's tags (workspace tags only) */
  tagIds?: string[];
}

/** P6-41: `project` (the server's `user_favorites.resource_type` gains it in 0022) */
export type FavoriteResourceType = 'workflow' | 'folder' | 'dataTable' | 'project';

export interface Favorite {
  resourceType: FavoriteResourceType;
  resourceId: string;
  /** workflow, folder or data table name */
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------------------------
// Execution annotations (P3-09)
// ---------------------------------------------------------------------------------------------

export type AnnotationVote = 'up' | 'down';

export interface AnnotationTag {
  id: string;
  /** 1..24 characters, unique per workspace (case-insensitive) */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** only with ?withUsageCount=true */
  usageCount?: number;
}

export interface ExecutionAnnotation {
  vote: AnnotationVote | null;
  tags: Tag[];
}

/** body of PATCH /executions/:id (at least one field) */
export interface AnnotationPatchBody {
  /** annotation tag ids, at most 50 */
  tags?: string[];
  vote?: AnnotationVote | null;
}

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: string;
  stoppedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  customData: Record<string, string> | null;
  /** P3-10: the workflow version the run used (null for runs before named versions) */
  workflowVersionId: string | null;
  /** P3-09 */
  annotation: ExecutionAnnotation | null;
}

export interface ExecutionDetail extends ExecutionSummary {
  workflowData: {
    id?: string;
    name: string;
    nodes: WorkflowNode[];
    connections: Connections;
    settings?: WorkflowSettings;
    pinData?: Record<string, Item[]>;
    stickyNotes?: StickyNote[];
    nodeGroups?: WorkflowNodeGroup[];
  };
  state: ExecutionState;
  /** P6-25: the caller's scopes on the execution's workflow */
  scopes?: Scope[];
}

export interface CredentialSummary extends ProjectOwnedFields {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  /** P6-24: usable by every member, read only (`credential:shareGlobally` sets it) */
  isGlobal?: boolean;
}

export interface CredentialDetail extends ProjectOwnedFields {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
  isGlobal?: boolean;
}

/** GET /credentials query (P6-24) */
export interface CredentialListQuery extends ProjectListFilter {
  type?: string;
}

/** POST /credentials */
export interface CredentialCreateBody {
  name: string;
  type: string;
  data: Record<string, unknown>;
  /** the project the credential goes to (omitted = the server's default project) */
  projectId?: string;
}

/** PATCH /credentials/:id; `isGlobal` needs `credential:shareGlobally` */
export interface CredentialPatchBody {
  name?: string;
  data?: Record<string, unknown>;
  isGlobal?: boolean;
}

/** POST /credentials/test: `projectId` names the project whose vaults the data may read */
export interface CredentialTestBody {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  projectId?: string;
}

export interface CredentialTestResult {
  status: 'OK' | 'Error';
  message: string;
}

export interface Variable {
  id: string;
  key: string;
  value: string;
  /** P6-31: null or absent = a global variable */
  projectId?: string | null;
}

/** POST, PATCH /variables: with `projectId` a project variable (`projectVariable:*`) */
export interface VariableBody {
  key: string;
  value: string;
  projectId?: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  [key: string]: unknown;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix?: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  /** P4-18: empty means every scope */
  scopes?: string[];
  [key: string]: unknown;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  scopes?: string[];
}

// ---------------------------------------------------------------------------------------------
// Workflow reviews and inbox (P3-19)
// ---------------------------------------------------------------------------------------------

export type ReviewState = 'open' | 'closed';
export type ReviewDecision = 'pending' | 'changes_requested' | 'approved';

export interface ReviewUser {
  id: string;
  name: string;
  email: string;
}

export interface WorkflowReviewDTO {
  id: string;
  /** null once the workflow was deleted */
  workflowId: string | null;
  workflowName: string | null;
  /** the pinned version (null once it was pruned) */
  workflowVersionId: string | null;
  versionName: string | null;
  /** the published version before an approval's auto-publish (null: none was published) */
  approvedBaselineVersionId: string | null;
  state: ReviewState;
  decision: ReviewDecision;
  title: string;
  description: string | null;
  reviewers: ReviewUser[];
  authors: ReviewUser[];
  createdBy: ReviewUser | null;
  updatedBy: ReviewUser | null;
  /** null for a system close (archive, delete) */
  closedBy: ReviewUser | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewListQuery {
  workflowId?: string;
  state?: ReviewState;
  limit?: number;
  cursor?: string;
}

export interface ReviewCreateBody {
  workflowId: string;
  /** the version to pin; omitted = the workflow's current version */
  versionId?: string;
  /** required, 1..128 */
  versionName: string;
  /** 1..128 */
  title: string;
  /** at most 512 */
  description?: string;
  /** 1..10, never the requester */
  reviewerUserIds: string[];
}

export interface ReviewUpdateVersionBody {
  versionId?: string;
  versionName: string;
}

export interface ReviewDecisionBody {
  decision: 'approved' | 'changes_requested';
  /** required for changes_requested; at most 10000, no control characters */
  note?: string;
}

export interface ReviewDecisionResult {
  review: WorkflowReviewDTO;
  /** approval only: the auto-publish of the pinned version as the requester */
  autoPublish?: { status: 'published' | 'failed'; message?: string };
}

export interface ReviewActivity {
  id: string;
  /** created, version_updated, decision, comment, closed */
  type: string;
  data: Record<string, unknown>;
  createdBy: ReviewUser | null;
  createdAt: string;
  /** set for type 'comment' */
  comment?: { id: string; body: string };
}

export type InboxTab = 'to_review' | 'mine';

export interface InboxQuery {
  tab?: InboxTab;
  limit?: number;
  cursor?: string;
}

export interface InboxSummary {
  /** open requests the caller is asked to review */
  toReview: number;
  /** open requests the caller authored */
  mine: number;
}

export interface ListResult<T> {
  data: T[];
  nextCursor: string | null;
}

/** value placed in password fields by the server; sent back unchanged it keeps the stored secret */
export const REDACTED = '__REDACTED__';

// ---------------------------------------------------------------------------------------------
// Push (SSE) events
// ---------------------------------------------------------------------------------------------

export interface PushEventMap {
  executionStarted: { executionId: string; workflowId: string; mode: ExecutionMode };
  nodeExecuteBefore: { executionId: string; nodeName: string };
  nodeExecuteAfter: { executionId: string; nodeName: string; runIndex: number; taskData: TaskData };
  executionFinished: {
    executionId: string;
    workflowId: string;
    status: ExecutionStatus;
    error?: ExecutionErrorShape;
  };
  consoleMessage: { executionId: string; nodeName: string; args: unknown[] };
  testWebhookReceived: { workflowId: string; executionId: string };
  /** P3-19: a review request of this workflow changed (created, decided, commented, closed) */
  workflowReviewChanged: { workflowId: string; requestId: string };
  ping: Record<string, unknown>;
}

export type PushEventType = keyof PushEventMap;

export type PushEvent = {
  [K in PushEventType]: { type: K; data: PushEventMap[K] };
}[PushEventType];

export const PUSH_EVENT_TYPES: PushEventType[] = [
  'executionStarted',
  'nodeExecuteBefore',
  'nodeExecuteAfter',
  'executionFinished',
  'consoleMessage',
  'testWebhookReceived',
  'workflowReviewChanged',
  'ping',
];

export type { CredentialTypeDescription, NodeTypeDescription };

// ---------------------------------------------------------------------------------------------
// Test listening (P4-01, P4-21)
// ---------------------------------------------------------------------------------------------

/** POST /workflows/:id/listen-test-webhook */
export interface ListenTestWebhookResult {
  testUrl: string;
  expiresAt: string;
  /** the `/form-test/...` URL of each form-trigger hook of the node; empty for other nodes */
  formTestUrls: string[];
  /**
   * P5-59: a chat trigger only. Signed token (kind `chat-test`) the canvas chat sends as
   * `x-chat-test-token` on its POST to `testUrl`; bound to this registration, 120 s.
   */
  chatTestToken?: string;
}

/** options of POST /workflows/:id/listen-test-webhook */
export interface ListenTestWebhookOptions {
  /** P5-59: a step run from the chat tab stops at this node */
  destinationNode?: string;
}

/** POST /workflows/:id/listen-test-trigger */
export interface ListenTestTriggerResult {
  expiresAt: string;
}

// ---------------------------------------------------------------------------------------------
// Data tables (P4-03, P4-05): the table, column, row and filter shapes are the engine's
// ---------------------------------------------------------------------------------------------

export type {
  DataTableCellValue,
  DataTableChange,
  DataTableColumn,
  DataTableColumnInput,
  DataTableColumnType,
  DataTableDryRunOption,
  DataTableDryRunRow,
  DataTableFilter,
  DataTableFilterClause,
  DataTableFilterCondition,
  DataTableInsertResult,
  DataTableInsertReturnType,
  DataTableListQuery,
  DataTablePage,
  DataTableRow,
  DataTableRowInput,
  DataTableRowResult,
  DataTableRowsQuery,
  DataTableSortDirection,
} from '@workflow/workflow';

/** the engine's table info plus the project fields (P6-23) */
export type DataTableInfo = WorkflowDataTableInfo & ProjectOwnedFields;

/** POST /data-tables; with `csv` the rows of the CSV text become the first rows */
export interface DataTableCreateBody {
  /** P6-23: the project the table goes to (omitted = the server's default project) */
  projectId?: string;
  name: string;
  /** `csvColumnName`: the header of the CSV column that fills the column */
  columns: Array<DataTableColumnInput & { csvColumnName?: string }>;
  csv?: string;
  hasHeaders?: boolean;
}

/** POST /data-tables/:id/columns; `index` is the 0-based position (absent = last) */
export interface DataTableColumnCreateBody extends DataTableColumnInput {
  index?: number;
}

export type DataTableQuotaStatus = 'ok' | 'warn' | 'error';

/** GET /data-tables/limits: the workspace's storage */
export interface DataTableLimits {
  totalBytes: number;
  maxBytes: number;
  warningBytes: number;
  quotaStatus: DataTableQuotaStatus;
  /** the largest CSV an upload may have right now, in bytes */
  uploadMaxFileSize: number;
  /** size per table, by table id */
  dataTables: Record<string, { id: string; name: string; sizeBytes: number }>;
}

/** GET /data-tables/:id/dependencies: the workflows that use a table */
export interface DataTableDependency {
  type: 'workflow';
  id: string;
  name: string;
}

/** POST /data-tables/csv/preview */
export interface DataTableCsvPreview {
  rowCount: number;
  columnCount: number;
  columns: DataTableColumnInput[];
}

/** POST /data-tables/:id/import-csv */
export interface DataTableCsvImportResult {
  importedRows: number;
  systemColumnsIgnored: string[];
}

/** what a row write may ask for; without `returnData` the server answers `true` */
export interface DataTableWriteOptions extends DataTableDryRunOption {
  returnData?: boolean;
}

/** GET /data-tables/:id/download-csv: the page turns it into a file */
export interface DataTableCsvDownload {
  csvContent: string;
  dataTableName: string;
}

// ---------------------------------------------------------------------------------------------
// External secrets (P4-07)
// ---------------------------------------------------------------------------------------------

export type SecretConnectionState =
  | 'initializing'
  | 'initialized'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'retrying';

/** GET /secret-providers/types: `properties` is the form of a connection's settings */
export interface SecretProviderTypeInfo {
  name: string;
  displayName: string;
  properties: NodeProperty[];
}

/** GET /secret-providers/connections: secret settings arrive blanked */
export interface SecretConnection {
  id: string;
  providerKey: string;
  type: string;
  settings: Record<string, unknown>;
  isEnabled: boolean;
  state: SecretConnectionState;
  /** fixed text, never a provider's response */
  lastError: string | null;
  secretsCount: number;
  /** how many credentials use this connection */
  credentialsCount: number;
  createdAt: string;
  updatedAt: string;
  /** P6-28: the owning project (null or absent = a workspace connection) */
  projectId?: string | null;
  /** P6-28: the projects a workspace connection is shared with */
  projects?: ProjectRef[];
}

export interface SecretConnectionCreateBody {
  providerKey: string;
  type: string;
  settings: Record<string, unknown>;
  /** P6-28: a workspace connection shared with these projects */
  projectIds?: string[];
}

/** a blanked secret sent back keeps its stored value */
export interface SecretConnectionPatchBody {
  type?: string;
  settings?: Record<string, unknown>;
  isEnabled?: boolean;
  /** P6-28: replaces the projects a workspace connection is shared with */
  projectIds?: string[];
}

export interface SecretConnectionTestResult {
  success: boolean;
  testState: 'connected' | 'tested' | 'error';
  error?: string;
}

/** GET /secret-providers/completions/secrets: secret names by connection key, for `$secrets` autocomplete */
export type SecretCompletions = Record<string, string[]>;

// ---------------------------------------------------------------------------------------------
// Form sign-in (P4-16)
// ---------------------------------------------------------------------------------------------

/** POST /form-auth/code: one-time code the form swaps for its token */
export interface FormAuthCode {
  code: string;
}

// ---------------------------------------------------------------------------------------------
// Evaluations (P5-02, P5-11): routes under /workflows/:workflowId/test-runs; DTOs are the engine's
// ---------------------------------------------------------------------------------------------

export type { TestCaseDto, TestCaseStatus, TestRunDto, TestRunStatus } from '@workflow/workflow';

/** GET /workflows/:workflowId/test-runs (newest first) */
export interface TestRunListQuery {
  skip?: number;
  limit?: number;
  status?: TestRunStatus;
}

/** GET /workflows/:workflowId/test-runs/:id/test-cases (by run index) */
export interface TestCaseListQuery {
  skip?: number;
  limit?: number;
}

/** POST /workflows/:workflowId/test-runs/new */
export interface TestRunStartBody {
  /** cases run at once, 1..10, clamped by the server to its limit; default 1 */
  concurrency?: number;
  /** only these dataset rows (0-based), for a rerun of some cases */
  rowIndices?: number[];
}

/** answer of POST /workflows/:workflowId/test-runs/new (202) */
export interface TestRunStartResult {
  testRunId: string;
}

// ---------------------------------------------------------------------------------------------
// Phase 5 S4: AI workflow builder (P5-09, P5-62..66) and MCP (P5-03, 04, 13, 14, 15)

/** `features.aiBuilder` of GET /settings: `enabled` = AI_ENABLED, `setup` = a model is set for the workspace */
export interface AiBuilderFeature {
  enabled: boolean;
  setup: boolean;
}

/** `TenantSettings.ai` (server plans.ts): the chat model node and credential the builder uses */
export interface TenantAiSettings {
  credentialId: string;
  /** a chat model node type, `ai.lmChat...` */
  nodeType: string;
  model: string;
  /** send parameter values (redacted, trimmed) to the model, not only the structure; default true */
  allowSendingParameterValues?: boolean;
}

/** answer of POST /ai/sessions `{ workflowId }`: this user's chat on this workflow */
export interface AiSessionDTO {
  workflowId: string;
  messages: BuilderMessage[];
  /** the message whose version card is the accepted one (`accepted-version`) */
  activeVersionCardId: string | null;
  /** set by a version restore: the chat goes on from this message */
  resumeAfterRestoreMessageId: string | null;
}

/** POST /ai/build/truncate-messages: removes this message and every later one */
export interface AiTruncateBody {
  workflowId: string;
  messageId: string;
}

/** POST /ai/build/accepted-version: the version Accept saved */
export interface AiAcceptedVersionBody {
  workflowId: string;
  versionId: string;
}

/** POST /ai/usage-settings (admin) */
export interface AiUsageSettingsBody {
  allowSendingParameterValues: boolean;
}

/** GET /mcp/settings (server services/mcp/settings.ts `McpSettingsDTO`) */
export interface McpSettings {
  mcpAccessEnabled: boolean;
  /** set by the environment (MCP_MANAGED_BY_ENV): the page shows it read only */
  managedByEnv: boolean;
  autoExposeNewWorkflows: boolean;
  /** the tenant MCP server's URL on the MCP base URL (MCP_BASE_URL): what a client connects to */
  serverUrl?: string;
}

/** PATCH /mcp/settings (admin) */
export interface McpSettingsPatchBody {
  mcpAccessEnabled?: boolean;
  autoExposeNewWorkflows?: boolean;
}

/** GET /mcp/api-key and POST /mcp/api-key/rotate: the caller's own MCP key (server `McpApiKeyDTO`) */
export interface McpApiKey {
  id: string;
  name: string;
  prefix: string;
  /** the whole key only in the reply that created it; else `wfk_<prefix>_...` */
  key: string;
  /** true when `key` is the whole key, shown this once */
  revealed: boolean;
  createdAt: string;
}

/** a row of GET /mcp/workflows (the workflows the caller can edit) */
export interface McpWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  availableInMCP: boolean;
  folderId: string | null;
  updatedAt: string;
}

/** GET /mcp/workflows query */
export interface McpWorkflowsQuery {
  search?: string;
  folderId?: string;
}

/** PATCH /mcp/workflows/toggle-access (admin); `workflowIds` at most 100 */
export interface McpToggleAccessBody {
  availableInMCP: boolean;
  workflowIds?: string[];
  folderId?: string;
  allWorkflows?: boolean;
}

/** answer of PATCH /mcp/workflows/toggle-access */
export interface McpToggleAccessResult {
  updatedCount: number;
}

/** GET and PATCH /mcp/oauth/allowed-redirect-uris (admin) */
export interface McpRedirectUris {
  allowedRedirectUris: string[];
}

/** a row of GET /mcp/oauth-clients (admin) */
export interface McpOAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

/** GET /mcp/instance-stats (admin) */
export interface McpInstanceStats {
  registeredClients: number;
  maxRegisteredClients: number;
}

/** GET /consent/details?flow= (server services/mcp/oauth/consent.ts `McpConsentDetails`) */
export interface McpConsentDetails {
  clientName: string;
  /** the workspace that grants access */
  tenantName: string;
  /** the server or trigger URL the token is bound to */
  resource: string;
  scopes: string[];
  /** the host the browser goes back to */
  redirectHost: string;
}

/** POST /consent/approve */
export interface McpConsentDecisionBody {
  flow: string;
  approved: boolean;
  scopes?: string[];
}

/** answer of POST /consent/approve: where the browser goes (checked before it navigates) */
export interface McpConsentResult {
  redirectUrl: string;
}

// ---------------------------------------------------------------------------------------------
// Phase 5 S5: Assistant (P5-67..74). The DTOs, events and cards are workflow's (src/assistant.ts).

export type {
  AssistantArtifact,
  AssistantAttachmentRef,
  AssistantConfirmAnswer,
  AssistantConfirmation,
  AssistantDraftDTO,
  AssistantEvent,
  AssistantMcpAuthentication,
  AssistantMcpConnectionDTO,
  AssistantMcpTransport,
  AssistantMessageDTO,
  AssistantMessagesPage,
  AssistantPermissionMode,
  AssistantPermissions,
  AssistantSendMessage,
  AssistantSettingsDTO,
  AssistantStatusDTO,
  AssistantTask,
  AssistantThreadDTO,
} from '@workflow/workflow';

/**
 * `features.assistant` of GET /settings: `enabled` = the Assistant is on for the workspace, `modelSet` = a chat
 * model is set for it. Never a credential id.
 */
export interface AssistantFeature {
  enabled: boolean;
  modelSet: boolean;
}

/** one card kind, as the card components take it (`ApprovalCard` gets `AssistantConfirmationOf<'approval'>`) */
export type AssistantConfirmationOf<K extends AssistantConfirmation['inputType']> = Extract<
  AssistantConfirmation,
  { inputType: K }
>;

/** an `artifact` event's draft reference; `DraftCard` loads the draft itself (`assistantApi.draft`) */
export type AssistantDraftArtifact = Extract<AssistantArtifact, { type: 'draft' }>;

/** answer of GET /assistant/threads (newest first) */
export interface AssistantThreadPage {
  data: AssistantThreadDTO[];
  nextCursor: string | null;
}

/** GET /assistant/threads query */
export interface AssistantThreadsQuery {
  limit?: number;
  cursor?: string;
}

/** a credential Accept assigns to a node that has none (first of its type in the workspace) */
export interface AssistantDraftAssignment {
  nodeName: string;
  credentialType: string;
  credentialId: string;
  credentialName: string;
}

/** answer of GET /assistant/threads/:threadId/drafts/:draftId */
export interface AssistantDraftView {
  draft: AssistantDraftDTO;
  diff: WorkflowDiff;
  assignments: AssistantDraftAssignment[];
}

/** body of POST .../drafts/:draftId/accept (editor; a person only) */
export interface AssistantAcceptDraftBody {
  name?: string;
  /** the draft version the card shows (draft.updatedAt); the server saves only that version */
  updatedAt?: string;
}

/** answer of POST .../drafts/:draftId/accept */
export interface AssistantAcceptDraftResult {
  workflowId: string;
  draft: AssistantDraftDTO;
}

/** body of PATCH /assistant/settings (admin): each field optional, null clears a field that can be cleared */
export interface AssistantSettingsPatchBody {
  enabled?: boolean | null;
  credentialId?: string | null;
  nodeType?: string | null;
  model?: string | null;
  searchCredentialId?: string | null;
  searchDisabled?: boolean | null;
  mcpAccessEnabled?: boolean | null;
  permissions?: Partial<AssistantPermissions> | null;
  allowSendingParameterValues?: boolean | null;
}

/** body of POST /assistant/mcp-connections (admin); a credential id, never a secret */
export interface AssistantMcpConnectionBody {
  name: string;
  url: string;
  transport?: AssistantMcpTransport;
  authentication?: AssistantMcpAuthentication;
  credentialId?: string | null;
  enabled?: boolean;
  /** may only tighten the workspace's MCP permissions */
  toolPermissions?: Record<string, AssistantPermissionMode>;
}

/** body of PATCH /assistant/mcp-connections/:id (admin) */
export type AssistantMcpConnectionPatchBody = Partial<AssistantMcpConnectionBody>;
