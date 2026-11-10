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
  RedactionFloor,
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

/** P6-03: the system workspace roles */
export type SystemRole = 'owner' | 'admin' | 'member';
/** a workspace role: a system role or a custom global role slug (as the server's db/role-types.ts) */
export type Role = SystemRole | (string & {});

/** the system workspace roles (P6-39: the old `editor` and `viewer` are project roles now) */
export const ROLES: Role[] = ['owner', 'admin', 'member'];

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
  /** P6-01: how this session signed in (absent before S2's server) */
  authMethod?: AuthMethod;
  /** P6-18: two-step sign-in is set up for this user */
  mfaEnabled: boolean;
  /** P6-01: an SSO session: the global account (name, email, password, MFA) cannot change from it */
  ssoFenced: boolean;
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
  features: Record<string, unknown> & SettingsFeatures;
  /** P6-18: the workspace requires two-step sign-in (absent = not required) */
  mfa?: { enforced: boolean };
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
  /** this month's usage, sent only when signed in; P6-84 adds `activeWorkflows` (the limit is
   *  `limits.activeWorkflows`, null or absent = unlimited) */
  usage?: { period: string; executions: number; executionMs: number; activeWorkflows?: number };
  /** P6-53: the workspace's redaction floor (a workflow policy cannot be weaker; absent = 'off') */
  redactionFloor?: RedactionFloor;
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
  /** P6-53: the workspace's redaction floor */
  redaction: { floor: RedactionFloor };
}

/** POST /settings/security */
export interface SecurityPolicyPatch {
  personalSpacePublishing?: boolean;
  personalSpaceSharing?: boolean;
  /** P6-53 */
  redaction?: { floor: RedactionFloor };
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
  /** P6-15: a node uses a private (per user) credential; the card shows an icon */
  usesPrivateCredentials?: boolean;
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
  /** P6-15: the run used a private (per user) credential; the list shows an icon */
  usedPrivateCredentials?: boolean;
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
  /** P6-53: absent when nothing was redacted; with `isRedacted` the items are cleared */
  redactionInfo?: RedactionInfo;
  /** P6-53: what is left of a redacted run's error (the run error moves here from `state`) */
  redactedError?: ExecutionErrorShape | null;
}

export interface CredentialSummary extends ProjectOwnedFields {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  /** P6-24: usable by every member, read only (`credential:shareGlobally` sets it) */
  isGlobal?: boolean;
  /** P6-15: a private credential: each user connects their own account (`credential:createEndUser`) */
  isResolvable?: boolean;
  /** P6-15: the caller has connected their own account to this private credential */
  connectedByMe?: boolean;
  /** P6-15: how many users have connected an account to this private credential */
  connectedCount?: number;
}

export interface CredentialDetail extends ProjectOwnedFields {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
  isGlobal?: boolean;
  /** P6-15: as on `CredentialSummary` */
  isResolvable?: boolean;
  connectedByMe?: boolean;
  connectedCount?: number;
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
  /** P6-15: a private (per user) credential; OAuth types only, never in a personal project */
  isResolvable?: boolean;
}

/** PATCH /credentials/:id; `isGlobal` needs `credential:shareGlobally` */
export interface CredentialPatchBody {
  name?: string;
  data?: Record<string, unknown>;
  isGlobal?: boolean;
  /** P6-15: needs `credential:createEndUser` */
  isResolvable?: boolean;
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
  /** P6-20: pending is an open invitation; disabled is a member turned off (SCIM, LDAP, an admin) */
  status?: MemberStatus;
  /** P6-20: a pending row's invitation (resend, invite link) */
  invitationId?: string;
  /** P6-20: ISO time, updated at most once a day; null = never */
  lastActiveAt?: string | null;
  /** P6-18: two-step sign-in is set up */
  mfaEnabled?: boolean;
  /** P6-02: SCIM created this user; only SCIM changes the name and email */
  managedByScim?: boolean;
  /** P6-13: may sign in with a password while SSO is on */
  allowSsoManualLogin?: boolean;
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
  /** P6-21: unix seconds; null or absent = never expires */
  expiresAt?: number | null;
  /** P6-21: the All keys tab (`apiKey:manage`) */
  ownerId?: string;
  ownerName?: string;
  [key: string]: unknown;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  scopes?: string[];
  /** P6-21: unix seconds; null or absent = never expires */
  expiresAt?: number | null;
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
  /** P6-81: who has the workflow open changed */
  collaboratorsChanged: { workflowId: string; collaborators: Collaborator[] };
  /** P6-81: a tab took the write lock (`clientId` is that tab's `push-ref`) */
  writeAccessAcquired: { workflowId: string; userId: string; clientId: string };
  /** P6-81: the write lock was released, expired or taken over */
  writeAccessReleased: { workflowId: string };
  /** P6-81: someone saved the workflow */
  workflowUpdated: { workflowId: string; userId: string };
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
  'collaboratorsChanged',
  'writeAccessAcquired',
  'writeAccessReleased',
  'workflowUpdated',
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

// ---------------------------------------------------------------------------------------------
// Phase 6 S2: identity (sign-in methods, MFA, password, members, API keys, SSO, LDAP, SCIM)
// ---------------------------------------------------------------------------------------------

/** P6-01: how a session signed in */
export type AuthMethod = 'password' | 'saml' | 'oidc' | 'ldap';

/** P6-01: the workspace's sign-in method; `email` is email and password */
export type SsoMethod = 'email' | 'saml' | 'oidc' | 'ldap';

/** `Settings.features` keys of S2 (absent until the settings load) */
export interface SettingsFeatures {
  /** P6-17: the server can send mail (SMTP configured) */
  mail?: boolean;
  /** P6-18: two-step sign-in is available (`MFA_ENABLED`) */
  mfa?: boolean;
  /** P6-21: the public API is on (`PUBLIC_API_DISABLED` unset) */
  publicApi?: boolean;
}

/** body of POST /auth/login */
export interface LoginBody {
  email: string;
  password: string;
  /** P6-01: the workspace slug to sign in to (`?workspace=`) */
  workspace?: string;
  /** P6-18: the 6 digit code of the second step */
  mfaCode?: string;
  /** P6-18: a recovery code instead of `mfaCode` */
  mfaRecoveryCode?: string;
}

/** P6-18: the second sign-in step's input (exactly one of the two) */
export type MfaLoginInput = { mfaCode: string } | { mfaRecoveryCode: string };

/** GET /auth/sso-options?workspace= (public, P6-01) */
export interface SsoOptions {
  method: SsoMethod;
  /** the sign-in button's text (null or absent: a default text) */
  label?: string | null;
  /** send the sign-in page straight to the identity provider (`SSO_REDIRECT_LOGIN_TO_SSO`) */
  redirect: boolean;
}

/** GET /auth/mfa/setup (P6-18): a new secret and new codes on each call until enabled; codes shown once */
export interface MfaSetup {
  secret: string;
  /** the otpauth:// URI the QR code encodes */
  otpauthUrl: string;
  recoveryCodes: string[];
}

/** body of POST /auth/mfa/disable: exactly one of the two */
export type MfaDisableBody = { mfaCode: string } | { mfaRecoveryCode: string };

/** POST /auth/reset-token/resolve (P6-19) */
export interface ResetTokenInfo {
  /** the reset needs an MFA code too */
  mfaEnabled: boolean;
}

/** body of POST /auth/reset-password (P6-19); the token travels in the body, never in a URL */
export interface ResetPasswordBody {
  token: string;
  password: string;
  mfaCode?: string;
}

/** body of POST /auth/change-email (P6-19): the current password or an MFA code */
export interface ChangeEmailBody {
  email: string;
  currentPassword?: string;
  mfaCode?: string;
}

/** body of PATCH /auth/me/password (P6-19) */
export interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
  mfaCode?: string;
}

/** P6-20 */
export type MemberStatus = 'active' | 'pending' | 'disabled';

export type MemberSortField = 'name' | 'email' | 'role' | 'mfaEnabled' | 'lastActiveAt';

/** GET /members query (P6-20); `status` needs `user:create` */
export interface MemberListQuery {
  q?: string;
  role?: Role;
  projectId?: string;
  status?: MemberStatus;
  sort?: `${MemberSortField}:${'asc' | 'desc'}`;
  take?: number;
  skip?: number;
}

/** GET /members with paging (P6-20): `count` and `statusCounts` ride beside `data` in the answer */
export interface MemberPage {
  items: Member[];
  /** every row the filter matches (all pages) */
  count: number;
  /** callers with `user:create` only */
  statusCounts?: Record<MemberStatus, number>;
}

/** one row of POST /members/invite with an array body (P6-20) */
export interface MemberInvite {
  email: string;
  role: Role;
}

/** the answer per row of POST /members/invite with an array body, and of resend (P6-20) */
export interface MemberInviteResult {
  id: string;
  email: string;
  role: Role;
  emailSent: boolean;
  /** absent when the mail went out and `INVITE_LINKS_EMAIL_ONLY` is set */
  inviteAcceptUrl?: string;
  error?: string;
}

/** GET /api-keys?scope=all query (P6-21, `apiKey:manage`) */
export interface ApiKeyListAllQuery {
  ownerId?: string;
  label?: string;
}

/** body of PATCH /api-keys/:id (P6-21) */
export interface ApiKeyPatchBody {
  name?: string;
  scopes?: string[];
}

/** P6-09: the SAML attributes that carry the user's fields */
export interface SamlAttributeMapping {
  email: string;
  firstName: string;
  lastName: string;
  userPrincipalName: string;
}

/** GET /sso/saml/config (P6-09, `saml:manage`) */
export interface SamlConfig {
  /** the identity provider's metadata XML */
  metadata: string;
  /** or its URL (the server reads it through the egress guard) */
  metadataUrl: string;
  mapping: SamlAttributeMapping;
  loginBinding: 'redirect' | 'post';
  loginEnabled: boolean;
  loginLabel: string;
  /** refuse a sign-in whose email is not marked verified */
  emailVerifiedRequired: boolean;
  wantAssertionsSigned?: boolean;
  wantMessageSigned?: boolean;
  authnRequestsSigned?: boolean;
  /** read only: the values to give the identity provider */
  entityID?: string;
  returnUrl?: string;
}

/** body of POST /sso/saml/config: the read only fields are left out */
export type SamlConfigBody = Partial<Omit<SamlConfig, 'entityID' | 'returnUrl'>>;

export type OidcPrompt = 'none' | 'login' | 'consent' | 'select_account' | 'create';

/** GET /sso/oidc/config (P6-10, `oidc:manage`) */
export interface OidcConfig {
  clientId: string;
  /** blank on read; a blank secret on save keeps the stored one */
  clientSecret: string;
  discoveryEndpoint: string;
  loginEnabled: boolean;
  prompt: OidcPrompt;
  authenticationContextClassReference: string[];
  /** space separated, added to `openid email profile` */
  additionalScopes: string;
  emailVerifiedRequired: boolean;
  rpInitiatedLogoutEnabled: boolean;
  /** read only: the redirect URL to give the identity provider */
  callbackUrl?: string;
}

/** body of POST /sso/oidc/config */
export type OidcConfigBody = Partial<Omit<OidcConfig, 'callbackUrl'>>;

/** POST /sso/saml/config/test and /sso/oidc/config/test: the URL to open in a new window */
export interface SsoTestResult {
  url: string;
}

/** GET /sso/provisioning/config (P6-11, `provisioning:manage`) */
export interface ProvisioningConfig {
  /** the workspace role comes from the identity provider on each sign-in */
  scopesProvisionInstanceRole: boolean;
  /** project roles too */
  scopesProvisionProjectRoles: boolean;
  /** true: the role mapping rules here; false: the claims named below */
  scopesUseExpressionMapping: boolean;
  /** the scope asked for when provisioning is on */
  scopesName: string;
  scopesInstanceRoleClaimName: string;
  scopesProjectsRolesClaimName: string;
  /** the default condition: a workspace role slug, 'block' (deny access) or null (keep the role they have) */
  defaultInstanceRole?: string | null;
}

/** one row of GET /sso/role-mapping-rules (P6-11, `roleMappingRule:list`) */
export interface RoleMappingRule {
  id: string;
  type: 'instance' | 'project';
  /** evaluated with the sign-in claims; only `true` matches, an error is false */
  expression: string;
  role: Role;
  order: number;
  /** project rules only */
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** body of POST /sso/role-mapping-rules and PATCH /sso/role-mapping-rules/:id */
export interface RoleMappingRuleBody {
  type?: 'instance' | 'project';
  expression?: string;
  role?: Role;
  projectIds?: string[];
}

export type LdapConnectionSecurity = 'none' | 'tls' | 'startTls';

/** GET /ldap/config (P6-12, `ldap:manage`) */
export interface LdapConfig {
  loginEnabled: boolean;
  loginLabel: string;
  connectionUrl: string;
  allowUnauthorizedCerts: boolean;
  connectionSecurity: LdapConnectionSecurity;
  connectionPort: number;
  baseDn: string;
  bindingAdminDn: string;
  /** blank on read; a blank password on save keeps the stored one */
  bindingAdminPassword: string;
  firstNameAttribute: string;
  lastNameAttribute: string;
  emailAttribute: string;
  loginIdAttribute: string;
  ldapIdAttribute: string;
  userFilter: string;
  synchronizationEnabled: boolean;
  /** minutes */
  synchronizationInterval: number;
  searchPageSize: number;
  /** seconds */
  searchTimeout: number;
  enforceEmailUniqueness: boolean;
  linkExistingAccountsByEmail: boolean;
}

/** one row of GET /ldap/sync (P6-12, `ldap:sync`), newest first */
export interface LdapSyncRun {
  id: string;
  runMode: 'dry' | 'live';
  status: 'success' | 'error';
  startedAt: string;
  endedAt: string | null;
  scanned: number;
  created: number;
  updated: number;
  disabled: number;
  error: string | null;
}

/** GET /scim/config (P6-02, `scim:manage`) */
export interface ScimConfig {
  enabled: boolean;
  hasToken: boolean;
  /** the token's last four characters */
  tokenHint: string | null;
  baseUrl: string;
  onDelete: 'disable' | 'delete';
  dataAction: 'transfer' | 'delete';
  transferProjectId: string | null;
}

/** body of PUT /scim/deprovisioning */
export interface ScimDeprovisioningBody {
  onDelete: 'disable' | 'delete';
  dataAction: 'transfer' | 'delete';
  transferProjectId?: string | null;
}

/** POST /scim/token: the token is shown once */
export interface ScimTokenResult {
  token: string;
  baseUrl: string;
}

/** one row of GET /scim/transfer-targets: team projects and active members' personal projects */
export interface ScimTransferTarget {
  id: string;
  name: string;
  type: 'team' | 'personal';
}

// ---------------------------------------------------------------------------------------------
// Phase 6 S3: type policies (P6-48..P6-51), redaction (P6-53), insights (P6-05, P6-57), collaboration
// (P6-81), rate limits (P6-83), dependencies (P6-86)
// ---------------------------------------------------------------------------------------------

/** P6-48: a policy covers node types or credential types (one store for both) */
export type TypePolicyKind = 'node' | 'credential';

/** P6-48: what a rule or a scope default does; a project scope never delegates */
export type TypePolicyAction = 'allow' | 'deny' | 'delegate';

/** P6-48: which types a rule matches; `extends` is for credential policies only */
export interface TypePolicySelector {
  /** a type name; a node rule also matches the type's tool variants */
  name?: string;
  /** a package name, e.g. `@workflow/nodes-ai` */
  package?: string;
  /** credential types extending this one (oAuth2Api covers googleOAuth2Api) */
  extends?: string;
}

export interface TypePolicyRule {
  id: string;
  action: TypePolicyAction;
  selector: TypePolicySelector;
  description?: string | null;
}

/** P6-48: a document of ordered rules (first match wins) */
export interface TypePolicyDocument {
  id: string;
  kind: TypePolicyKind;
  name: string;
  description?: string | null;
  rules: TypePolicyRule[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** P6-48: a document attached to a scope; floors are judged first, then the rest, by priority */
export interface TypePolicyAttachment {
  policyId: string;
  priority: number;
  isFloor: boolean;
}

/** P6-48: the workspace scope (`projectId` null, n8n's instance scope) or one project's */
export interface TypePolicyScope {
  id: string;
  kind: TypePolicyKind;
  projectId: string | null;
  defaultAction: TypePolicyAction;
  /** 0 until the first write; a write sends the version it read (a stale one gets 409) */
  version: number;
  attachments: TypePolicyAttachment[];
}

/** P6-49: one row of GET /projects/:projectId/available-types (or /available-credential-types) */
export interface AvailableType {
  type: string;
  available: boolean;
  /** only on an unavailable row */
  reason?: string;
  /** which scope blocked it (a project denial never names the project) */
  scope?: 'workspace' | 'project';
  /** the workspace delegates this type, so a project admin may allow it */
  optInAvailable?: boolean;
}

/**
 * P6-04: one blocked type in a 403 `policy_violation` answer (`details.violations`). S1's
 * `PolicyViolation` is the transfer preview's row, a different shape.
 */
export interface TypePolicyViolation {
  kind: 'node-type-unavailable' | 'credential-type-unavailable';
  type: string;
  scope: 'workspace' | 'project';
  matchedRuleId: string | null;
  optInAvailable: boolean;
  nodeName?: string;
}

/** P6-49: GET /workflows/:id/sub-workflows/:subId/policy-check (404 hides a workflow the caller cannot see) */
export interface SubWorkflowPolicyCheck {
  allowed: boolean;
  violations: TypePolicyViolation[];
}

/** P6-53: why a run's data is hidden and whether the caller may reveal it */
export interface RedactionInfo {
  isRedacted: boolean;
  /** e.g. `workflow_redaction_policy`, `sub_workflow_redaction_policy`, `credential_access` */
  reason: string;
  /** the caller holds `execution:reveal` and may use every credential the run touched */
  canReveal: boolean;
}

/** P6-57: the five summary tiles and chart types (`/insights/:insightType`, default `total`) */
export type InsightsSummaryType = 'total' | 'failed' | 'failureRate' | 'timeSaved' | 'averageRunTime';

export interface InsightsMetric {
  value: number;
  unit: 'count' | 'ratio' | 'minute' | 'millisecond';
  /** current minus the previous period of the same length; null when that period had no runs */
  deviation: number | null;
}

/** P6-05: GET /insights/summary */
export type InsightsSummary = Record<InsightsSummaryType, InsightsMetric>;

/** P6-05: the query of every insights read; no `startDate` = the last 7 days, no `endDate` = now */
export interface InsightsQuery {
  startDate?: string;
  endDate?: string;
  projectId?: string;
  /** IANA zone for the bucket and day boundaries */
  timeZone?: string;
}

export type InsightsByWorkflowSortField =
  | 'total'
  | 'succeeded'
  | 'failed'
  | 'failureRate'
  | 'timeSaved'
  | 'runTime'
  | 'averageRunTime'
  | 'workflowName';

export interface InsightsByWorkflowQuery extends InsightsQuery {
  skip?: number;
  /** 1..100, default 10 */
  take?: number;
  /** `<field>:asc` or `<field>:desc`, default `total:desc` */
  sortBy?: `${InsightsByWorkflowSortField}:${'asc' | 'desc'}`;
}

/** P6-05: one row of GET /insights/by-workflow */
export interface InsightsByWorkflowRow {
  /** null when the workflow was deleted */
  workflowId: string | null;
  workflowName: string;
  /** the caller may open the workflow (the table links it only then) */
  hasReadAccess: boolean;
  projectId: string | null;
  projectName: string | null;
  total: number;
  succeeded: number;
  failed: number;
  failureRate: number;
  runTime: number;
  averageRunTime: number;
  timeSaved: number;
}

/** P6-05: GET /insights/by-workflow (inside the usual `{ data }` envelope) */
export interface InsightsByWorkflowPage {
  count: number;
  data: InsightsByWorkflowRow[];
}

/** P6-05: one bucket of GET /insights/by-time (`/by-time/time-saved` sends only `timeSaved`) */
export interface InsightsByTimeRow {
  /** ISO start of the bucket */
  date: string;
  values: Partial<Record<InsightsSummaryType | 'succeeded', number>>;
}

export type InsightsDateRangeKey = 'day' | 'week' | '2weeks' | 'month' | 'quarter' | '6months' | 'year';
export type InsightsGranularity = 'hour' | 'day' | 'week';

/** P6-05: GET /insights/settings (every range is open to owner and admin; no licence limits) */
export interface InsightsSettings {
  summary: boolean;
  dashboard: boolean;
  dateRanges: Array<{ key: InsightsDateRangeKey; licensed: boolean; granularity: InsightsGranularity }>;
  /** the first day with data, null when there is none */
  earliestDataDate: string | null;
}

/** P6-86: what a dependency count or detail is about */
export type DependencyResourceKind = 'workflow' | 'credential' | 'dataTable';

/** P6-86: how one resource uses another (n8n's keys, `agentUsage` left out) */
export type DependencyKey =
  | 'credentialId'
  | 'dataTableId'
  | 'errorWorkflow'
  | 'errorWorkflowParent'
  | 'workflowCall'
  | 'workflowParent';

/** P6-86: counts per key for one resource (a missing key is 0); rows the caller cannot read are not counted */
export type DependencyCounts = Partial<Record<DependencyKey, number>>;

/** P6-86: body of POST /workflow-dependencies/counts and /details (100 ids at most) */
export interface DependencyQueryBody {
  resourceType: DependencyResourceKind;
  resourceIds: string[];
}

/** P6-86: one related resource the caller may read */
export interface DependencyDetail {
  key: DependencyKey;
  /** the related resource */
  id: string;
  name: string;
  resourceType: DependencyResourceKind;
  projectId: string | null;
  /** a related workflow is published */
  active?: boolean;
}

/** P6-86: GET /workflow-dependencies/projects/:projectId/folders/:folderId (the folder's whole tree) */
export interface FolderDependencies {
  /** workflows in the tree that other resources use, each with what uses it */
  workflows: Array<{ id: string; name: string; dependencies: DependencyDetail[] }>;
}

/** P6-83: the workspace's public API rate limits per API key; 0 = no limit; windows in seconds */
export interface RateLimitSettings {
  enabled: boolean;
  globalReadLimit: number;
  globalReadWindow: number;
  globalWriteLimit: number;
  globalWriteWindow: number;
  endpointReadLimit: number;
  endpointReadWindow: number;
  endpointWriteLimit: number;
  endpointWriteWindow: number;
}

/** P6-81: someone with the workflow open */
export interface Collaborator {
  userId: string;
  name: string;
  email: string;
  /** ISO time of the last heartbeat (gone after 15 minutes without one) */
  lastSeen: string;
}

/** P6-81: who may write the workflow now (expires 2 minutes after the last heartbeat) */
export interface WriteLock {
  userId: string;
  /** the holding tab's `push-ref` */
  clientId: string;
  name: string;
  expiresAt: string;
}

/** P6-81: the answer of POST /workflows/:id/presence and /write-access */
export interface CollaborationState {
  collaborators: Collaborator[];
  writeLock: WriteLock | null;
}

export type PresenceAction = 'open' | 'heartbeat' | 'close';
export type WriteAccessAction = 'request' | 'force' | 'release' | 'heartbeat';
