/** Phase 6 S1 contract step, C0a: the scope catalog, system role maps, custom role lists and scope arithmetic. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BASELINE_INSTANCE_SCOPES,
  type BaseContext,
  COUPLED_HIDDEN_SCOPES,
  combineScopes,
  customRoleAllowedScopes,
  EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES,
  GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS,
  GLOBAL_CUSTOM_ROLE_SCOPES,
  GLOBAL_ROLE_SCOPES,
  GLOBAL_ROLE_SLUGS,
  type GlobalRoleSlug,
  hasScope,
  IMPLICIT_TEAM_PROJECT_MEMBER_ROLES,
  isScope,
  isSystemRoleSlug,
  listCompanionOf,
  MANDATORY_INSTANCE_SCOPES,
  maskScopes,
  PROJECT_CUSTOM_ROLE_OPERATIONS,
  PROJECT_CUSTOM_ROLE_SCOPES,
  PROJECT_ROLE_SCOPES,
  PROJECT_ROLE_SLUGS,
  type ProjectRoleSlug,
  personalOwnerScopes,
  RESOURCE_ROLE_SCOPES,
  SCOPES,
  type Scope,
  SYSTEM_ROLE_SLUGS,
} from '../src/index';

/** Resources and single scopes the catalog leaves out (decisions.md:103). */
const LEFT_OUT_RESOURCES = [
  'promotions',
  'agent',
  'chatHub',
  'chatHubAgent',
  'skill',
  'projectSkill',
  'credentialResolver',
  'trustedSource',
  'workersView',
  'orchestration',
  'license',
  'encryptionKey',
  'breakingChanges',
  'banner',
  'app',
  'aiPreference',
  'projectAiPreference',
  'community',
  'communityPackage',
];
const LEFT_OUT_SCOPES = [
  'credential:manageInstance',
  'credential:use',
  'instanceAi:gateway',
  'project:export',
  'workflow:export',
  'workflow:import',
  'workflow:execute-chat',
  'workflow:updateRedactionSetting',
];
const isLeftOut = (scope: string) =>
  LEFT_OUT_SCOPES.includes(scope) || LEFT_OUT_RESOURCES.includes(scope.split(':')[0]!);

const ALL_ROLE_SETS: [string, ReadonlySet<Scope>][] = [
  ...Object.entries(GLOBAL_ROLE_SCOPES),
  ...Object.entries(PROJECT_ROLE_SCOPES),
  ...Object.entries(RESOURCE_ROLE_SCOPES),
  ...Object.entries(EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES).map(
    ([k, v]) => [`externalSecrets ${k}`, v] as [string, ReadonlySet<Scope>],
  ),
  [
    'personal owner, policy on',
    personalOwnerScopes({ personalSpacePublishing: true, personalSpaceSharing: true }),
  ],
];

const groupScopes = (): Scope[] =>
  Object.values(GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS).flatMap((options) =>
    Object.values<readonly Scope[]>(options).flat(),
  );
const projectOperationScopes = (): string[] =>
  Object.entries(PROJECT_CUSTOM_ROLE_OPERATIONS).flatMap(([resource, ops]) =>
    (ops as readonly string[]).map((op) => `${resource}:${op}`),
  );

describe('scope catalog', () => {
  it('holds unique resource:operation names only', () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
    for (const scope of SCOPES) expect(scope).toMatch(/^[a-zA-Z]+:[a-zA-Z-]+$/);
    expect(SCOPES.length).toBe(138);
  });

  it('holds no left-out name', () => {
    expect(SCOPES.filter(isLeftOut)).toEqual([]);
  });

  it('holds the names later stages gate on', () => {
    for (const scope of [
      'credential:createEndUser',
      'credential:shareGlobally',
      'project:manageMembers',
      'role:manageProject',
      'securitySettings:manage',
      'eventBusDestination:test',
      'logStreaming:manage',
      'otel:manage',
      'scim:manage',
      'roleMappingRule:list',
      'workflow:enableRedaction',
      'execution:reveal',
      'testRun:list',
      'workflowTags:update',
    ]) {
      expect(isScope(scope), scope).toBe(true);
    }
  });

  it('isScope refuses names outside the catalog', () => {
    expect(isScope('workflow:read')).toBe(true);
    expect(isScope('workflow:export')).toBe(false);
    expect(isScope('nope')).toBe(false);
    expect(isScope(undefined)).toBe(false);
    expectTypeOf<'workflow:read'>().toMatchTypeOf<Scope>();
  });
});

describe('system role maps', () => {
  it('every role map entry is in the catalog and no left-out name is in a role map', () => {
    for (const [name, set] of ALL_ROLE_SETS) {
      for (const scope of set) {
        expect(isScope(scope), `${name}: ${scope}`).toBe(true);
        expect(isLeftOut(scope), `${name}: ${scope}`).toBe(false);
      }
    }
  });

  it('testRun scopes are in no role map', () => {
    for (const [name, set] of ALL_ROLE_SETS) {
      expect(
        [...set].filter((s) => s.startsWith('testRun:')),
        name,
      ).toEqual([]);
    }
  });

  it('owner equals admin', () => {
    expect([...GLOBAL_ROLE_SCOPES.admin].sort()).toEqual([...GLOBAL_ROLE_SCOPES.owner].sort());
    expect(GLOBAL_ROLE_SCOPES.owner.size).toBeGreaterThan(100);
    expect(hasScope(GLOBAL_ROLE_SCOPES.owner, 'credential:createEndUser')).toBe(true);
    expect(hasScope(GLOBAL_ROLE_SCOPES.owner, 'eventBusDestination:create')).toBe(true);
  });

  it('member has no project:create and no workflow, credential or project rights', () => {
    const member = GLOBAL_ROLE_SCOPES.member;
    expect(hasScope(member, 'project:create')).toBe(false);
    expect([...member].filter((s) => /^(workflow|credential|project|execution|folder):/.test(s))).toEqual([]);
    expect(hasScope(member, 'user:list')).toBe(true);
    expect(hasScope(member, 'tag:create')).toBe(true);
    expect(hasScope(member, 'tag:delete')).toBe(false);
  });

  it('member holds no log streaming destination scope (Q-F9)', () => {
    expect([...GLOBAL_ROLE_SCOPES.member].filter((s) => s.startsWith('eventBusDestination:'))).toEqual([]);
  });

  it('project editor has no move, share, project update or members', () => {
    const editor = PROJECT_ROLE_SCOPES['project:editor'];
    for (const scope of [
      'workflow:move',
      'workflow:share',
      'project:update',
      'project:manageMembers',
    ] as const) {
      expect(hasScope(editor, scope), scope).toBe(false);
    }
    expect(hasScope(editor, 'workflow:execute')).toBe(true);
  });

  it('project viewer has no workflow:execute and no write scope', () => {
    const viewer = PROJECT_ROLE_SCOPES['project:viewer'];
    expect(hasScope(viewer, 'workflow:execute')).toBe(false);
    expect([...viewer].filter((s) => /:(create|update|delete|execute|write\w*)$/.test(s))).toEqual([]);
    expect(hasScope(viewer, 'workflow:read')).toBe(true);
  });

  it('project admin manages members; credential:createEndUser maps to project admin and personal owner only', () => {
    expect(hasScope(PROJECT_ROLE_SCOPES['project:admin'], 'project:manageMembers')).toBe(true);
    expect(hasScope(PROJECT_ROLE_SCOPES['project:admin'], 'credential:createEndUser')).toBe(true);
    expect(hasScope(PROJECT_ROLE_SCOPES['project:personalOwner'], 'credential:createEndUser')).toBe(true);
    expect(hasScope(PROJECT_ROLE_SCOPES['project:editor'], 'credential:createEndUser')).toBe(false);
    expect(hasScope(PROJECT_ROLE_SCOPES['project:viewer'], 'credential:createEndUser')).toBe(false);
  });

  it('workflow editor mask drops workflow:delete', () => {
    const projectAdmin = PROJECT_ROLE_SCOPES['project:admin'];
    const masked = maskScopes(projectAdmin, RESOURCE_ROLE_SCOPES['workflow:editor']);
    expect(hasScope(projectAdmin, 'workflow:delete')).toBe(true);
    expect(hasScope(masked, 'workflow:delete')).toBe(false);
    expect(hasScope(masked, 'workflow:update')).toBe(true);
    expect(hasScope(masked, 'workflow:share')).toBe(false);
    expect(
      hasScope(maskScopes(projectAdmin, RESOURCE_ROLE_SCOPES['workflow:owner']), 'workflow:delete'),
    ).toBe(true);
  });

  it('credential user mask holds read only', () => {
    const masked = maskScopes(PROJECT_ROLE_SCOPES['project:admin'], RESOURCE_ROLE_SCOPES['credential:user']);
    expect(hasScope(masked, 'credential:read')).toBe(true);
    for (const scope of [
      'credential:update',
      'credential:delete',
      'credential:share',
      'credential:unshare',
      'credential:move',
      'credential:createEndUser',
      'credential:list',
      'credential:create',
    ] as const) {
      expect(hasScope(masked, scope), scope).toBe(false);
    }
    expect([...RESOURCE_ROLE_SCOPES['credential:user']].sort()).toEqual([
      'credential:connect',
      'credential:read',
    ]);
  });

  it('personal owner has no project:delete, update or members', () => {
    const on = personalOwnerScopes({ personalSpacePublishing: true, personalSpaceSharing: true });
    for (const set of [PROJECT_ROLE_SCOPES['project:personalOwner'], on]) {
      expect(hasScope(set, 'project:delete')).toBe(false);
      expect(hasScope(set, 'project:update')).toBe(false);
      expect(hasScope(set, 'project:manageMembers')).toBe(false);
    }
  });

  it('the policy flags add and remove the three scopes', () => {
    const three: Scope[] = ['workflow:publish', 'workflow:share', 'credential:share'];
    const off = personalOwnerScopes({ personalSpacePublishing: false, personalSpaceSharing: false });
    const on = personalOwnerScopes({ personalSpacePublishing: true, personalSpaceSharing: true });
    const publishOnly = personalOwnerScopes({ personalSpacePublishing: true, personalSpaceSharing: false });
    const shareOnly = personalOwnerScopes({ personalSpacePublishing: false, personalSpaceSharing: true });
    for (const scope of three) {
      expect(hasScope(off, scope), scope).toBe(false);
      expect(hasScope(on, scope), scope).toBe(true);
    }
    expect([...publishOnly].filter((s) => three.includes(s))).toEqual(['workflow:publish']);
    expect([...shareOnly].filter((s) => three.includes(s)).sort()).toEqual([
      'credential:share',
      'workflow:share',
    ]);
    expect(on.size - off.size).toBe(3);
    expect([...off].sort()).toEqual([...PROJECT_ROLE_SCOPES['project:personalOwner']].sort());
    // the base map is not changed by a call
    expect(hasScope(PROJECT_ROLE_SCOPES['project:personalOwner'], 'workflow:publish')).toBe(false);
  });

  it('the external secrets switch gives project admin full and project editor read', () => {
    expect(
      hasScope(EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES['project:admin'], 'externalSecretsProvider:create'),
    ).toBe(true);
    expect(
      [...EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES['project:editor']].filter((s) => !/:(read|list)$/.test(s)),
    ).toEqual([]);
  });

  it('slugs and implicit team project members', () => {
    expect([...GLOBAL_ROLE_SLUGS]).toEqual(['owner', 'admin', 'member']);
    expect(Object.keys(GLOBAL_ROLE_SCOPES).sort()).toEqual([...GLOBAL_ROLE_SLUGS].sort());
    expect(Object.keys(PROJECT_ROLE_SCOPES).sort()).toEqual([...PROJECT_ROLE_SLUGS].sort());
    expect([...IMPLICIT_TEAM_PROJECT_MEMBER_ROLES]).toEqual(['owner', 'admin']);
    expect([...SYSTEM_ROLE_SLUGS].sort()).toEqual([...GLOBAL_ROLE_SLUGS, ...PROJECT_ROLE_SLUGS].sort());
    expect(isSystemRoleSlug('project:viewer')).toBe(true);
    expect(isSystemRoleSlug('member')).toBe(true);
    expect(isSystemRoleSlug('editor')).toBe(false);
    expect(isSystemRoleSlug('custom-role')).toBe(false);
    expectTypeOf<GlobalRoleSlug>().toEqualTypeOf<'owner' | 'admin' | 'member'>();
    expectTypeOf<ProjectRoleSlug>().toEqualTypeOf<
      'project:admin' | 'project:editor' | 'project:viewer' | 'project:personalOwner'
    >();
  });
});

describe('custom role lists', () => {
  it('every group entry is in the catalog', () => {
    for (const scope of groupScopes()) expect(isScope(scope), scope).toBe(true);
    for (const scope of projectOperationScopes()) expect(isScope(scope), scope).toBe(true);
    for (const scope of PROJECT_CUSTOM_ROLE_SCOPES) expect(isScope(scope), scope).toBe(true);
    for (const scope of GLOBAL_CUSTOM_ROLE_SCOPES) expect(isScope(scope), scope).toBe(true);
    for (const scope of MANDATORY_INSTANCE_SCOPES) expect(isScope(scope), scope).toBe(true);
  });

  it('offers no left-out name and no credential:createEndUser', () => {
    const offered = [...PROJECT_CUSTOM_ROLE_SCOPES, ...GLOBAL_CUSTOM_ROLE_SCOPES];
    expect(offered.filter(isLeftOut)).toEqual([]);
    expect(offered).not.toContain('credential:createEndUser');
  });

  it('no log streaming or OpenTelemetry scope in a custom role group', () => {
    const offered = [
      ...PROJECT_CUSTOM_ROLE_SCOPES,
      ...GLOBAL_CUSTOM_ROLE_SCOPES,
      ...MANDATORY_INSTANCE_SCOPES,
    ];
    expect(
      offered.filter(
        (s) => s.startsWith('eventBusDestination:') || s === 'logStreaming:manage' || s === 'otel:manage',
      ),
    ).toEqual([]);
  });

  it('project roles get list companions and the coupled hidden scope', () => {
    expect(listCompanionOf('dataTable:read')).toBe('dataTable:listProject');
    expect(listCompanionOf('workflow:read')).toBe('workflow:list');
    expect(listCompanionOf('workflow:update')).toBeUndefined();
    for (const scope of [
      'workflow:list',
      'project:list',
      'dataTable:listProject',
      'projectVariable:list',
    ] as const) {
      expect(PROJECT_CUSTOM_ROLE_SCOPES.has(scope), scope).toBe(true);
    }
    for (const scope of COUPLED_HIDDEN_SCOPES) expect(PROJECT_CUSTOM_ROLE_SCOPES.has(scope)).toBe(true);
    expect(customRoleAllowedScopes('project')).toBe(PROJECT_CUSTOM_ROLE_SCOPES);
    expect(customRoleAllowedScopes('global')).toBe(GLOBAL_CUSTOM_ROLE_SCOPES);
  });

  it('every system project role fits the project custom role allow list', () => {
    for (const slug of ['project:admin', 'project:editor', 'project:viewer'] as const) {
      const outside = [...PROJECT_ROLE_SCOPES[slug]].filter(
        (s) =>
          !PROJECT_CUSTOM_ROLE_SCOPES.has(s) &&
          s !== 'credential:createEndUser' &&
          s !== 'nodeTypePolicy:manage' &&
          s !== 'credentialTypePolicy:manage',
      );
      expect(outside, slug).toEqual([]);
    }
  });

  it('the member role fits the global custom role lists with the mandatory scopes', () => {
    const allowed = new Set([...GLOBAL_CUSTOM_ROLE_SCOPES, ...MANDATORY_INSTANCE_SCOPES]);
    expect(BASELINE_INSTANCE_SCOPES).toEqual(['dataTable:list']);
    // annotation tags have no option of their own, as n8n's lists
    const outside = [...GLOBAL_ROLE_SCOPES.member].filter(
      (s) => !allowed.has(s) && !s.startsWith('annotationTag:'),
    );
    expect(outside).toEqual([]);
  });
});

describe('scope arithmetic', () => {
  it('combineScopes unions into a new set', () => {
    const a: ReadonlySet<Scope> = new Set<Scope>(['workflow:read']);
    const b: ReadonlySet<Scope> = new Set<Scope>(['workflow:read', 'credential:read']);
    const out = combineScopes([a, b]);
    expect([...out].sort()).toEqual(['credential:read', 'workflow:read']);
    out.add('tag:list');
    expect(a.has('tag:list')).toBe(false);
    expect(combineScopes([]).size).toBe(0);
    expectTypeOf(combineScopes).parameter(0).toEqualTypeOf<Iterable<ReadonlySet<Scope>>>();
    expectTypeOf(combineScopes).returns.toEqualTypeOf<Set<Scope>>();
  });

  it('maskScopes keeps what both hold', () => {
    const role = new Set<Scope>(['workflow:read', 'workflow:delete', 'project:read']);
    const mask = new Set<Scope>(['workflow:read', 'workflow:update']);
    expect([...maskScopes(role, mask)]).toEqual(['workflow:read']);
    expectTypeOf(maskScopes).returns.toEqualTypeOf<Set<Scope>>();
  });

  it('hasScope reads sets and arrays and denies on a missing set', () => {
    expect(hasScope(new Set<Scope>(['tag:list']), 'tag:list')).toBe(true);
    expect(hasScope(['tag:list'], 'tag:list')).toBe(true);
    expect(hasScope(['tag:list'], 'tag:read')).toBe(false);
    expect(hasScope(undefined, 'tag:list')).toBe(false);
    expect(hasScope(null, 'tag:list')).toBe(false);
  });
});

describe('BaseContext', () => {
  it('gains getProjectId', () => {
    expectTypeOf<BaseContext['getProjectId']>().toEqualTypeOf<() => string>();
  });
});
