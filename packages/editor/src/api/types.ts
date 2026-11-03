/**
 * DTOs of the REST contract (docs/ARCHITECTURE.md section 14). Field names here must match the
 * contract exactly; the server is built against the same document.
 */
import type {
  Connections,
  CredentialTypeDescription,
  ExecutionErrorShape,
  ExecutionMode,
  ExecutionState,
  ExecutionStatus,
  Item,
  NodeTypeDescription,
  RunData,
  StickyNote,
  TaskData,
  WorkflowDiff,
  WorkflowNode,
  WorkflowNodeGroup,
  WorkflowSettings,
} from '@workflow/workflow';

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

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
}

export interface TenantMembership extends Tenant {
  role: Role;
}

export interface Me extends AuthResult {
  tenants: TenantMembership[];
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
}

/** body of PATCH /settings (admin) */
export interface SettingsPatchBody {
  brand?: Partial<Brand>;
  timezone?: string;
  workflowReviews?: { enabled: boolean };
}

export interface Tag {
  id: string;
  name: string;
}

export interface WorkflowSummary {
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

export interface WorkflowDTO {
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
}

export type WorkflowPatchBody = Partial<
  Omit<WorkflowDTO, 'id' | 'createdAt' | 'updatedAt' | 'folderId' | 'isArchived' | 'publishedVersionId'>
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

export interface Folder {
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

export interface FolderListQuery {
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
}

export interface FolderUpdateBody {
  name?: string;
  parentFolderId?: string | null;
  /** replaces the folder's tags (workspace tags only) */
  tagIds?: string[];
}

export type FavoriteResourceType = 'workflow' | 'folder';

export interface Favorite {
  resourceType: FavoriteResourceType;
  resourceId: string;
  /** workflow or folder name */
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
}

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialDetail {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}

export interface CredentialTestResult {
  status: 'OK' | 'Error';
  message: string;
}

export interface Variable {
  id: string;
  key: string;
  value: string;
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
  [key: string]: unknown;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
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
