/** One typed function per REST endpoint of the contract. */
import type {
  BinaryData,
  DataTableChange,
  DataTableColumn,
  DataTableFilter,
  DataTableInsertResult,
  DataTableInsertReturnType,
  DataTableListQuery,
  DataTablePage,
  DataTableRow,
  DataTableRowInput,
  DataTableRowResult,
  DataTableRowsQuery,
  DataTableSortDirection,
  ListSearchResult,
  NodePropertyOption,
  ResourceMapperFields,
  WorkflowNode,
} from '@workflow/workflow';
import { ApiError, api, buildUrl, getCurrentTenant, request } from './client';
import type {
  AiSessionDTO,
  AiUsageSettingsBody,
  AnnotationPatchBody,
  AnnotationTag,
  AnnotationVote,
  ApiKey,
  AssistantAcceptDraftBody,
  AssistantAcceptDraftResult,
  AssistantConfirmAnswer,
  AssistantDraftView,
  AssistantMcpConnectionBody,
  AssistantMcpConnectionDTO,
  AssistantMcpConnectionPatchBody,
  AssistantMessagesPage,
  AssistantSendMessage,
  AssistantSettingsDTO,
  AssistantSettingsPatchBody,
  AssistantStatusDTO,
  AssistantThreadDTO,
  AssistantThreadPage,
  AssistantThreadsQuery,
  AuthResult,
  CreatedApiKey,
  CredentialCreateBody,
  CredentialDetail,
  CredentialListQuery,
  CredentialPatchBody,
  CredentialSummary,
  CredentialTestBody,
  CredentialTestResult,
  CredentialTransferBody,
  CredentialTypeDescription,
  CustomRole,
  DataTableColumnCreateBody,
  DataTableCreateBody,
  DataTableCsvDownload,
  DataTableCsvImportResult,
  DataTableCsvPreview,
  DataTableDependency,
  DataTableInfo,
  DataTableLimits,
  DataTableWriteOptions,
  ExecutionAnnotation,
  ExecutionDetail,
  ExecutionSummary,
  Favorite,
  FavoriteResourceType,
  Folder,
  FolderCreateBody,
  FolderDetail,
  FolderListQuery,
  FolderTransferBody,
  FolderUpdateBody,
  FormAuthCode,
  InboxQuery,
  InboxSummary,
  ListenTestTriggerResult,
  ListenTestWebhookOptions,
  ListenTestWebhookResult,
  McpApiKey,
  McpConsentDecisionBody,
  McpConsentDetails,
  McpConsentResult,
  McpInstanceStats,
  McpOAuthClient,
  McpRedirectUris,
  McpSettings,
  McpSettingsPatchBody,
  McpToggleAccessBody,
  McpToggleAccessResult,
  McpWorkflowSummary,
  McpWorkflowsQuery,
  Me,
  Member,
  MemberRemovalChoice,
  MoveWorkflowsBody,
  NodeTypeDescription,
  Project,
  ProjectAddUsersResult,
  ProjectCount,
  ProjectCreateBody,
  ProjectDetail,
  ProjectListFilter,
  ProjectListQuery,
  ProjectPage,
  ProjectPatchBody,
  ProjectRef,
  ProjectRelationInput,
  PublishBody,
  PublishTimelineEntry,
  ReviewActivity,
  ReviewCreateBody,
  ReviewDecisionBody,
  ReviewDecisionResult,
  ReviewListQuery,
  ReviewUpdateVersionBody,
  ReviewUser,
  Role,
  RoleAssignmentsPage,
  RoleCreateBody,
  RoleMembersPage,
  RolePatchBody,
  RolesMap,
  RunWorkflowBody,
  SecretCompletions,
  SecretConnection,
  SecretConnectionCreateBody,
  SecretConnectionPatchBody,
  SecretConnectionTestResult,
  SecretProviderTypeInfo,
  SecurityPolicy,
  SecurityPolicyPatch,
  Settings,
  SettingsPatchBody,
  Tag,
  TestCaseDto,
  TestCaseListQuery,
  TestRunDto,
  TestRunListQuery,
  TestRunStartBody,
  TestRunStartResult,
  TransferPreview,
  Variable,
  VariableBody,
  VersionDiff,
  VersionPatchBody,
  VersionSnapshot,
  VersionSummary,
  WebhookUrlInfo,
  WorkflowCreateBody,
  WorkflowDTO,
  WorkflowImportData,
  WorkflowPatchBody,
  WorkflowReviewDTO,
  WorkflowSummary,
  WorkflowTransferBody,
} from './types';

const enc = encodeURIComponent;

export const authApi = {
  signup: (body: { email: string; password: string; name: string; workspaceName: string }) =>
    api.post<AuthResult>('/auth/signup', body),
  login: (body: { email: string; password: string }) => api.post<AuthResult>('/auth/login', body),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  me: () => api.get<Me>('/auth/me'),
  switchTenant: (tenantId: string) => api.post<AuthResult>('/auth/switch-tenant', { tenantId }),
  acceptInvitation: (token: string, body: { name: string; password: string }) =>
    api.post<AuthResult>(`/invitations/${enc(token)}/accept`, body),
};

export const settingsApi = {
  get: () => api.get<Settings>('/settings'),
  /** admin only; answers the same shape as GET for the fields it returns */
  update: (body: SettingsPatchBody) => api.patch<Partial<Settings>>('/settings', body),
};

export interface LoadOptionsBody {
  nodeType: string;
  method: string;
  kind: 'loadOptions' | 'listSearch' | 'resourceMapping';
  node: WorkflowNode;
  filter?: string;
  paginationToken?: string;
  /** the saved workflow open in the editor, so pickers can leave it out */
  workflowId?: string;
  /** P6-27: with no saved workflow, the project whose credentials the call may use */
  projectId?: string;
}

export const nodeTypesApi = {
  list: () => api.get<NodeTypeDescription[]>('/node-types'),
  credentialTypes: () => api.get<CredentialTypeDescription[]>('/credential-types'),
  loadOptions: (body: LoadOptionsBody & { kind: 'loadOptions' }) =>
    api.post<NodePropertyOption[]>('/node-types/options', body),
  listSearch: (body: LoadOptionsBody & { kind: 'listSearch' }) =>
    api.post<ListSearchResult>('/node-types/options', body),
  /** P5-80: `method` names an entry of the node's `methods.resourceMapping` */
  resourceMapping: (body: LoadOptionsBody & { kind: 'resourceMapping' }) =>
    api.post<ResourceMapperFields>('/node-types/options', body),
};

export interface WorkflowListQuery extends ProjectListFilter {
  search?: string;
  tagId?: string;
  active?: boolean;
  limit?: number;
  cursor?: string;
  /** P3-07: a folder id or 'root'; omitted = every folder */
  folderId?: string;
  /** P3-07: 'false' (default) hides archived workflows, 'all' mixes them in */
  archived?: 'false' | 'true' | 'all';
  /** P3-01: with `search`, also match workflows holding one of these node types (max 20) */
  nodeTypes?: string[];
  /** P3-01: with `search`, also match workflows with a tag named like the search */
  matchTags?: boolean;
}

/** `/workflows/:id/versions/:versionId/diff?against=` */
export type DiffAgainst = 'current' | 'published' | (string & {});

export const workflowsApi = {
  list: ({ nodeTypes, ...query }: WorkflowListQuery = {}) =>
    api.list<WorkflowSummary>('/workflows', {
      ...query,
      nodeTypes: nodeTypes?.length ? nodeTypes.join(',') : undefined,
    }),
  get: (id: string) => api.get<WorkflowDTO>(`/workflows/${enc(id)}`),
  create: (body: WorkflowCreateBody) => api.post<WorkflowDTO>('/workflows', body),
  update: (id: string, body: WorkflowPatchBody) => api.patch<WorkflowDTO>(`/workflows/${enc(id)}`, body),
  remove: (id: string) => api.delete<{ ok: true }>(`/workflows/${enc(id)}`),
  /** P3-10 publish: `body` names the version (empty = the current one) */
  activate: (id: string, body?: PublishBody) =>
    api.post<WorkflowDTO>(`/workflows/${enc(id)}/activate`, body ?? {}),
  deactivate: (id: string) => api.post<WorkflowDTO>(`/workflows/${enc(id)}/deactivate`),
  /** why the triggers of a published workflow are down, null when they are not */
  activationError: (id: string) => api.get<string | null>(`/active-workflows/error/${enc(id)}`),
  archive: (id: string) => api.post<WorkflowDTO>(`/workflows/${enc(id)}/archive`),
  unarchive: (id: string) => api.post<WorkflowDTO>(`/workflows/${enc(id)}/unarchive`),
  move: (body: MoveWorkflowsBody) => api.post<{ moved: string[] }>('/workflows/move', body),
  /** P3-13: the server fetches the URL; it travels in the body, never in the query string */
  importFromUrl: (url: string, projectId?: string) =>
    api.post<WorkflowImportData>('/workflows/from-url', projectId ? { url, projectId } : { url }),
  /** P3-16: newest first; take 1..100 (server default 20) */
  publishTimeline: (id: string, page: { skip?: number; take?: number } = {}) =>
    api.get<PublishTimelineEntry[]>(`/workflows/${enc(id)}/publish-timeline`, { ...page }),
  /** `runData` + `dirtyNodeNames`: a partial run (server runSchema) */
  run: (id: string, body: RunWorkflowBody) =>
    api.post<{ executionId: string }>(`/workflows/${enc(id)}/run`, body),
  /** P5-59: `destinationNode` makes the run stop there; a chat trigger's reply has `chatTestToken` */
  listenTestWebhook: (id: string, nodeName: string, options: ListenTestWebhookOptions = {}) =>
    api.post<ListenTestWebhookResult>(`/workflows/${enc(id)}/listen-test-webhook`, {
      nodeName,
      ...(options.destinationNode ? { destinationNode: options.destinationNode } : {}),
    }),
  stopListeningTestWebhook: (id: string, nodeName: string) =>
    request<{ ok: true }>({
      method: 'DELETE',
      path: `/workflows/${enc(id)}/listen-test-webhook`,
      body: { nodeName },
    }),
  /** P4-21: test-listen on a trigger without a URL */
  listenTestTrigger: (id: string, nodeName: string) =>
    api.post<ListenTestTriggerResult>(`/workflows/${enc(id)}/listen-test-trigger`, { nodeName }),
  stopTestTrigger: (id: string) => api.delete<{ ok: true }>(`/workflows/${enc(id)}/listen-test-trigger`),
  webhookUrls: (id: string) => api.get<WebhookUrlInfo[]>(`/workflows/${enc(id)}/webhook-urls`),
  versions: (id: string, query: { limit?: number; cursor?: string } = {}) =>
    api.list<VersionSummary>(`/workflows/${enc(id)}/versions`, { ...query }),
  version: (id: string, versionId: string) =>
    api.get<VersionSnapshot>(`/workflows/${enc(id)}/versions/${enc(versionId)}`),
  restoreVersion: (id: string, versionId: string) =>
    api.post<WorkflowDTO>(`/workflows/${enc(id)}/versions/${enc(versionId)}/restore`),
  /** P3-10: name or describe a version */
  updateVersion: (id: string, versionId: string, body: VersionPatchBody) =>
    api.patch<VersionSnapshot>(`/workflows/${enc(id)}/versions/${enc(versionId)}`, body),
  diffVersions: (id: string, versionId: string, against: DiffAgainst = 'current') =>
    api.get<VersionDiff>(`/workflows/${enc(id)}/versions/${enc(versionId)}/diff`, { against }),
};

export interface ExecutionListQuery {
  workflowId?: string;
  /** P6-25: executions of this project's workflows */
  projectId?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  /** P3-09: annotation tag ids, all must match (max 20) */
  annotationTags?: string[];
  vote?: AnnotationVote;
  /** P3-10 */
  workflowVersionId?: string;
  /** P5-61: executions whose highlighted data (custom data) has this key */
  customDataKey?: string;
  /** P5-61: with `customDataKey`, the value; partial match unless `customDataExact` */
  customDataValue?: string;
  customDataExact?: boolean;
}

export const executionsApi = {
  list: ({ annotationTags, ...query }: ExecutionListQuery = {}) =>
    api.list<ExecutionSummary>('/executions', {
      ...query,
      annotationTags: annotationTags?.length ? annotationTags.join(',') : undefined,
    }),
  get: (id: string) => api.get<ExecutionDetail>(`/executions/${enc(id)}`),
  retry: (id: string, useCurrentWorkflow: boolean) =>
    api.post<{ executionId: string }>(`/executions/${enc(id)}/retry`, { useCurrentWorkflow }),
  stop: (id: string) => api.post<{ status: string }>(`/executions/${enc(id)}/stop`),
  remove: (id: string) => api.delete<{ ok: true }>(`/executions/${enc(id)}`),
  /** P3-09: tags (annotation tag ids) and/or vote */
  annotate: (id: string, body: AnnotationPatchBody) =>
    api.patch<ExecutionAnnotation | null>(`/executions/${enc(id)}`, body),
};

/** P5-02, P5-11: test runs of one workflow; reads need viewer, the rest editor */
const testRunsPath = (workflowId: string) => `/workflows/${enc(workflowId)}/test-runs`;

export const evaluationsApi = {
  /** newest first */
  list: (workflowId: string, query: TestRunListQuery = {}) =>
    api.get<TestRunDto[]>(testRunsPath(workflowId), { ...query }),
  get: (workflowId: string, id: string) => api.get<TestRunDto>(`${testRunsPath(workflowId)}/${enc(id)}`),
  /** cases by run index */
  listCases: (workflowId: string, id: string, query: TestCaseListQuery = {}) =>
    api.get<TestCaseDto[]>(`${testRunsPath(workflowId)}/${enc(id)}/test-cases`, { ...query }),
  /** 202: the run goes on in the background */
  start: (workflowId: string, body: TestRunStartBody = {}) =>
    api.post<TestRunStartResult>(`${testRunsPath(workflowId)}/new`, body),
  /** 202; 409 when the run is not new or running */
  cancel: (workflowId: string, id: string) =>
    api.post<{ ok: true }>(`${testRunsPath(workflowId)}/${enc(id)}/cancel`),
  /** a pending case only, else 409 */
  cancelCase: (workflowId: string, id: string, caseId: string) =>
    api.post<{ ok: true }>(`${testRunsPath(workflowId)}/${enc(id)}/test-cases/${enc(caseId)}/cancel`),
  /** refused (409) while the run is running */
  remove: (workflowId: string, id: string) =>
    api.delete<{ ok: true }>(`${testRunsPath(workflowId)}/${enc(id)}`),
};

/** binary data of a run, as the server stores it (`id`), or inline (base64 `data`) */
export type BinaryRef = Pick<BinaryData, 'data' | 'id' | 'mimeType' | 'fileName'>;

/**
 * URL of GET /rest/binary-data for a stored binary (no secret in it: the session cookie carries
 * the auth). Inline binaries have no URL; use `fetchBinaryData`.
 */
export function binaryDataUrl(binary: BinaryRef, action: 'view' | 'download' = 'view'): string | null {
  if (!binary.id) return null;
  return buildUrl('/binary-data', {
    id: binary.id,
    action,
    mimeType: binary.mimeType,
    fileName: binary.fileName,
  }).toString();
}

/** The bytes of a binary as a Blob typed `type` (default: its mime type). */
export async function fetchBinaryData(
  binary: BinaryRef,
  options: { type?: string; signal?: AbortSignal } = {},
): Promise<Blob> {
  const type = options.type ?? binary.mimeType ?? 'application/octet-stream';
  if (!binary.id) {
    const raw = atob(binary.data ?? '');
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  const tenantId = getCurrentTenant();
  const response = await fetch(binaryDataUrl(binary, 'view')!, {
    credentials: 'same-origin',
    headers: tenantId ? { 'x-tenant-id': tenantId } : {},
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ApiError(response.status, `http_${response.status}`, 'Could not load the binary data');
  }
  const blob = await response.blob();
  return blob.type === type ? blob : new Blob([await blob.arrayBuffer()], { type });
}

export const foldersApi = {
  list: ({ tags, ...query }: FolderListQuery = {}) =>
    api.list<Folder>('/folders', { ...query, tags: tags?.length ? tags.join(',') : undefined }),
  get: (id: string) => api.get<FolderDetail>(`/folders/${enc(id)}`),
  create: (body: FolderCreateBody) => api.post<Folder>('/folders', body),
  update: (id: string, body: FolderUpdateBody) => api.patch<Folder>(`/folders/${enc(id)}`, body),
  /**
   * Omitted `transferToFolderId`: the folder's workflows go to the root and are archived, then the
   * folders are deleted. A folder id or 'root': folders and workflows move there.
   */
  remove: (id: string, transferToFolderId?: string | 'root') =>
    request<{ ok: true }>({
      method: 'DELETE',
      path: `/folders/${enc(id)}`,
      body: transferToFolderId ? { transferToFolderId } : {},
    }),
};

export const favoritesApi = {
  list: () => api.get<Favorite[]>('/favorites'),
  add: (resourceType: FavoriteResourceType, resourceId: string) =>
    api.post<Favorite>('/favorites', { resourceType, resourceId }),
  remove: (resourceType: FavoriteResourceType, resourceId: string) =>
    api.delete<{ ok: true }>(`/favorites/${enc(resourceType)}/${enc(resourceId)}`),
};

export const annotationTagsApi = {
  list: (query: { withUsageCount?: boolean } = {}) =>
    api.get<AnnotationTag[]>('/annotation-tags', { withUsageCount: query.withUsageCount || undefined }),
  create: (name: string) => api.post<AnnotationTag>('/annotation-tags', { name }),
  update: (id: string, name: string) => api.patch<AnnotationTag>(`/annotation-tags/${enc(id)}`, { name }),
  remove: (id: string) => api.delete<{ ok: true }>(`/annotation-tags/${enc(id)}`),
};

export const reviewsApi = {
  list: (query: ReviewListQuery = {}) => api.list<WorkflowReviewDTO>('/workflow-reviews', { ...query }),
  /** tenant members who can publish (editor and up), without the caller */
  eligibleReviewers: (workflowId: string) =>
    api.get<ReviewUser[]>('/workflow-reviews/eligible-reviewers', { workflowId }),
  create: (body: ReviewCreateBody) => api.post<WorkflowReviewDTO>('/workflow-reviews', body),
  updateVersion: (id: string, body: ReviewUpdateVersionBody) =>
    api.post<WorkflowReviewDTO>(`/workflow-reviews/${enc(id)}/update-version`, body),
  decide: (id: string, body: ReviewDecisionBody) =>
    api.post<ReviewDecisionResult>(`/workflow-reviews/${enc(id)}/decision`, body),
  /** newest first, 25 per page */
  activity: (id: string, cursor?: string) =>
    api.list<ReviewActivity>(`/workflow-reviews/${enc(id)}/activity`, { cursor }),
  comment: (id: string, body: string) =>
    api.post<ReviewActivity>(`/workflow-reviews/${enc(id)}/comments`, { body }),
  get: (id: string) => api.get<WorkflowReviewDTO>(`/workflow-reviews/${enc(id)}`),
};

export const inboxApi = {
  list: (query: InboxQuery = {}) => api.list<WorkflowReviewDTO>('/inbox', { ...query }),
  summary: () => api.get<InboxSummary>('/inbox/summary'),
};

export const credentialsApi = {
  /** P6-24: `query` filters by project (`projectId`, `onlySharedWithMe`) and adds the caller's `scopes` */
  list: (type?: string, query: Omit<CredentialListQuery, 'type'> = {}) =>
    api.get<CredentialSummary[]>('/credentials', { type, ...query }),
  get: (id: string) => api.get<CredentialDetail>(`/credentials/${enc(id)}`),
  create: (body: CredentialCreateBody) =>
    api.post<{ id: string; name: string; type: string }>('/credentials', body),
  update: (id: string, body: CredentialPatchBody) =>
    api.patch<{ id: string; name: string; type: string }>(`/credentials/${enc(id)}`, body),
  remove: (id: string) => api.delete<{ ok: true }>(`/credentials/${enc(id)}`),
  test: (body: CredentialTestBody) => api.post<CredentialTestResult>('/credentials/test', body),
  oauth1Authorize: (credentialId: string) => api.get<{ url: string }>('/oauth1/authorize', { credentialId }),
  oauth2Authorize: (credentialId: string) => api.get<{ url: string }>('/oauth2/authorize', { credentialId }),
};

export const tagsApi = {
  list: () => api.get<Tag[]>('/tags'),
  create: (name: string) => api.post<Tag>('/tags', { name }),
  update: (id: string, name: string) => api.patch<Tag>(`/tags/${enc(id)}`, { name }),
  remove: (id: string) => api.delete<{ ok: true }>(`/tags/${enc(id)}`),
};

export const variablesApi = {
  /** P6-31: the globals plus the variables of the projects the caller can read */
  list: () => api.get<Variable[]>('/variables'),
  /** P6-31: one project's variables */
  forProject: (projectId: string) => api.get<Variable[]>('/variables', { projectId }),
  /** with `projectId` a project variable */
  create: (body: VariableBody) => api.post<Variable>('/variables', body),
  update: (id: string, body: VariableBody) => api.patch<Variable>(`/variables/${enc(id)}`, body),
  remove: (id: string) => api.delete<{ ok: true }>(`/variables/${enc(id)}`),
};

export const membersApi = {
  list: () => api.get<Member[]>('/members'),
  invite: (body: { email: string; role: Role }) =>
    api.post<Record<string, unknown> | null>('/members/invite', body),
  updateRole: (userId: string, role: Role) => api.patch<Member>(`/members/${enc(userId)}`, { role }),
  /** P6-31: the server needs `choice`: move the member's personal work to a project, or delete it */
  remove: (userId: string, choice?: MemberRemovalChoice) =>
    request<{ ok: true }>({ method: 'DELETE', path: `/members/${enc(userId)}`, body: choice ?? {} }),
};

export const apiKeysApi = {
  list: () => api.get<ApiKey[]>('/api-keys'),
  /** P4-18: empty `scopes` means every scope */
  create: (name: string, scopes: string[] = []) => api.post<CreatedApiKey>('/api-keys', { name, scopes }),
  remove: (id: string) => api.delete<{ ok: true }>(`/api-keys/${enc(id)}`),
};

/** `?sortBy=` of the data table routes */
const sortParam = (sort?: { column: string; direction: DataTableSortDirection }) =>
  sort ? `${sort.column}:${sort.direction}` : undefined;

/** P4-03: offset paging, because the grid shows page numbers */
export const dataTablesApi = {
  /** P6-23: `projectId`, `onlySharedWithMe` and `includeScopes` travel as their own query params */
  list: (query: DataTableListQuery & ProjectListFilter = {}) =>
    api.get<DataTablePage<DataTableInfo>>('/data-tables', {
      skip: query.skip,
      take: query.take,
      filter: query.name ? JSON.stringify({ name: query.name }) : undefined,
      sortBy: sortParam(query.sortBy),
      projectId: query.projectId,
      onlySharedWithMe: query.onlySharedWithMe,
      includeScopes: query.includeScopes,
    }),
  limits: () => api.get<DataTableLimits>('/data-tables/limits'),
  get: (id: string) => api.get<DataTableInfo>(`/data-tables/${enc(id)}`),
  create: (body: DataTableCreateBody) => api.post<DataTableInfo>('/data-tables', body),
  rename: (id: string, name: string) => api.patch<DataTableInfo>(`/data-tables/${enc(id)}`, { name }),
  remove: (id: string) => api.delete<{ ok: true }>(`/data-tables/${enc(id)}`),
  dependencies: (id: string) => api.get<DataTableDependency[]>(`/data-tables/${enc(id)}/dependencies`),
  columns: (id: string) => api.get<DataTableColumn[]>(`/data-tables/${enc(id)}/columns`),
  addColumn: (id: string, body: DataTableColumnCreateBody) =>
    api.post<DataTableColumn>(`/data-tables/${enc(id)}/columns`, body),
  removeColumn: (id: string, columnId: string) =>
    api.delete<{ ok: true }>(`/data-tables/${enc(id)}/columns/${enc(columnId)}`),
  moveColumn: (id: string, columnId: string, targetIndex: number) =>
    api.patch<DataTableColumn>(`/data-tables/${enc(id)}/columns/${enc(columnId)}/move`, { targetIndex }),
  renameColumn: (id: string, columnId: string, name: string) =>
    api.patch<DataTableColumn>(`/data-tables/${enc(id)}/columns/${enc(columnId)}/rename`, { name }),
  rows: (id: string, query: DataTableRowsQuery = {}) =>
    api.get<DataTablePage<DataTableRow>>(`/data-tables/${enc(id)}/rows`, {
      skip: query.skip,
      take: query.take,
      filter: query.filter ? JSON.stringify(query.filter) : undefined,
      sortBy: sortParam(query.sortBy),
      search: query.search,
    }),
  insertRows: <T extends DataTableInsertReturnType>(id: string, rows: DataTableRowInput[], returnType: T) =>
    api.post<DataTableInsertResult<T>>(`/data-tables/${enc(id)}/insert`, { data: rows, returnType }),
  upsertRow: (id: string, change: DataTableChange, options: DataTableWriteOptions = {}) =>
    api.post<DataTableRowResult[] | true>(`/data-tables/${enc(id)}/upsert`, { ...change, ...options }),
  updateRows: (id: string, change: DataTableChange, options: DataTableWriteOptions = {}) =>
    api.patch<DataTableRowResult[] | true>(`/data-tables/${enc(id)}/rows`, { ...change, ...options }),
  deleteRows: (id: string, filter: DataTableFilter, options: DataTableWriteOptions = {}) =>
    request<DataTableRowResult[] | true>({
      method: 'DELETE',
      path: `/data-tables/${enc(id)}/rows`,
      query: { filter: JSON.stringify(filter), dryRun: options.dryRun, returnData: options.returnData },
    }),
  clearRows: (id: string) => api.delete<{ deletedCount: number }>(`/data-tables/${enc(id)}/rows/clear`),
  downloadCsv: (id: string, includeSystemColumns = true) =>
    api.get<DataTableCsvDownload>(`/data-tables/${enc(id)}/download-csv`, { includeSystemColumns }),
  /** the CSV travels as text in the body; the server keeps no temp file */
  csvPreview: (csv: string, hasHeaders: boolean, projectId?: string) =>
    api.post<DataTableCsvPreview>(
      '/data-tables/csv/preview',
      projectId ? { csv, hasHeaders, projectId } : { csv, hasHeaders },
    ),
  importCsv: (id: string, csv: string) =>
    api.post<DataTableCsvImportResult>(`/data-tables/${enc(id)}/import-csv`, { csv }),
};

const projectVaultPath = (projectId: string) => `/secret-providers/projects/${enc(projectId)}/connections`;

/** P4-07: admin and owner manage connections; an editor reads secret names through `completions` */
export const secretsApi = {
  types: () => api.get<SecretProviderTypeInfo[]>('/secret-providers/types'),
  type: (type: string) => api.get<SecretProviderTypeInfo>(`/secret-providers/types/${enc(type)}`),
  completions: () => api.get<SecretCompletions>('/secret-providers/completions/secrets'),
  connections: () => api.get<SecretConnection[]>('/secret-providers/connections'),
  connection: (providerKey: string) =>
    api.get<SecretConnection>(`/secret-providers/connections/${enc(providerKey)}`),
  createConnection: (body: SecretConnectionCreateBody) =>
    api.post<SecretConnection>('/secret-providers/connections', body),
  updateConnection: (providerKey: string, body: SecretConnectionPatchBody) =>
    api.patch<SecretConnection>(`/secret-providers/connections/${enc(providerKey)}`, body),
  removeConnection: (providerKey: string) =>
    api.delete<{ ok: true }>(`/secret-providers/connections/${enc(providerKey)}`),
  testConnection: (providerKey: string) =>
    api.post<SecretConnectionTestResult>(`/secret-providers/connections/${enc(providerKey)}/test`),
  reloadConnection: (providerKey: string) =>
    api.post<{ success: boolean }>(`/secret-providers/connections/${enc(providerKey)}/reload`),
  /** P6-28: a project's own vaults (`externalSecretsProvider:*` in that project) */
  projectConnections: (projectId: string) => api.get<SecretConnection[]>(projectVaultPath(projectId)),
  projectConnection: (projectId: string, providerKey: string) =>
    api.get<SecretConnection>(`${projectVaultPath(projectId)}/${enc(providerKey)}`),
  createProjectConnection: (projectId: string, body: SecretConnectionCreateBody) =>
    api.post<SecretConnection>(projectVaultPath(projectId), body),
  updateProjectConnection: (projectId: string, providerKey: string, body: SecretConnectionPatchBody) =>
    api.patch<SecretConnection>(`${projectVaultPath(projectId)}/${enc(providerKey)}`, body),
  removeProjectConnection: (projectId: string, providerKey: string) =>
    api.delete<{ ok: true }>(`${projectVaultPath(projectId)}/${enc(providerKey)}`),
  testProjectConnection: (projectId: string, providerKey: string) =>
    api.post<SecretConnectionTestResult>(`${projectVaultPath(projectId)}/${enc(providerKey)}/test`),
  /** P6-28: the secret names a project may read (its own vaults and the shared ones), for `$secrets` */
  projectCompletions: (projectId: string) =>
    api.get<SecretCompletions>(`/secret-providers/completions/secrets/project/${enc(projectId)}`),
};

/**
 * P6-03: projects. GET `/projects` answers a bare array, or `{ count, data }` when `take` or `skip` is given
 * (`page`). Members: `addUsers` answers 201 with `conflicts` when some were already in, 409 when none was added.
 */
export const projectsApi = {
  list: () => api.get<Project[]>('/projects'),
  page: (query: ProjectListQuery) => api.get<ProjectPage>('/projects', { ...query }),
  count: () => api.get<ProjectCount>('/projects/count'),
  /** `user:list`: the projects a resource can be shared with, peers' personal projects included */
  sharingCandidates: () => api.get<ProjectRef[]>('/projects/sharing-candidates'),
  /** the caller's projects, each with the caller's `role` and `scopes` */
  myProjects: () => api.get<Project[]>('/projects/my-projects'),
  personal: () => api.get<ProjectDetail>('/projects/personal'),
  get: (id: string) => api.get<ProjectDetail>(`/projects/${enc(id)}`),
  /** `project:create`; the caller becomes `project:admin` */
  create: (body: ProjectCreateBody) => api.post<ProjectDetail>('/projects', body),
  update: (id: string, body: ProjectPatchBody) => api.patch<ProjectDetail>(`/projects/${enc(id)}`, body),
  addUsers: (id: string, relations: ProjectRelationInput[]) =>
    api.post<ProjectAddUsersResult | null>(`/projects/${enc(id)}/users`, { relations }),
  changeUserRole: (id: string, userId: string, role: string) =>
    api.patch<{ ok: true } | null>(`/projects/${enc(id)}/users/${enc(userId)}`, { role }),
  removeUser: (id: string, userId: string) =>
    api.delete<{ ok: true } | null>(`/projects/${enc(id)}/users/${enc(userId)}`),
  /** a team project only; with `transferId` its workflows, credentials, data tables and folders move there, else they are deleted */
  remove: (id: string, transferId?: string) =>
    request<{ ok: true } | null>({ method: 'DELETE', path: `/projects/${enc(id)}`, query: { transferId } }),
};

/** P6-32: roles. System roles live in code; custom ones per workspace (`role:manage`, `role:manageProject`) */
export const rolesApi = {
  list: () => api.get<RolesMap>('/roles', { withUsageCount: true }),
  get: (slug: string) => api.get<CustomRole>(`/roles/${enc(slug)}`, { withUsageCount: true }),
  create: (body: RoleCreateBody) => api.post<CustomRole>('/roles', body),
  update: (slug: string, body: RolePatchBody) => api.patch<CustomRole>(`/roles/${enc(slug)}`, body),
  /** a role in use is refused unless `reassignRoleSlug` (global roles only) */
  remove: (slug: string, reassignRoleSlug?: string) =>
    request<CustomRole | null>({
      method: 'DELETE',
      path: `/roles/${enc(slug)}`,
      query: { reassignRoleSlug },
    }),
  assignments: (slug: string) => api.get<RoleAssignmentsPage>(`/roles/${enc(slug)}/assignments`),
  projectMembers: (slug: string, projectId: string) =>
    api.get<RoleMembersPage>(`/roles/${enc(slug)}/assignments/${enc(projectId)}/members`),
  members: (slug: string) => api.get<RoleMembersPage>(`/roles/${enc(slug)}/members`),
};

/** P6-29: `shareWithIds` is the full list of project ids; `:share` adds, `:unshare` removes */
export const sharingApi = {
  shareWorkflow: (id: string, shareWithIds: string[]) =>
    request<{ ok: true } | null>({
      method: 'PUT',
      path: `/workflows/${enc(id)}/share`,
      body: { shareWithIds },
    }),
  shareCredential: (id: string, shareWithIds: string[]) =>
    request<{ ok: true } | null>({
      method: 'PUT',
      path: `/credentials/${enc(id)}/share`,
      body: { shareWithIds },
    }),
};

/** P6-30: move a workflow, credential or folder (its whole tree) to another project; previews are advisory */
export const transferApi = {
  previewWorkflow: (id: string, destinationProjectId: string) =>
    api.get<TransferPreview>(`/workflows/${enc(id)}/transfer-preview`, { destinationProjectId }),
  previewCredential: (id: string, destinationProjectId: string) =>
    api.get<TransferPreview>(`/credentials/${enc(id)}/transfer-preview`, { destinationProjectId }),
  previewFolder: (id: string, destinationProjectId: string) =>
    api.get<TransferPreview>(`/folders/${enc(id)}/transfer-preview`, { destinationProjectId }),
  transferWorkflow: (id: string, body: WorkflowTransferBody) =>
    request<{ ok: true } | null>({ method: 'PUT', path: `/workflows/${enc(id)}/transfer`, body }),
  transferCredential: (id: string, body: CredentialTransferBody) =>
    request<{ ok: true } | null>({ method: 'PUT', path: `/credentials/${enc(id)}/transfer`, body }),
  transferFolder: (id: string, body: FolderTransferBody) =>
    request<{ ok: true } | null>({ method: 'PUT', path: `/folders/${enc(id)}/transfer`, body }),
};

/** P6-33: the personal space policy (`securitySettings:manage`); turning a flag off undoes nothing */
export const securityApi = {
  get: () => api.get<SecurityPolicy>('/settings/security'),
  update: (body: SecurityPolicyPatch) => api.post<SecurityPolicy>('/settings/security', body),
};

export const formAuthApi = {
  /** P4-16: `returnTo` is the form to go back to; the session cookie names the user */
  issueCode: (returnTo: string) => api.post<FormAuthCode>('/form-auth/code', { returnTo }),
};

/**
 * P5-09, P5-66: the AI builder's chat history (the turn itself streams through api/ai-stream.ts).
 * Every call is for the signed-in user on one workflow; editor role or above.
 */
export const aiApi = {
  sessions: (workflowId: string) => api.post<AiSessionDTO>('/ai/sessions', { workflowId }),
  /** removes `messageId` and every later message */
  truncate: (workflowId: string, messageId: string) =>
    api.post<{ ok: true }>('/ai/build/truncate-messages', { workflowId, messageId }),
  clear: (workflowId: string) => api.post<{ ok: true }>('/ai/build/clear-session', { workflowId }),
  /** the version Accept saved; tags the last message with it */
  acceptedVersion: (workflowId: string, versionId: string) =>
    api.post<{ ok: true }>('/ai/build/accepted-version', { workflowId, versionId }),
  /** admin */
  usageSettings: (body: AiUsageSettingsBody) => api.post<AiUsageSettingsBody>('/ai/usage-settings', body),
};

/** P5-04, P5-14, P5-15: the workspace's MCP server settings, the caller's MCP key and the OAuth clients */
export const mcpApi = {
  settings: () => api.get<McpSettings>('/mcp/settings'),
  /** admin */
  patchSettings: (body: McpSettingsPatchBody) => api.patch<McpSettings>('/mcp/settings', body),
  /** the caller's own key; the whole key only when just created */
  apiKey: () => api.get<McpApiKey>('/mcp/api-key'),
  rotateApiKey: () => api.post<McpApiKey>('/mcp/api-key/rotate'),
  /** editor or above: the workflows the caller can edit */
  workflows: (query: McpWorkflowsQuery = {}) =>
    api.get<McpWorkflowSummary[]>('/mcp/workflows', { search: query.search, folderId: query.folderId }),
  /** admin */
  toggleAccess: (body: McpToggleAccessBody) =>
    api.patch<McpToggleAccessResult>('/mcp/workflows/toggle-access', body),
  /** admin */
  redirectUris: () => api.get<McpRedirectUris>('/mcp/oauth/allowed-redirect-uris'),
  /** admin */
  patchRedirectUris: (allowedRedirectUris: string[]) =>
    api.patch<McpRedirectUris>('/mcp/oauth/allowed-redirect-uris', { allowedRedirectUris }),
  /** admin */
  clients: () => api.get<McpOAuthClient[]>('/mcp/oauth-clients'),
  /** admin: revokes the client's tokens too */
  deleteClient: (clientId: string) => api.delete<{ ok: true }>(`/mcp/oauth-clients/${enc(clientId)}`),
  /** admin */
  stats: () => api.get<McpInstanceStats>('/mcp/instance-stats'),
};

/**
 * P5-67..74: the Assistant. Threads, messages and status are the caller's own (every role); the turn's events
 * stream through api/assistant-stream.ts. Settings and MCP connection writes are admin only.
 */
export const assistantApi = {
  threads: (query: AssistantThreadsQuery = {}) =>
    api.get<AssistantThreadPage>('/assistant/threads', { limit: query.limit, cursor: query.cursor }),
  createThread: (body: { title?: string } = {}) => api.post<AssistantThreadDTO>('/assistant/threads', body),
  renameThread: (threadId: string, title: string) =>
    api.patch<AssistantThreadDTO>(`/assistant/threads/${enc(threadId)}`, { title }),
  deleteThread: (threadId: string) => api.delete<{ ok: true }>(`/assistant/threads/${enc(threadId)}`),
  messages: (threadId: string) =>
    api.get<AssistantMessagesPage>(`/assistant/threads/${enc(threadId)}/messages`),
  status: (threadId: string) => api.get<AssistantStatusDTO>(`/assistant/threads/${enc(threadId)}/status`),
  /** starts a turn; its events come through the stream */
  chat: (threadId: string, body: AssistantSendMessage) =>
    api.post<{ runId: string }>(`/assistant/chat/${enc(threadId)}`, body),
  cancel: (threadId: string) => api.post<{ ok: true }>(`/assistant/chat/${enc(threadId)}/cancel`),
  /** a person's answer to a card */
  confirm: (requestId: string, answer: AssistantConfirmAnswer) =>
    api.post<{ ok: true }>(`/assistant/confirm/${enc(requestId)}`, answer),
  /** admin */
  settings: () => api.get<AssistantSettingsDTO>('/assistant/settings'),
  /** admin */
  patchSettings: (body: AssistantSettingsPatchBody) =>
    api.patch<AssistantSettingsDTO>('/assistant/settings', body),
  mcpConnections: () => api.get<AssistantMcpConnectionDTO[]>('/assistant/mcp-connections'),
  /** admin */
  createMcpConnection: (body: AssistantMcpConnectionBody) =>
    api.post<AssistantMcpConnectionDTO>('/assistant/mcp-connections', body),
  /** admin */
  patchMcpConnection: (id: string, body: AssistantMcpConnectionPatchBody) =>
    api.patch<AssistantMcpConnectionDTO>(`/assistant/mcp-connections/${enc(id)}`, body),
  /** admin */
  deleteMcpConnection: (id: string) => api.delete<{ ok: true }>(`/assistant/mcp-connections/${enc(id)}`),
  draft: (threadId: string, draftId: string) =>
    api.get<AssistantDraftView>(`/assistant/threads/${enc(threadId)}/drafts/${enc(draftId)}`),
  /** editor; a person only (no tool calls it) */
  acceptDraft: (threadId: string, draftId: string, body: AssistantAcceptDraftBody = {}) =>
    api.post<AssistantAcceptDraftResult>(
      `/assistant/threads/${enc(threadId)}/drafts/${enc(draftId)}/accept`,
      body,
    ),
  /** editor */
  discardDraft: (threadId: string, draftId: string) =>
    api.post<{ ok: true }>(`/assistant/threads/${enc(threadId)}/drafts/${enc(draftId)}/discard`),
};

/** P5-14: the OAuth consent page (`/oauth/consent?flow=...`); `flow` is the signed flow token */
export const consentApi = {
  details: (flow: string) => api.get<McpConsentDetails>('/consent/details', { flow }),
  approve: (body: McpConsentDecisionBody) => api.post<McpConsentResult>('/consent/approve', body),
};
