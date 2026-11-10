/**
 * P6-11: the demo's role provisioning. `GET /sso/provisioning/config` answers what `MockBackend.setDemoProvisioning`
 * set, else provisioning off (L11's Invite tooltip reads it). Saving the config and the role mapping rules follow the
 * server's checks and texts: 2000 characters, a dry run at save, a type that cannot change, owner never given, a
 * move by 0-based position inside the type, project rules removed when project roles stop coming from the provider.
 */
import { evaluateSimple } from '@workflow/workflow';
import type { ProvisioningConfig, RoleMappingRule } from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, HttpError, now } from './mock-http';
import { demoRoles } from './mock-roles';

/** provisioning off: no role comes from the identity provider (our claim names, not n8n's) */
export const DEMO_PROVISIONING_OFF: ProvisioningConfig = {
  scopesProvisionInstanceRole: false,
  scopesProvisionProjectRoles: false,
  scopesUseExpressionMapping: false,
  scopesName: 'workflow',
  scopesInstanceRoleClaimName: 'instance_role',
  scopesProjectsRolesClaimName: 'projects',
};

interface ProvisioningState {
  /** what `setDemoProvisioning` set (null: provisioning off) */
  config: ProvisioningConfig | null;
  rules: Map<string, RoleMappingRule[]>;
}

function state(backend: MockBackend): ProvisioningState {
  let s = backend.ext.provisioning as ProvisioningState | undefined;
  if (!s) {
    s = { config: null, rules: new Map() };
    backend.ext.provisioning = s;
  }
  return s;
}

/** the provisioning config of the demo, as `GET /sso/provisioning/config` answers it */
export function demoProvisioningConfig(backend: MockBackend): ProvisioningConfig {
  return copy(state(backend).config ?? { ...DEMO_PROVISIONING_OFF, defaultInstanceRole: null });
}

/** tests and demo (`MockBackend.setDemoProvisioning`): the provisioning config; null turns it off */
export function setDemoProvisioningConfig(backend: MockBackend, config: ProvisioningConfig | null): void {
  state(backend).config = config ? copy(config) : null;
}

const MAX_EXPRESSION = 2000;
const BAD = 'validation_error';

function rulesOf(backend: MockBackend, tenantId: string): RoleMappingRule[] {
  const map = state(backend).rules;
  let list = map.get(tenantId);
  if (!list) {
    list = [];
    map.set(tenantId, list);
  }
  return list;
}

function sorted(rules: RoleMappingRule[]): RoleMappingRule[] {
  return copy(rules).sort((a, b) => (a.type === b.type ? a.order - b.order : a.type === 'instance' ? -1 : 1));
}

/** the save-time dry run, as the server's: only a syntax error is a problem */
function expressionProblem(expression: unknown): string | undefined {
  if (typeof expression !== 'string' || expression.trim().length === 0) return 'The expression is empty.';
  if (expression.length > MAX_EXPRESSION)
    return `The expression is longer than ${MAX_EXPRESSION} characters.`;
  try {
    evaluateSimple(expression, { $claims: {} }, { timeoutMs: 250 });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return /invalid syntax/i.test(message) ? message.slice(0, 200) : undefined;
  }
}

function roleValid(
  backend: MockBackend,
  tenantId: string,
  type: 'instance' | 'project',
  role: unknown,
): boolean {
  if (typeof role !== 'string' || !role || role === 'owner') return false;
  const custom = demoRoles(backend, tenantId).find((r) => r.slug === role);
  if (type === 'instance') return role === 'admin' || role === 'member' || custom?.roleType === 'global';
  return (
    ['project:admin', 'project:editor', 'project:viewer'].includes(role) || custom?.roleType === 'project'
  );
}

function teamProjects(backend: MockBackend, tenantId: string, projectIds: unknown): string[] {
  if (!Array.isArray(projectIds)) return [];
  const ids = [...new Set(projectIds.map(String))];
  for (const id of ids) {
    if (!backend.projects.some((p) => p.tenantId === tenantId && p.id === id && p.type === 'team')) {
      throw new HttpError(404, 'not_found', 'Project not found');
    }
  }
  return ids;
}

function checkRule(
  backend: MockBackend,
  tenantId: string,
  type: 'instance' | 'project',
  body: Record<string, unknown>,
): void {
  const problem = expressionProblem(body.expression);
  if (problem) {
    const long = typeof body.expression === 'string' && body.expression.length > MAX_EXPRESSION;
    throw new HttpError(
      400,
      'bad_request',
      long
        ? `An expression holds at most ${MAX_EXPRESSION} characters.`
        : `The expression doesn't work: ${problem}`,
    );
  }
  if (!roleValid(backend, tenantId, type, body.role)) {
    throw new HttpError(
      400,
      'bad_request',
      type === 'instance'
        ? `"${String(body.role)}" is not a workspace role a rule may give (owner never is).`
        : `"${String(body.role)}" is not a project role a rule may give.`,
    );
  }
}

export function registerProvisioningRoutes(backend: MockBackend): void {
  backend.on('GET', '/sso/provisioning/config', () => {
    backend.requireScope('provisioning:manage');
    return demoProvisioningConfig(backend);
  });
  backend.on('PATCH', '/sso/provisioning/config', ({ body }) => {
    const { tenant } = backend.requireScope('provisioning:manage');
    const before = demoProvisioningConfig(backend);
    const next: ProvisioningConfig = { ...before };
    for (const key of [
      'scopesProvisionInstanceRole',
      'scopesProvisionProjectRoles',
      'scopesUseExpressionMapping',
    ] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') throw new HttpError(400, BAD, 'Request validation failed');
      next[key] = body[key];
    }
    for (const key of [
      'scopesName',
      'scopesInstanceRoleClaimName',
      'scopesProjectsRolesClaimName',
    ] as const) {
      if (body[key] === undefined) continue;
      const value = typeof body[key] === 'string' ? (body[key] as string).trim() : '';
      if (!value) throw new HttpError(400, BAD, 'Request validation failed');
      if (key === 'scopesName' && /\s/.test(value))
        throw new HttpError(400, BAD, 'A scope name has no spaces');
      next[key] = value;
    }
    if (body.defaultInstanceRole !== undefined) {
      next.defaultInstanceRole = body.defaultInstanceRole === null ? null : String(body.defaultInstanceRole);
    }
    if (body.scopesProvisionInstanceRole === false && body.scopesProvisionProjectRoles === undefined) {
      next.scopesProvisionProjectRoles = false;
    }
    if (next.scopesProvisionProjectRoles && !next.scopesProvisionInstanceRole) {
      throw new HttpError(
        400,
        'bad_request',
        'Project roles need workspace roles to come from the identity provider too.',
      );
    }
    const def = next.defaultInstanceRole;
    if (def && def !== 'block' && !roleValid(backend, tenant.id, 'instance', def)) {
      throw new HttpError(
        400,
        'bad_request',
        'The default role must be a workspace role other than owner, or block.',
      );
    }
    if (before.scopesProvisionProjectRoles && !next.scopesProvisionProjectRoles) {
      state(backend).rules.set(
        tenant.id,
        rulesOf(backend, tenant.id).filter((r) => r.type !== 'project'),
      );
    }
    state(backend).config = copy(next);
    return demoProvisioningConfig(backend);
  });

  backend.on('GET', '/sso/role-mapping-rules', () => {
    const { tenant } = backend.requireScope('roleMappingRule:list');
    return sorted(rulesOf(backend, tenant.id));
  });
  backend.on('POST', '/sso/role-mapping-rules', ({ body }) => {
    const { tenant } = backend.requireScope('roleMappingRule:create');
    const type = body.type;
    if (type !== 'instance' && type !== 'project') throw new HttpError(400, BAD, 'Request validation failed');
    checkRule(backend, tenant.id, type, body);
    let projectIds: string[] = [];
    if (type === 'project') {
      projectIds = teamProjects(backend, tenant.id, body.projectIds);
      if (projectIds.length === 0) {
        throw new HttpError(400, 'bad_request', 'A project rule names at least one project.');
      }
    } else if (Array.isArray(body.projectIds) && body.projectIds.length) {
      throw new HttpError(400, 'bad_request', 'A workspace rule has no projects.');
    }
    const list = rulesOf(backend, tenant.id);
    const order = Math.max(-1, ...list.filter((r) => r.type === type).map((r) => r.order)) + 1;
    const at = now();
    const rule: RoleMappingRule = {
      id: globalThis.crypto.randomUUID(),
      type,
      expression: body.expression as string,
      role: body.role as string,
      order,
      projectIds,
      createdAt: at,
      updatedAt: at,
    };
    list.push(rule);
    return copy(rule);
  });
  backend.on('POST', '/sso/role-mapping-rules/:id/move', ({ params, body }) => {
    const { tenant } = backend.requireScope('roleMappingRule:update');
    const list = rulesOf(backend, tenant.id);
    const rule = list.find((r) => r.id === params[0]);
    if (!rule) throw new HttpError(404, 'not_found', 'Role mapping rule not found');
    if (!Number.isInteger(body.position) || (body.position as number) < 0) {
      throw new HttpError(400, BAD, 'Request validation failed');
    }
    const siblings = list.filter((r) => r.type === rule.type).sort((a, b) => a.order - b.order);
    siblings.splice(siblings.indexOf(rule), 1);
    siblings.splice(Math.min(body.position as number, siblings.length), 0, rule);
    siblings.forEach((r, index) => {
      r.order = index;
    });
    return sorted(list);
  });
  backend.on('PATCH', '/sso/role-mapping-rules/:id', ({ params, body }) => {
    const { tenant } = backend.requireScope('roleMappingRule:update');
    const rule = rulesOf(backend, tenant.id).find((r) => r.id === params[0]);
    if (!rule) throw new HttpError(404, 'not_found', 'Role mapping rule not found');
    if (body.type !== undefined && body.type !== rule.type) {
      throw new HttpError(400, 'bad_request', "A rule's type can't change. Create a new rule instead.");
    }
    checkRule(backend, tenant.id, rule.type, {
      expression: body.expression ?? rule.expression,
      role: body.role ?? rule.role,
    });
    if (body.projectIds !== undefined) {
      const ids = teamProjects(backend, tenant.id, body.projectIds);
      if (rule.type === 'project' && ids.length === 0) {
        throw new HttpError(400, 'bad_request', 'A project rule names at least one project.');
      }
      if (rule.type === 'instance' && ids.length) {
        throw new HttpError(400, 'bad_request', 'A workspace rule has no projects.');
      }
      rule.projectIds = ids;
    }
    rule.expression = (body.expression ?? rule.expression) as string;
    rule.role = (body.role ?? rule.role) as string;
    rule.updatedAt = now();
    return copy(rule);
  });
  backend.on('DELETE', '/sso/role-mapping-rules/:id', ({ params }) => {
    const { tenant } = backend.requireScope('roleMappingRule:delete');
    const list = rulesOf(backend, tenant.id);
    const rule = list.find((r) => r.id === params[0]);
    if (!rule) throw new HttpError(404, 'not_found', 'Role mapping rule not found');
    list.splice(list.indexOf(rule), 1);
    list
      .filter((r) => r.type === rule.type)
      .sort((a, b) => a.order - b.order)
      .forEach((r, index) => {
        r.order = index;
      });
    return { ok: true };
  });
}
