/** One typed function per REST endpoint of the contract. */
import type {
  BinaryData,
  DataTableChange,
  DataTableColumn,
  DataTableFilter,
  DataTableInfo,
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
  AuthResult,
  CreatedApiKey,
  CredentialDetail,
  CredentialSummary,
  CredentialTestResult,
  CredentialTypeDescription,
  DataTableColumnCreateBody,
  DataTableCreateBody,
  DataTableCsvDownload,
  DataTableCsvImportResult,
  DataTableCsvPreview,
  DataTableDependency,
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
  MoveWorkflowsBody,
  NodeTypeDescription,
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
  RunWorkflowBody,
  SecretCompletions,
  SecretConnection,
  SecretConnectionCreateBody,
  SecretConnectionPatchBody,
  SecretConnectionTestResult,
  SecretProviderTypeInfo,
  Settings,
  SettingsPatchBody,
  Tag,
  TestCaseDto,
  TestCaseListQuery,
  TestRunDto,
  TestRunListQuery,
  TestRunStartBody,
  TestRunStartResult,
  Variable,
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

export interface WorkflowListQuery {
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
  importFromUrl: (url: string) => api.post<WorkflowImportData>('/workflows/from-url', { url }),
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
  list: (type?: string) => api.get<CredentialSummary[]>('/credentials', { type }),
  get: (id: string) => api.get<CredentialDetail>(`/credentials/${enc(id)}`),
  create: (body: { name: string; type: string; data: Record<string, unknown> }) =>
    api.post<{ id: string; name: string; type: string }>('/credentials', body),
  update: (id: string, body: { name?: string; data?: Record<string, unknown> }) =>
    api.patch<{ id: string; name: string; type: string }>(`/credentials/${enc(id)}`, body),
  remove: (id: string) => api.delete<{ ok: true }>(`/credentials/${enc(id)}`),
  test: (body: { type: string; data: Record<string, unknown>; id?: string }) =>
    api.post<CredentialTestResult>('/credentials/test', body),
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
  list: () => api.get<Variable[]>('/variables'),
  create: (body: { key: string; value: string }) => api.post<Variable>('/variables', body),
  update: (id: string, body: { key: string; value: string }) =>
    api.patch<Variable>(`/variables/${enc(id)}`, body),
  remove: (id: string) => api.delete<{ ok: true }>(`/variables/${enc(id)}`),
};

export const membersApi = {
  list: () => api.get<Member[]>('/members'),
  invite: (body: { email: string; role: Role }) =>
    api.post<Record<string, unknown> | null>('/members/invite', body),
  updateRole: (userId: string, role: Role) => api.patch<Member>(`/members/${enc(userId)}`, { role }),
  remove: (userId: string) => api.delete<{ ok: true }>(`/members/${enc(userId)}`),
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
  list: (query: DataTableListQuery = {}) =>
    api.get<DataTablePage<DataTableInfo>>('/data-tables', {
      skip: query.skip,
      take: query.take,
      filter: query.name ? JSON.stringify({ name: query.name }) : undefined,
      sortBy: sortParam(query.sortBy),
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
  csvPreview: (csv: string, hasHeaders: boolean) =>
    api.post<DataTableCsvPreview>('/data-tables/csv/preview', { csv, hasHeaders }),
  importCsv: (id: string, csv: string) =>
    api.post<DataTableCsvImportResult>(`/data-tables/${enc(id)}/import-csv`, { csv }),
};

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

/** P5-14: the OAuth consent page (`/oauth/consent?flow=...`); `flow` is the signed flow token */
export const consentApi = {
  details: (flow: string) => api.get<McpConsentDetails>('/consent/details', { flow }),
  approve: (body: McpConsentDecisionBody) => api.post<McpConsentResult>('/consent/approve', body),
};
