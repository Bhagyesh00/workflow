/** TanStack Query hooks for server data shared across pages. */
import { QueryClient, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isApiError } from './client';
import {
  authApi,
  credentialsApi,
  nodeTypesApi,
  settingsApi,
  tagsApi,
  variablesApi,
  workflowsApi,
} from './endpoints';
import type { CredentialTypeDescription, NodeTypeDescription, Settings } from './types';

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
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: authApi.me,
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
