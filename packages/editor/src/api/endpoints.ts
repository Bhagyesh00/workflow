/** One typed function per REST endpoint of the contract. */
import type { ListSearchResult, NodePropertyOption, RunData, WorkflowNode } from '@workflow/workflow';
import { api, request } from './client';
import type {
  ApiKey,
  AuthResult,
  CreatedApiKey,
  CredentialDetail,
  CredentialSummary,
  CredentialTestResult,
  CredentialTypeDescription,
  ExecutionDetail,
  ExecutionSummary,
  Me,
  Member,
  NodeTypeDescription,
  Role,
  RunWorkflowBody,
  Settings,
  Tag,
  Variable,
  VersionSnapshot,
  VersionSummary,
  WebhookUrlInfo,
  WorkflowCreateBody,
  WorkflowDTO,
  WorkflowPatchBody,
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
};

export interface LoadOptionsBody {
  nodeType: string;
  method: string;
  kind: 'loadOptions' | 'listSearch';
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
};

export interface WorkflowListQuery {
  search?: string;
  tagId?: string;
  active?: boolean;
  limit?: number;
  cursor?: string;
}

export const workflowsApi = {
  list: (query: WorkflowListQuery = {}) => api.list<WorkflowSummary>('/workflows', { ...query }),
  get: (id: string) => api.get<WorkflowDTO>(`/workflows/${enc(id)}`),
  create: (body: WorkflowCreateBody) => api.post<WorkflowDTO>('/workflows', body),
  update: (id: string, body: WorkflowPatchBody) => api.patch<WorkflowDTO>(`/workflows/${enc(id)}`, body),
  remove: (id: string) => api.delete<{ ok: true }>(`/workflows/${enc(id)}`),
  activate: (id: string) => api.post<WorkflowDTO>(`/workflows/${enc(id)}/activate`),
  deactivate: (id: string) => api.post<WorkflowDTO>(`/workflows/${enc(id)}/deactivate`),
  /** `runData`: a partial run's last run data (server runSchema) */
  run: (id: string, body: RunWorkflowBody & { runData?: RunData }) =>
    api.post<{ executionId: string }>(`/workflows/${enc(id)}/run`, body),
  listenTestWebhook: (id: string, nodeName: string) =>
    api.post<{ testUrl: string; expiresAt: string }>(`/workflows/${enc(id)}/listen-test-webhook`, {
      nodeName,
    }),
  stopListeningTestWebhook: (id: string, nodeName: string) =>
    request<{ ok: true }>({
      method: 'DELETE',
      path: `/workflows/${enc(id)}/listen-test-webhook`,
      body: { nodeName },
    }),
  webhookUrls: (id: string) => api.get<WebhookUrlInfo[]>(`/workflows/${enc(id)}/webhook-urls`),
  versions: (id: string, query: { limit?: number; cursor?: string } = {}) =>
    api.list<VersionSummary>(`/workflows/${enc(id)}/versions`, { ...query }),
  version: (id: string, versionId: string) =>
    api.get<VersionSnapshot>(`/workflows/${enc(id)}/versions/${enc(versionId)}`),
  restoreVersion: (id: string, versionId: string) =>
    api.post<WorkflowDTO>(`/workflows/${enc(id)}/versions/${enc(versionId)}/restore`),
};

export interface ExecutionListQuery {
  workflowId?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

export const executionsApi = {
  list: (query: ExecutionListQuery = {}) => api.list<ExecutionSummary>('/executions', { ...query }),
  get: (id: string) => api.get<ExecutionDetail>(`/executions/${enc(id)}`),
  retry: (id: string, useCurrentWorkflow: boolean) =>
    api.post<{ executionId: string }>(`/executions/${enc(id)}/retry`, { useCurrentWorkflow }),
  stop: (id: string) => api.post<{ status: string }>(`/executions/${enc(id)}/stop`),
  remove: (id: string) => api.delete<{ ok: true }>(`/executions/${enc(id)}`),
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
  create: (name: string) => api.post<CreatedApiKey>('/api-keys', { name }),
  remove: (id: string) => api.delete<{ ok: true }>(`/api-keys/${enc(id)}`),
};
