/**
 * External secrets contract (P4-07, P4-08; P6-28 adds the project fields). L9's manager and L11's six
 * providers build on it.
 * A provider reaches its vault only through `deps.http` (the SSRF-guarded client) and reports fixed
 * error texts, never a response body. Secret values stay in the provider's memory.
 */
import type { HttpClient } from '@workflow/core';
import type { Logger, NodeProperty } from '@workflow/workflow';
import type { ProjectRow } from '../../db/schema';

export const SECRET_PROVIDER_STATES = [
  'initializing',
  'initialized',
  'connecting',
  'connected',
  'error',
  'retrying',
] as const;
export type SecretProviderState = (typeof SECRET_PROVIDER_STATES)[number];

/** a connection's decrypted settings, as its type's `properties` describe them */
export type SecretProviderSettings = Record<string, unknown>;

export interface SecretProviderTestResult {
  success: boolean;
  /** a fixed text, never a response body */
  error?: string;
}

export interface SecretProvider {
  /** check the settings; no network */
  init(): Promise<void>;
  /** open the connection and prove it works (EXTERNAL_SECRETS_CONNECT_TIMEOUT) */
  connect(): Promise<void>;
  /** read the secrets into memory (EXTERNAL_SECRETS_REFRESH_TIMEOUT) */
  update(): Promise<void>;
  test(): Promise<SecretProviderTestResult>;
  /** from memory: a string, or an object for providers whose secrets hold fields (Vault, 1Password) */
  getSecret(name: string): unknown;
  hasSecret(name: string): boolean;
  getSecretNames(): string[];
  disconnect(): Promise<void>;
}

export interface SecretProviderDeps {
  /** the guarded client: the only way a provider reaches a vault */
  http: HttpClient;
  logger: Logger;
  connectTimeoutMs: number;
  refreshTimeoutMs: number;
  /** EXTERNAL_SECRETS_PREFER_GET, read by Vault */
  preferGet: boolean;
}

export interface SecretProviderType {
  /** stored in secret_connections.type */
  name: string;
  displayName: string;
  /** the settings form; password fields are blanked on GET and merged back on PATCH */
  properties: NodeProperty[];
  create(settings: SecretProviderSettings, deps: SecretProviderDeps): SecretProvider;
}

/** n8n's test answer */
export interface SecretConnectionTestResult {
  success: boolean;
  testState: 'connected' | 'tested' | 'error';
  error?: string;
}

/** P6-28: a project as a connection names it (the editor's `ProjectRef`) */
export type SecretConnectionProject = Pick<ProjectRow, 'id' | 'name' | 'type' | 'icon'>;

/** what the API shows of a connection: password settings blanked */
export interface SecretConnectionDTO {
  id: string;
  providerKey: string;
  type: string;
  settings: SecretProviderSettings;
  isEnabled: boolean;
  state: SecretProviderState;
  lastError: string | null;
  secretsCount: number;
  /** credentials that use it, for the delete warning */
  credentialsCount: number;
  createdAt: string;
  updatedAt: string;
  /** P6-28: the owning project; null = a workspace connection */
  projectId: string | null;
  /** P6-28: the projects the connection is shared with (`project_secret_access`) */
  projects: SecretConnectionProject[];
}

export interface SecretConnectionCreateInput {
  providerKey: string;
  type: string;
  settings: SecretProviderSettings;
  isEnabled?: boolean;
  /** P6-28: the owning project (the project routes); absent = a workspace connection */
  projectId?: string;
  /** P6-28: share a workspace connection with these projects only (empty or absent: every project) */
  projectIds?: string[];
}

export interface SecretConnectionUpdateInput {
  type?: string;
  settings?: SecretProviderSettings;
  isEnabled?: boolean;
  /** P6-28: the projects the connection is shared with, replacing the list; absent = unchanged */
  projectIds?: string[];
}

/**
 * P6-28: which projects may read a connection. A workspace connection shared with no project is tenant
 * wide; otherwise only its owning project and the projects it is shared with reach it.
 */
export interface SecretConnectionReach {
  projectId: string | null;
  sharedWith: ReadonlySet<string>;
  /** every project and a read with no project reach it */
  tenantWide: boolean;
}

/** who did it, for the audit rows */
export interface SecretActor {
  userId?: string;
  ip?: string;
}
