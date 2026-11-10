/**
 * P6 S3 (C0c2): the route contracts of commit 0. `API_KEY_SCOPES` ends with the three S3 key scopes; every S3
 * public row (type policies, insights, audit, dependencies, rate limits) carries `access` and a key `scope`, and
 * its answer is named in the OpenAPI components; every S3 REST route answers at its final path (a stub's answer
 * is not checked, only that the path exists: never 404); the CORS preflight allows `push-ref`; GET /settings
 * sends `redactionFloor`.
 */
import { randomUUID } from 'node:crypto';
import { SCOPES } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_KEY_SCOPES } from '../src/http/api-key-scopes';
import type { ApiRoute } from '../src/routes/public-api';
import { PUBLIC_AUDIT_ROUTES } from '../src/routes/public-audit';
import { PUBLIC_DEPENDENCY_ROUTES } from '../src/routes/public-dependencies';
import { PUBLIC_INSIGHTS_ROUTES } from '../src/routes/public-insights';
import { PUBLIC_RATE_LIMIT_ROUTES } from '../src/routes/public-rate-limits';
import { PUBLIC_TYPE_POLICY_ROUTES } from '../src/routes/public-type-policies';
import {
  createTestServer,
  ORIGIN,
  realMember,
  signup,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const S3_PUBLIC_ROWS: Record<string, ApiRoute[]> = {
  PUBLIC_TYPE_POLICY_ROUTES,
  PUBLIC_INSIGHTS_ROUTES,
  PUBLIC_AUDIT_ROUTES,
  PUBLIC_DEPENDENCY_ROUTES,
  PUBLIC_RATE_LIMIT_ROUTES,
};

const rowKeys = (rows: ApiRoute[]) => rows.map((r) => `${r.method} ${r.path}`);

describe('P6 S3 API key scopes', () => {
  it('API_KEY_SCOPES ends with the three S3 scopes, each once, after the S2 scopes', () => {
    expect(API_KEY_SCOPES.slice(-3)).toEqual([
      'nodeTypePolicy:manage',
      'credentialTypePolicy:manage',
      'insights:read',
    ]);
    expect(API_KEY_SCOPES).toHaveLength(81);
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length);
    // the scopes S3 gates on that were there before stay where they were
    expect(API_KEY_SCOPES).toContain('securitySettings:manage');
    expect(API_KEY_SCOPES).toContain('securityAudit:generate');
    for (const scope of API_KEY_SCOPES.slice(-3)) expect(SCOPES as readonly string[]).toContain(scope);
  });
});

describe('P6 S3 public rows', () => {
  it('every S3 public row has `access` with a known user scope and a key scope from API_KEY_SCOPES', () => {
    for (const [name, rows] of Object.entries(S3_PUBLIC_ROWS)) {
      expect(rows.length, name).toBeGreaterThan(0);
      for (const row of rows) {
        const label = `${name} ${row.method} ${row.path}`;
        expect(row.access, label).toBeDefined();
        expect('scope' in row.access, label).toBe(true);
        const userScopes = 'scope' in row.access ? [row.access.scope].flat() : [];
        for (const scope of userScopes) expect(SCOPES as readonly string[], label).toContain(scope);
        expect(row.scope, label).toBeDefined();
        expect(API_KEY_SCOPES as readonly string[], label).toContain(row.scope);
        expect(typeof row.handler, label).toBe('function');
      }
    }
  });

  it('the rows sit at their final paths with their scopes', () => {
    const policyPaths = (base: string) => [
      `GET ${base}/instance`,
      `PUT ${base}/instance`,
      `GET ${base}/projects/:projectId`,
      `PUT ${base}/projects/:projectId`,
      `GET ${base}/policies`,
      `POST ${base}/policies`,
      `GET ${base}/policies/:policyId`,
      `PATCH ${base}/policies/:policyId`,
      `DELETE ${base}/policies/:policyId`,
      `GET ${base}/scopes/:scopeId/attachments`,
      `PUT ${base}/scopes/:scopeId/attachments`,
    ];
    expect(rowKeys(PUBLIC_TYPE_POLICY_ROUTES)).toEqual([
      ...policyPaths('/node-type-policies'),
      ...policyPaths('/credential-type-policies'),
    ]);
    for (const row of PUBLIC_TYPE_POLICY_ROUTES) {
      const scope = row.path.startsWith('/node-') ? 'nodeTypePolicy:manage' : 'credentialTypePolicy:manage';
      expect(row.scope).toBe(scope);
      expect('scope' in row.access && row.access.scope).toBe(scope);
      expect(row.summary.startsWith('Preview:')).toBe(true);
    }
    // the project rows check the scope in the project the path names
    const projectRow = PUBLIC_TYPE_POLICY_ROUTES.find(
      (r) => r.path === '/node-type-policies/projects/:projectId',
    );
    const target = projectRow && 'target' in projectRow.access ? projectRow.access.target : undefined;
    expect(target?.({ params: { projectId: 'p1' }, query: {}, body: {} })).toEqual({ projectId: 'p1' });

    const summary = (rows: ApiRoute[]) =>
      Object.fromEntries(
        rows.map((r) => [`${r.method} ${r.path}`, [r.scope, 'scope' in r.access ? r.access.scope : null]]),
      );
    expect(summary(PUBLIC_INSIGHTS_ROUTES)).toEqual({
      'GET /insights/summary': ['insights:read', 'insights:list'],
    });
    expect(summary(PUBLIC_AUDIT_ROUTES)).toEqual({
      'POST /audit': ['securityAudit:generate', 'securityAudit:generate'],
    });
    expect(summary(PUBLIC_DEPENDENCY_ROUTES)).toEqual({
      'GET /workflows/:id/dependencies': ['workflow:read', 'workflow:read'],
      'GET /credentials/:id/dependencies': ['credential:read', 'credential:read'],
    });
    expect(summary(PUBLIC_RATE_LIMIT_ROUTES)).toEqual({
      'GET /settings/rate-limits': ['securitySettings:manage', 'securitySettings:manage'],
      'PUT /settings/rate-limits': ['securitySettings:manage', 'securitySettings:manage'],
    });
  });

  it('the OpenAPI components name every S3 answer', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const schemas = res.json().components.schemas as Record<string, unknown>;
    const names = new Set(Object.values(S3_PUBLIC_ROWS).flatMap((rows) => rows.map((r) => r.response)));
    for (const name of names) expect(schemas[name], name).toBeDefined();
    for (const name of [
      'TypePolicyScope',
      'TypePolicyDocument',
      'TypePolicyAttachment',
      'InsightsSummary',
      'SecurityAuditReport',
      'DependencyList',
      'RateLimitSettings',
    ]) {
      expect(schemas[name], name).toBeDefined();
    }
  });
});

describe('P6 S3 REST routes', () => {
  it('every S3 REST route answers at its final path (never 404)', async () => {
    const owner = await signup(server.app);
    const projectId = await teamProjectOf(server, owner.tenant.id);
    const workflow = await workflowIn(server, owner.tenant.id, projectId);
    const id = randomUUID();
    const routes: Array<['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string]> = [];
    for (const base of ['/node-type-policies', '/credential-type-policies']) {
      routes.push(
        ['GET', `${base}/instance`],
        ['PUT', `${base}/instance`],
        ['GET', `${base}/policies`],
        ['POST', `${base}/policies`],
        ['GET', `${base}/policies/${id}`],
        ['PATCH', `${base}/policies/${id}`],
        ['DELETE', `${base}/policies/${id}`],
        ['GET', `${base}/scopes/${id}/attachments`],
        ['PUT', `${base}/scopes/${id}/attachments`],
        ['GET', `/projects/${projectId}${base}/project`],
        ['PUT', `/projects/${projectId}${base}/project`],
      );
    }
    routes.push(
      ['GET', `/projects/${projectId}/available-types`],
      ['GET', `/projects/${projectId}/available-credential-types`],
      ['GET', `/workflows/${workflow.id}/sub-workflows/${id}/policy-check`],
      ['GET', '/insights/summary'],
      ['GET', '/insights/by-workflow'],
      ['GET', '/insights/by-time'],
      ['GET', '/insights/by-time/time-saved'],
      ['GET', '/insights/settings'],
      ['POST', `/workflows/${workflow.id}/presence`],
      ['POST', `/workflows/${workflow.id}/write-access`],
      ['POST', '/executions/stopMany'],
      ['POST', '/executions/delete'],
      ['POST', '/workflow-dependencies/counts'],
      ['POST', '/workflow-dependencies/details'],
      ['GET', `/workflow-dependencies/projects/${projectId}/folders/${id}`],
      ['GET', '/settings/policies/rate-limits'],
      ['PUT', '/settings/policies/rate-limits'],
    );
    expect(routes).toHaveLength(39);
    for (const [method, path] of routes) {
      const res = await owner.client.request(method, `/rest${path}`, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${path}`).not.toBe(404);
    }
  });

  it('a member without the policy scope gets 403 on the workspace policy routes', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    for (const base of ['/node-type-policies', '/credential-type-policies']) {
      const res = await member.client.request('GET', `/rest${base}/instance`);
      expect(res.statusCode, base).toBe(403);
      expect(res.json().error.message).toBe('User is missing a scope required to perform this action');
    }
  });

  it('the CORS preflight allows the push-ref header', async () => {
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: `/rest/workflows/${randomUUID()}/presence`,
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers['access-control-allow-headers'])
      .split(',')
      .map((h) => h.trim());
    expect(allowed).toContain('push-ref');
    expect(allowed).toContain('content-type');
    expect(allowed).toContain('x-tenant-id');
  });

  it('GET /settings sends the redaction floor (off until a workspace sets one)', async () => {
    const owner = await signup(server.app);
    const settings = await owner.client.data<{ redactionFloor?: string }>(
      owner.client.request('GET', '/rest/settings'),
    );
    expect(settings.redactionFloor).toBe('off');
  });
});
