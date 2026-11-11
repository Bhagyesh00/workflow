/**
 * P6-54 (L9): the security audit, public POST /api/v1/audit. One case per category and section (credentials,
 * database, nodes, instance; filesystem is valid and empty), the `categories` and `daysAbandonedWorkflow`
 * options, a bad category is a 400 with the valid list, another workspace's data is absent, a key without the
 * scope is 403, and platform values (a seeded env value) never appear in a report.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executions } from '../src/db/schema';
import {
  createTestServer,
  credentialIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  TEST_KEY,
  type TestServer,
  workflowIn,
} from './helpers';

const ENV_CANARY = `canary-${randomUUID()}`;
let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({
    LOGIN_RATE_LIMIT_MAX: '1000',
    NODES_EXCLUDE: JSON.stringify([ENV_CANARY]),
    SMTP_PASS: ENV_CANARY,
  });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

let keyCount = 0;
async function keyOf(client: Awaited<ReturnType<typeof signup>>['client'], scopes?: string[]) {
  keyCount += 1;
  const made = await client.data(
    client.post('/rest/api-keys', {
      name: `audit-${keyCount}-${randomUUID().slice(0, 6)}`,
      ...(scopes ? { scopes } : {}),
    }),
  );
  return made.key as string;
}

const audit = (key: string, body?: unknown) =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/audit',
    headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });

async function setup() {
  const owner = await signup(server.app);
  const tenantId = owner.tenant.id;
  const project = await projectIn(server, tenantId, 'Audit');
  return { owner, tenantId, project, key: await keyOf(owner.client) };
}

const refs = (id: string) => ({ testApi: { id, name: 'c' } });
const ids = (section: { location?: Array<{ kind: string; id?: string; nodeName?: string }> }) =>
  (section.location ?? []).map((l) => (l.kind === 'credential' ? l.id : l.nodeName));

async function runAt(tenantId: string, workflowId: string, daysAgo: number) {
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    tenantId,
    { id, workflowId, workflowName: 'run', mode: 'trigger', status: 'success', startedAt: new Date() },
    { workflowData: {}, runOptions: {} },
  );
  await server.ctx.database.db
    .update(executions)
    .set({ createdAt: new Date(Date.now() - daysAgo * 86_400_000) })
    .where(eq(executions.id, id));
}

describe('credentials', () => {
  it('reports a credential no workflow uses, one only in unpublished workflows and one in dormant workflows', async () => {
    const { key, tenantId, project } = await setup();
    const unused = await credentialIn(server, tenantId, project.id, { name: 'Unused' });
    const idle = await credentialIn(server, tenantId, project.id, { name: 'Idle' });
    const live = await credentialIn(server, tenantId, project.id, { name: 'Live' });
    await workflowIn(server, tenantId, project.id, {
      nodes: [node('Idle node', 'core.httpRequest', {}, [0, 0], { credentials: refs(idle.id) })],
    });
    const active = await workflowIn(server, tenantId, project.id, {
      nodes: [node('Live node', 'core.httpRequest', {}, [0, 0], { credentials: refs(live.id) })],
    });
    await server.ctx.repos.workflows.setActive(tenantId, active.id, true);
    await runAt(tenantId, active.id, 1);

    const res = await audit(key, { additionalOptions: { categories: ['credentials'] } });
    expect(res.statusCode).toBe(200);
    const report = res.json().data;
    expect(Object.keys(report)).toEqual(['Credentials Risk Report']);
    const { risk, sections } = report['Credentials Risk Report'];
    expect(risk).toBe('credentials');
    expect(sections).toHaveLength(3);
    for (const section of sections) {
      expect(section).toEqual(
        expect.objectContaining({
          title: expect.any(String),
          description: expect.any(String),
          recommendation: expect.any(String),
        }),
      );
    }
    expect(ids(sections[0])).toEqual([unused.id]);
    expect(sections[0].location[0]).toEqual({ kind: 'credential', id: unused.id, name: 'Unused' });
    expect(ids(sections[1])).toEqual([idle.id]);
    // the live credential sits in an active workflow that ran a day ago: in no section
    expect(JSON.stringify(report)).not.toContain(live.id);
  });

  it('daysAbandonedWorkflow moves the line for a workflow that last ran 10 days ago', async () => {
    const { key, tenantId, project } = await setup();
    const cred = await credentialIn(server, tenantId, project.id);
    const wf = await workflowIn(server, tenantId, project.id, {
      nodes: [node('N', 'core.httpRequest', {}, [0, 0], { credentials: refs(cred.id) })],
    });
    await server.ctx.repos.workflows.setActive(tenantId, wf.id, true);
    await runAt(tenantId, wf.id, 10);

    const wide = (
      await audit(key, { additionalOptions: { categories: ['credentials'], daysAbandonedWorkflow: 30 } })
    ).json();
    expect(wide.data).toEqual({});
    const narrow = (
      await audit(key, { additionalOptions: { categories: ['credentials'], daysAbandonedWorkflow: 5 } })
    ).json();
    const sections = narrow.data['Credentials Risk Report'].sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toContain('5 days');
    expect(ids(sections[0])).toEqual([cred.id]);
  });

  it('a dormant section never prints the config default when the caller sends no days', async () => {
    const { key, tenantId, project } = await setup();
    const cred = await credentialIn(server, tenantId, project.id);
    const wf = await workflowIn(server, tenantId, project.id, {
      nodes: [node('N', 'core.httpRequest', {}, [0, 0], { credentials: refs(cred.id) })],
    });
    await server.ctx.repos.workflows.setActive(tenantId, wf.id, true);
    await runAt(tenantId, wf.id, 4000);
    const res = await audit(key, { additionalOptions: { categories: ['credentials'] } });
    const sections = res.json().data['Credentials Risk Report'].sections;
    expect(sections).toHaveLength(1);
    expect(ids(sections[0])).toEqual([cred.id]);
    const configured = server.ctx.config.securityAudit.daysAbandonedWorkflow;
    expect(sections[0].title).not.toMatch(new RegExp(`\b${configured} days`));
    expect(sections[0].description).not.toMatch(new RegExp(`\b${configured} days`));
  });

  it('reads more than one page of workflows and credentials (200 rows a page)', async () => {
    const { key, tenantId, project } = await setup();
    const cred = await credentialIn(server, tenantId, project.id, { name: 'Paged' });
    for (let i = 0; i < 205; i++) {
      await workflowIn(server, tenantId, project.id, {
        name: `W${i}`,
        nodes: i === 204 ? [node('Use', 'core.httpRequest', {}, [0, 0], { credentials: refs(cred.id) })] : [],
      });
    }
    const res = (await audit(key, { additionalOptions: { categories: ['credentials', 'nodes'] } })).json();
    // the credential is used by a workflow that sits on the second page: it is not "unused"
    expect(res.data['Credentials Risk Report'].sections.map((s: { title: string }) => s.title)).not.toContain(
      'Credentials that no workflow uses',
    );
    expect(res.data['Nodes Risk Report'].sections[0].location).toHaveLength(1);
  });
});

describe('database', () => {
  it('reports an expression in the query and unused query parameters', async () => {
    const { key, tenantId, project } = await setup();
    await workflowIn(server, tenantId, project.id, {
      nodes: [
        node('Expr', 'app.postgres', {
          operation: 'executeQuery',
          query: '=SELECT * FROM t WHERE a = {{ $json.a }}',
        }),
        node('Unused', 'app.mySql', {
          operation: 'executeQuery',
          query: 'SELECT * FROM t WHERE a = 1',
          options: { queryReplacement: '1,2' },
        }),
        node('Fine', 'app.postgres', {
          operation: 'executeQuery',
          query: 'SELECT * FROM t WHERE a = $1',
          options: { queryReplacement: '1' },
        }),
        node('Insert', 'app.postgres', { operation: 'insert', query: '={{ $json.q }}' }),
      ],
    });
    const res = (await audit(key, { additionalOptions: { categories: ['database'] } })).json();
    const { risk, sections } = res.data['Database Risk Report'];
    expect(risk).toBe('database');
    expect(sections).toHaveLength(2);
    expect(ids(sections[0])).toEqual(['Expr']);
    expect(sections[0].location[0]).toMatchObject({ kind: 'node', nodeType: 'app.postgres' });
    expect(ids(sections[1])).toEqual(['Unused']);
  });
});

describe('nodes', () => {
  it('reports the risky node types and nothing else', async () => {
    const { key, tenantId, project } = await setup();
    const wf = await workflowIn(server, tenantId, project.id, {
      name: 'Risky',
      nodes: [
        node('Code', 'core.code'),
        node('Http', 'core.httpRequest'),
        node('Ssh', 'core.ssh'),
        node('Ftp', 'core.ftp'),
        node('Set', 'core.set'),
      ],
    });
    const res = (await audit(key, { additionalOptions: { categories: ['nodes'] } })).json();
    const { sections } = res.data['Nodes Risk Report'];
    expect(sections).toHaveLength(1);
    expect(ids(sections[0]).sort()).toEqual(['Code', 'Ftp', 'Http', 'Ssh']);
    expect(sections[0].location[0]).toMatchObject({ workflowId: wf.id, workflowName: 'Risky' });
  });
});

describe('filesystem', () => {
  it('is a valid category with no risk to report', async () => {
    const { key, tenantId, project } = await setup();
    await workflowIn(server, tenantId, project.id, { nodes: [node('Code', 'core.code')] });
    const res = await audit(key, { additionalOptions: { categories: ['filesystem'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({});
  });
});

describe('instance', () => {
  it('reports a webhook with no authentication and no validator, and the workspace settings', async () => {
    const { key, tenantId, project } = await setup();
    await workflowIn(server, tenantId, project.id, {
      nodes: [
        node('Open', 'core.webhook', { authentication: 'none', path: 'a' }),
        node('Defaulted', 'core.webhook', { path: 'b' }),
        node('Basic', 'core.webhook', { authentication: 'basicAuth', path: 'c' }),
        node('Checked', 'core.webhook', { authentication: 'none', path: 'd' }),
        node('Gate', 'core.if'),
        node('Off', 'core.webhook', { authentication: 'none', path: 'e' }, [0, 0], { disabled: true }),
      ],
      connections: { Checked: { main: [[{ node: 'Gate', type: 'main', index: 0 }]] } },
    });
    const res = (await audit(key, { additionalOptions: { categories: ['instance'] } })).json();
    const { risk, sections } = res.data['Instance Risk Report'];
    expect(risk).toBe('instance');
    const webhooks = sections.find((s: { title: string }) => s.title.startsWith('Webhooks'));
    expect(ids(webhooks).sort()).toEqual(['Defaulted', 'Open']);
    const settings = sections.find((s: { settings?: unknown }) => s.settings);
    expect(settings.settings).toEqual({
      workflowReviews: 'off',
      redactionFloor: 'off',
      nodeTypePolicyDefault: 'allow',
      credentialTypePolicyDefault: 'allow',
    });
  });

  it('leaves a hardened workspace with no settings section', async () => {
    const { key, owner, tenantId } = await setup();
    await owner.client.patch('/rest/settings', { workflowReviews: { enabled: true } });
    await server.ctx.securitySettings.update(tenantId, { redaction: { floor: 'all' } }, owner.user.id);
    for (const kind of ['node', 'credential'] as const) {
      const scope = await server.ctx.typePolicies.getScope(tenantId, kind, null);
      await server.ctx.typePolicies.putScope(
        tenantId,
        kind,
        null,
        { defaultAction: 'deny', attachments: [] },
        scope.version,
      );
    }
    const res = (await audit(key, { additionalOptions: { categories: ['instance'] } })).json();
    expect(res.data).toEqual({});
  });

  it('never returns a platform value', async () => {
    const { key, tenantId, project } = await setup();
    await workflowIn(server, tenantId, project.id, {
      nodes: [
        node('Open', 'core.webhook', {}),
        node('Code', 'core.code'),
        node('Sql', 'app.postgres', { operation: 'executeQuery', query: '={{ 1 }}' }),
      ],
    });
    await credentialIn(server, tenantId, project.id);
    const res = await audit(key);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().data).sort()).toEqual([
      'Credentials Risk Report',
      'Database Risk Report',
      'Instance Risk Report',
      'Nodes Risk Report',
    ]);
    expect(res.body).not.toContain(ENV_CANARY);
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain(TEST_KEY.split(':')[1]);
  });
});

describe('request', () => {
  it('an unknown category is a 400 with the valid list', async () => {
    const { key } = await setup();
    const res = await audit(key, { additionalOptions: { categories: ['credentials', 'bogus'] } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('credentials, database, nodes, filesystem, instance');
    expect(res.body).toContain('bogus');
  });

  it('a bad days value is a 400', async () => {
    const { key } = await setup();
    expect((await audit(key, { additionalOptions: { daysAbandonedWorkflow: 0 } })).statusCode).toBe(400);
  });

  it('another workspace sees none of this workspace', async () => {
    const { tenantId, project } = await setup();
    await credentialIn(server, tenantId, project.id, { name: 'Mine only' });
    await workflowIn(server, tenantId, project.id, {
      nodes: [node('Code', 'core.code'), node('Open', 'core.webhook', {})],
    });
    const other = await signup(server.app);
    const res = await audit(await keyOf(other.client));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Mine only');
    expect(res.body).not.toContain(project.id);
    expect(Object.keys(res.json().data)).toEqual(['Instance Risk Report']);
  });

  it('a key without the scope, a member and no key are refused', async () => {
    const { owner } = await setup();
    const narrow = await keyOf(owner.client, ['workflow:list']);
    expect((await audit(narrow)).statusCode).toBe(403);
    const member = await realMember(owner);
    const memberKey = await keyOf(member.client);
    expect((await audit(memberKey)).statusCode).toBe(403);
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/audit' })).statusCode).toBe(401);
  });
});
