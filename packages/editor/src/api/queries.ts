/** TanStack Query hooks for server data shared across pages. */
import { QueryClient, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isApiError, setCurrentTenant } from './client';
import {
  annotationTagsApi,
  authApi,
  credentialsApi,
  favoritesApi,
  foldersApi,
  inboxApi,
  nodeTypesApi,
  settingsApi,
  tagsApi,
  variablesApi,
  workflowsApi,
} from './endpoints';
import type {
  AiBuilderFeature,
  AssistantFeature,
  CredentialTypeDescription,
  NodeTypeDescription,
  Settings,
} from './types';

export const queryKeys = {
  me: ['me'] as const,
  settings: ['settings'] as const,
  nodeTypes: ['node-types'] as const,
  credentialTypes: ['credential-types'] as const,
  workflows: (query: object = {}) => ['workflows', query] as const,
  workflow: (id: string) => ['workflow', id] as const,
  versions: (id: string) => ['workflow', id, 'versions'] as const,
  webhookUrls: (id: string) => ['workflow', id, 'webhook-urls'] as const,
  executions: (query: object = {}) => ['executions', query] as const,
  execution: (id: string) => ['execution', id] as const,
  credentials: (type?: string) => ['credentials', type ?? 'all'] as const,
  credential: (id: string) => ['credential', id] as const,
  tags: ['tags'] as const,
  variables: ['variables'] as const,
  members: ['members'] as const,
  apiKeys: ['api-keys'] as const,
  folders: (query: object = {}) => ['folders', query] as const,
  folder: (id: string) => ['folder', id] as const,
  favorites: ['favorites'] as const,
  annotationTags: (withUsageCount = false) => ['annotation-tags', { withUsageCount }] as const,
  publishTimeline: (id: string) => ['workflow', id, 'publish-timeline'] as const,
  reviews: (query: object = {}) => ['workflow-reviews', query] as const,
  inbox: (query: object = {}) => ['inbox', query] as const,
  inboxSummary: ['inbox', 'summary'] as const,
  dataTables: (query: object = {}) => ['data-tables', query] as const,
  dataTable: (id: string) => ['data-table', id] as const,
  dataTableColumns: (id: string) => ['data-table', id, 'columns'] as const,
  dataTableRows: (id: string, query: object = {}) => ['data-table', id, 'rows', query] as const,
  dataTableDependencies: (id: string) => ['data-table', id, 'dependencies'] as const,
  dataTableLimits: ['data-tables-limits'] as const,
  secretProviderTypes: ['secret-providers', 'types'] as const,
  secretConnections: ['secret-providers', 'connections'] as const,
  secretConnection: (providerKey: string) => ['secret-providers', 'connections', providerKey] as const,
  secretCompletions: ['secret-providers', 'completions'] as const,
  /** P5-11: invalidating `testRuns` also refreshes every run and its cases (prefix match) */
  testRuns: (workflowId: string) => ['workflow', workflowId, 'test-runs'] as const,
  testRun: (workflowId: string, id: string) => ['workflow', workflowId, 'test-runs', id] as const,
  testRunCases: (workflowId: string, id: string) =>
    ['workflow', workflowId, 'test-runs', id, 'cases'] as const,
  /** P5-66: this user's builder chat on one workflow */
  aiSession: (workflowId: string) => ['workflow', workflowId, 'ai-session'] as const,
  /** P5-04, P5-14, P5-15: invalidating `mcp` refreshes every MCP query (prefix match) */
  mcp: ['mcp'] as const,
  mcpSettings: ['mcp', 'settings'] as const,
  mcpApiKey: ['mcp', 'api-key'] as const,
  mcpWorkflows: (query: object = {}) => ['mcp', 'workflows', query] as const,
  mcpRedirectUris: ['mcp', 'redirect-uris'] as const,
  mcpClients: ['mcp', 'oauth-clients'] as const,
  mcpStats: ['mcp', 'instance-stats'] as const,
  consentDetails: (flow: string) => ['oauth-consent', flow] as const,
  /** P5-67..74: invalidating `assistant` refreshes every Assistant query (prefix match) */
  assistant: ['assistant'] as const,
  assistantThreads: (query: object = {}) => ['assistant', 'threads', query] as const,
  assistantMessages: (threadId: string) => ['assistant', 'thread', threadId, 'messages'] as const,
  assistantStatus: (threadId: string) => ['assistant', 'thread', threadId, 'status'] as const,
  assistantDraft: (threadId: string, draftId: string) =>
    ['assistant', 'thread', threadId, 'drafts', draftId] as const,
  assistantSettings: ['assistant', 'settings'] as const,
  assistantMcpConnections: ['assistant', 'mcp-connections'] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // auth/permission/not-found errors are final; only retry transient failures
        retry: (count, error) =>
          count < 2 && !(isApiError(error) && error.status >= 400 && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}

export const DEFAULT_SETTINGS: Settings = {
  brand: { name: 'Workflow', logoUrl: null, primaryColor: null },
  baseUrl: typeof window === 'undefined' ? '' : window.location.origin,
  webhookBaseUrl: typeof window === 'undefined' ? '' : window.location.origin,
  timezone: 'UTC',
  limits: {},
  features: {},
  // until the settings load: no autosave, no review gate
  autosaveEnabled: false,
  workflowReviews: { enabled: false },
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const me = await authApi.me();
      // bind this tab's requests to the workspace it renders
      setCurrentTenant(me.tenant.id);
      return me;
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useSettings(): Settings {
  const { data } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: settingsApi.get,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return data ?? DEFAULT_SETTINGS;
}

const AI_BUILDER_OFF: AiBuilderFeature = { enabled: false, setup: false };

/** `settings.features.aiBuilder`, typed (`Settings.features` is a free record); off until it loads */
export function aiBuilderFeatureOf(settings: Pick<Settings, 'features'>): AiBuilderFeature {
  const value = settings.features.aiBuilder;
  if (!value || typeof value !== 'object') return AI_BUILDER_OFF;
  const { enabled, setup } = value as Partial<AiBuilderFeature>;
  return { enabled: enabled === true, setup: setup === true };
}

/** P5-09: whether the AI builder is on (AI_ENABLED) and has a model set for the workspace */
export function useAiBuilderFeature(): AiBuilderFeature {
  return aiBuilderFeatureOf(useSettings());
}

const ASSISTANT_OFF: AssistantFeature = { enabled: false, modelSet: false };

/** P5-67: `settings.features.assistant`, typed (`Settings.features` is a free record); off until it loads */
export function assistantFeatureOf(settings: Pick<Settings, 'features'>): AssistantFeature {
  const value = settings.features.assistant;
  if (!value || typeof value !== 'object') return ASSISTANT_OFF;
  const { enabled, modelSet } = value as Partial<AssistantFeature>;
  return { enabled: enabled === true, modelSet: modelSet === true };
}

/** P5-67: whether the Assistant is on for the workspace and has a model */
export function useAssistantFeature(): AssistantFeature {
  return assistantFeatureOf(useSettings());
}

export interface NodeTypeIndex {
  list: NodeTypeDescription[];
  byName: Map<string, NodeTypeDescription>;
  get(name: string): NodeTypeDescription | undefined;
}

export function indexNodeTypes(list: NodeTypeDescription[]): NodeTypeIndex {
  const byName = new Map(list.map((d) => [d.name, d]));
  return { list, byName, get: (name) => byName.get(name) };
}

export function useNodeTypes(): NodeTypeIndex & { isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.nodeTypes,
    queryFn: nodeTypesApi.list,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const index = useMemo(() => indexNodeTypes(data ?? []), [data]);
  return { ...index, isLoading };
}

export interface CredentialTypeIndex {
  list: CredentialTypeDescription[];
  get(name: string): CredentialTypeDescription | undefined;
  /** own properties plus every inherited one (child definitions win) */
  properties(name: string): CredentialTypeDescription['properties'];
}

export function indexCredentialTypes(list: CredentialTypeDescription[]): CredentialTypeIndex {
  const byName = new Map(list.map((d) => [d.name, d]));
  const properties = (name: string, seen = new Set<string>()): CredentialTypeDescription['properties'] => {
    const type = byName.get(name);
    if (!type || seen.has(name)) return [];
    seen.add(name);
    const inherited = (type.extends ?? []).flatMap((parent) => properties(parent, seen));
    const own = new Set(type.properties.map((p) => p.name));
    return [...inherited.filter((p) => !own.has(p.name)), ...type.properties];
  };
  return { list, get: (name) => byName.get(name), properties: (name) => properties(name) };
}

export function useCredentialTypes(): CredentialTypeIndex & { isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.credentialTypes,
    queryFn: nodeTypesApi.credentialTypes,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const index = useMemo(() => indexCredentialTypes(data ?? []), [data]);
  return { ...index, isLoading };
}

export function useCredentials(type?: string) {
  return useQuery({ queryKey: queryKeys.credentials(type), queryFn: () => credentialsApi.list(type) });
}

export function useTags() {
  return useQuery({ queryKey: queryKeys.tags, queryFn: tagsApi.list, staleTime: 60_000 });
}

export function useVariables(enabled = true) {
  return useQuery({ queryKey: queryKeys.variables, queryFn: variablesApi.list, enabled, retry: false });
}

export function useWebhookUrls(workflowId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.webhookUrls(workflowId ?? 'new'),
    queryFn: () => workflowsApi.webhookUrls(workflowId!),
    enabled: Boolean(workflowId) && enabled,
    retry: false,
  });
}

/** P3-07: folders under `parentFolderId` (a folder id or 'root'; omitted = every folder) */
export function useFolders(parentFolderId?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.folders({ parentFolderId }),
    queryFn: () => foldersApi.list({ parentFolderId, limit: 250 }),
    enabled,
  });
}

/** P3-07: one folder with its path and counts */
export function useFolder(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.folder(id ?? 'none'),
    queryFn: () => foldersApi.get(id!),
    enabled: Boolean(id),
    retry: false,
  });
}

/** P3-07: the signed-in user's favorites (workflows and folders) */
export function useFavorites(enabled = true) {
  return useQuery({ queryKey: queryKeys.favorites, queryFn: favoritesApi.list, enabled, staleTime: 60_000 });
}

/** P3-09 */
export function useAnnotationTags(withUsageCount = false) {
  return useQuery({
    queryKey: queryKeys.annotationTags(withUsageCount),
    queryFn: () => annotationTagsApi.list({ withUsageCount }),
    staleTime: 60_000,
  });
}

/** P3-19: open review counts for the nav badge */
export function useInboxSummary(enabled = true) {
  return useQuery({
    queryKey: queryKeys.inboxSummary,
    queryFn: inboxApi.summary,
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}
