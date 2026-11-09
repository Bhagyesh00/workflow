/**
 * What a custom role may hold: the operations the project role editor offers per resource, and the
 * options the workspace (global) role editor offers per group. The server refuses any other scope
 * in a custom role; the editor draws its checkboxes from these lists.
 *
 * n8n's lists, less the names this product leaves out. Also never offered to a custom role:
 * `credential:createEndUser` (an owner-level project capability), and `eventBusDestination:*`,
 * `logStreaming:manage` and `otel:manage` (a log destination or collector receives every project's
 * events, so only the workspace owner and admin hold them; named deviation from n8n).
 *
 * This module runs in the editor too: no Node API here.
 */
import type { Scope, ScopeOperation, ScopeResource } from './scopes';

type OperationsByResource = { readonly [R in ScopeResource]?: readonly ScopeOperation<R>[] };

/** Per resource, the operations the project role editor offers as checkboxes. */
export const PROJECT_CUSTOM_ROLE_OPERATIONS = {
  project: ['read', 'update', 'delete', 'manageMembers'],
  folder: ['read', 'update', 'create', 'move', 'delete'],
  workflow: [
    'read',
    'execute',
    'update',
    'create',
    'publish',
    'move',
    'delete',
    'enableRedaction',
    'disableRedaction',
  ],
  credential: ['read', 'connect', 'update', 'create', 'share', 'unshare', 'move', 'delete'],
  execution: ['read', 'reveal', 'delete'],
  externalSecretsProvider: ['read', 'create', 'update', 'delete', 'sync'],
  externalSecret: ['list'],
  sourceControl: ['push'],
  dataTable: ['read', 'readRow', 'update', 'readColumn', 'writeColumn', 'writeRow', 'create', 'delete'],
  projectVariable: ['read', 'update', 'create', 'delete'],
} as const satisfies OperationsByResource;

/** Scopes a project role carries with a visible one but never shows as a checkbox of their own. */
export const COUPLED_HIDDEN_SCOPES: ReadonlySet<Scope> = new Set<Scope>(['workflow:unpublish']);

/**
 * The list scope the project role editor adds with each `:read` it saves: `dataTable:listProject`
 * for `dataTable:read`, `<resource>:list` for every other.
 */
export function listCompanionOf(scope: Scope): Scope | undefined {
  if (!scope.endsWith(':read')) return undefined;
  if (scope === 'dataTable:read') return 'dataTable:listProject';
  return `${scope.slice(0, -':read'.length)}:list` as Scope;
}

function projectCustomRoleScopes(): Set<Scope> {
  const out = new Set<Scope>(COUPLED_HIDDEN_SCOPES);
  for (const [resource, operations] of Object.entries(PROJECT_CUSTOM_ROLE_OPERATIONS)) {
    for (const operation of operations) {
      const scope = `${resource}:${operation}` as Scope;
      out.add(scope);
      const companion = listCompanionOf(scope);
      if (companion) out.add(companion);
    }
  }
  return out;
}

/** Every scope a custom project role may hold: the offered operations, their list companions and the coupled hidden scopes. */
export const PROJECT_CUSTOM_ROLE_SCOPES: ReadonlySet<Scope> = projectCustomRoleScopes();

/** Per group, the named options the workspace role editor offers; each option is a bundle of scopes. */
export const GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS = {
  settings: {
    Manage: [
      'securitySettings:manage',
      'sourceControl:manage',
      'externalSecretsProvider:list',
      'externalSecretsProvider:update',
      'saml:manage',
      'ldap:manage',
      'aiAssistant:manage',
      'instanceAi:manage',
      'instanceAi:message',
      'mcp:manage',
      'mcp:oauth',
      'mcpApiKey:create',
      'mcpApiKey:rotate',
    ],
    'Mcp use': ['mcp:oauth', 'mcpApiKey:create', 'mcpApiKey:rotate'],
    'Mcp manage': ['mcp:manage', 'mcp:oauth', 'mcpApiKey:create', 'mcpApiKey:rotate'],
    'AiAssistant use': ['instanceAi:message'],
    'AiAssistant manage': ['aiAssistant:manage', 'instanceAi:manage', 'instanceAi:message'],
  },
  user: {
    View: ['user:list'],
    Manage: [
      'user:create',
      'user:update',
      'user:delete',
      'user:changeRole',
      'user:resetPassword',
      'user:generateInviteLink',
      'user:enforceMfa',
      'user:read',
      'user:list',
    ],
  },
  role: {
    'Manage project roles': ['role:read', 'role:manageProject'],
    Manage: ['role:read', 'role:manage'],
  },
  apiKey: {
    'Manage own': ['apiKey:create', 'apiKey:update'],
    'Manage all': ['apiKey:create', 'apiKey:update', 'apiKey:manage'],
  },
  tag: {
    View: ['tag:read', 'tag:list'],
    Manage: ['tag:read', 'tag:list', 'tag:create', 'tag:update', 'tag:delete'],
  },
  variable: {
    View: ['variable:list', 'variable:read'],
    Manage: ['variable:list', 'variable:read', 'variable:create', 'variable:update', 'variable:delete'],
  },
  credential: {
    View: ['credential:list', 'credential:read'],
    Manage: [
      'credential:list',
      'credential:read',
      'credential:create',
      'credential:update',
      'credential:delete',
      'credential:move',
      'credential:share',
      'credential:unshare',
    ],
  },
  project: {
    Create: ['project:create'],
  },
  insights: {
    View: ['insights:read', 'insights:list'],
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, readonly Scope[]>>>>;

export type GlobalCustomRoleGroup = keyof typeof GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS;

/**
 * Scopes every workspace role holds with no checkbox of its own: the read-only surfaces the
 * member role already reaches.
 */
export const BASELINE_INSTANCE_SCOPES: readonly Scope[] = ['dataTable:list'];

/** Options every workspace role carries whatever is saved; the editor shows them checked and disabled. */
export const MANDATORY_INSTANCE_OPTIONS = [
  { resource: 'user', option: 'View' },
  { resource: 'tag', option: 'View' },
] as const satisfies readonly {
  resource: GlobalCustomRoleGroup;
  option: string;
}[];

function mandatoryInstanceScopes(): Scope[] {
  const groups: Readonly<Record<string, Readonly<Record<string, readonly Scope[]>>>> =
    GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS;
  const out = new Set<Scope>(BASELINE_INSTANCE_SCOPES);
  for (const { resource, option } of MANDATORY_INSTANCE_OPTIONS) {
    for (const scope of groups[resource]?.[option] ?? []) out.add(scope);
  }
  return [...out];
}

/** Every scope a custom workspace role write gets on top of what it saved: the mandatory options plus the baseline. */
export const MANDATORY_INSTANCE_SCOPES: readonly Scope[] = mandatoryInstanceScopes();

/** Every scope a custom workspace role may hold: all group options plus the baseline. */
export const GLOBAL_CUSTOM_ROLE_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  ...Object.values(GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS).flatMap((options) =>
    Object.values<readonly Scope[]>(options).flat(),
  ),
  ...BASELINE_INSTANCE_SCOPES,
]);

/** The scopes a custom role of `roleType` may hold. */
export function customRoleAllowedScopes(roleType: 'project' | 'global'): ReadonlySet<Scope> {
  return roleType === 'project' ? PROJECT_CUSTOM_ROLE_SCOPES : GLOBAL_CUSTOM_ROLE_SCOPES;
}
