/**
 * P6-58 (S5 L1): audit rows become `audit.*` events. The map from our action to n8n's name (and the metadata rows),
 * the completeness check (every audit action written in server/src is mapped or audit-only, every target is in the
 * catalog), each mapped action with the user's `_email`, the rows L1 adds (variables, credential share, password
 * reset request, 2FA enforcement, workflow reviews switch, security policy, review close, bulk execution delete,
 * roles resolved at an SSO sign-in), and the secrets that never go into an event.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { totp } from '@workflow/nodes-base';
import { EVENT_CATALOG } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_EVENT_MAP,
  AUDIT_ONLY_ACTIONS,
  eventMetadata,
  eventNamesFor,
} from '../src/services/events/audit-events';
import { splitName } from '../src/services/events/user-fields';
import {
  signup as baseSignup,
  captureEvents,
  createTestServer,
  createWorkflow,
  credentialIn,
  memberAs,
  node,
  projectIn,
  realMember,
  ssoOn,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;
let capture: ReturnType<typeof captureEvents>;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    { startMain: false, allowInsecureIdp: true },
  );
  server.ctx.passwords.jitterMs = { min: 0, max: 0 };
  capture = captureEvents(server.ctx);
}, 120_000);
afterAll(async () => {
  capture?.stop();
  await server?.close();
});

let ip = 1;
const signup = () =>
  baseSignup(server.app, {
    remoteAddress: `10.58.${Math.floor(ip / 250) + 10}.${(ip++ % 250) + 1}`,
    projects: 'real',
  });
type Owner = Awaited<ReturnType<typeof signup>>;

const suffix = () => randomUUID().slice(0, 8);

/** the events of one workspace after the stream delivered them */
async function eventsFor(tenantId: string, from = 0) {
  await server.ctx.events.flush();
  return capture.events.slice(from).filter((event) => event.tenantId === tenantId);
}
/** the position after every event so far (an earlier row's event may still be waiting on its payload) */
const mark = async () => {
  await server.ctx.events.flush();
  return capture.events.length;
};

describe('the map', () => {
  it('maps every action to a catalog name, and no action is both mapped and audit-only', () => {
    const catalog = new Set(EVENT_CATALOG.map((entry) => entry.name));
    for (const [action, name] of Object.entries(AUDIT_EVENT_MAP)) {
      expect(catalog.has(name), `${action} -> ${name}`).toBe(true);
      expect(AUDIT_ONLY_ACTIONS.has(action), `${action} is in both`).toBe(false);
      expect(name.startsWith('audit.'), name).toBe(true);
    }
    // every audit name n8n has in the catalog is the target of some row, except the three the run lifecycle emits
    const targets = new Set(Object.values(AUDIT_EVENT_MAP));
    const lifecycle = new Set([
      'audit.workflow.executed',
      'audit.workflow.resumed',
      'audit.workflow.waiting',
    ]);
    const viaMetadata = [
      'audit.user.signedup',
      'audit.workflow-review.changes-requested',
      'audit.public-api-rate-limit.disabled',
      'audit.mcp.access.updated',
      'audit.personal-publishing-restricted.enabled',
      'audit.personal-publishing-restricted.disabled',
      'audit.personal-sharing-restricted.enabled',
      'audit.personal-sharing-restricted.disabled',
      'audit.redaction-enforcement.updated',
      'audit.2fa-enforcement.enabled',
      'audit.2fa-enforcement.disabled',
      'audit.workflow-reviews.enabled',
      'audit.workflow-reviews.disabled',
      'audit.role-mapping.rule.created',
      'audit.role-mapping.rule.updated',
      'audit.role-mapping.rule.deleted',
      'audit.role-mapping.rules.bulk-deleted',
    ];
    for (const entry of EVENT_CATALOG) {
      if (!entry.name.startsWith('audit.') || lifecycle.has(entry.name)) continue;
      const reached = targets.has(entry.name) || viaMetadata.includes(entry.name);
      expect(reached, `${entry.name} has a producer in the map`).toBe(true);
    }
  });

  it('maps by metadata where one action carries several names', () => {
    const names = (entry: Parameters<typeof eventNamesFor>[0]) => eventNamesFor(entry);
    expect(names({ action: 'member.joined', metadata: { role: 'member', invitationId: 'x' } })).toEqual([
      'audit.user.invitation.accepted',
    ]);
    expect(names({ action: 'member.joined', metadata: { jit: true, method: 'oidc' } })).toEqual([
      'audit.user.signedup',
    ]);
    expect(names({ action: 'member.joined', metadata: { method: 'ldap', sync: true } })).toEqual([
      'audit.user.signedup',
    ]);
    expect(names({ action: 'workflow_review.decided', metadata: { decision: 'approved' } })).toEqual([
      'audit.workflow-review.approved',
    ]);
    expect(names({ action: 'workflow_review.decided', metadata: { decision: 'changes_requested' } })).toEqual(
      ['audit.workflow-review.changes-requested'],
    );
    expect(names({ action: 'public_api_rate_limit.updated', metadata: { enabled: true } })).toEqual([
      'audit.public-api-rate-limit.enabled',
    ]);
    expect(names({ action: 'public_api_rate_limit.updated', metadata: { enabled: false } })).toEqual([
      'audit.public-api-rate-limit.disabled',
    ]);
    expect(names({ action: 'mcp.settings_updated', metadata: { enabled: false } })).toEqual([
      'audit.mcp.access.updated',
    ]);
    expect(names({ action: 'mcp.settings_updated', metadata: { autoExposeNewWorkflows: true } })).toEqual([]);
    expect(names({ action: 'tenant.settings_updated', metadata: { mfa: { enforced: true } } })).toEqual([
      'audit.2fa-enforcement.enabled',
    ]);
    expect(names({ action: 'tenant.settings_updated', metadata: { mfa: { enforced: false } } })).toEqual([
      'audit.2fa-enforcement.disabled',
    ]);
    expect(
      names({ action: 'tenant.settings_updated', metadata: { workflowReviews: { enabled: true } } }),
    ).toEqual(['audit.workflow-reviews.enabled']);
    // a settings row that changes none of those stays in the audit log only
    expect(names({ action: 'tenant.settings_updated' })).toEqual([]);
    expect(names({ action: 'tenant.settings_updated', metadata: { ai: true } })).toEqual([]);
    const policy = (changed: string[], extra: Record<string, unknown> = {}) =>
      names({
        action: 'tenant.security_policy_updated',
        metadata: {
          personalSpacePublishing: true,
          personalSpaceSharing: true,
          redactionFloor: 'off',
          ...extra,
          changed,
        },
      });
    expect(policy(['personalSpacePublishing'], { personalSpacePublishing: false })).toEqual([
      'audit.personal-publishing-restricted.enabled',
    ]);
    expect(policy(['personalSpacePublishing'])).toEqual(['audit.personal-publishing-restricted.disabled']);
    expect(policy(['personalSpaceSharing'], { personalSpaceSharing: false })).toEqual([
      'audit.personal-sharing-restricted.enabled',
    ]);
    expect(policy(['personalSpaceSharing'])).toEqual(['audit.personal-sharing-restricted.disabled']);
    expect(policy(['redactionFloor'], { redactionFloor: 'all' })).toEqual([
      'audit.redaction-enforcement.updated',
    ]);
    expect(policy(['personalSpaceSharing', 'redactionFloor'])).toHaveLength(2);
    expect(policy([])).toEqual([]);
    const rule = (change: string) =>
      names({
        action: 'provisioning.updated',
        resourceType: 'role_mapping_rule',
        metadata: { rule: change },
      });
    expect(rule('created')).toEqual(['audit.role-mapping.rule.created']);
    expect(rule('updated')).toEqual(['audit.role-mapping.rule.updated']);
    expect(rule('moved')).toEqual(['audit.role-mapping.rule.updated']);
    expect(rule('deleted')).toEqual(['audit.role-mapping.rule.deleted']);
    expect(
      names({ action: 'provisioning.updated', resourceType: 'tenant', metadata: { projectRulesDeleted: 2 } }),
    ).toEqual(['audit.role-mapping.rules.bulk-deleted']);
    expect(
      names({ action: 'provisioning.updated', resourceType: 'tenant', metadata: { fields: [] } }),
    ).toEqual([]);
    expect(names({ action: 'auth.logout' })).toEqual([]);
    expect(names({ action: 'not.an.action' })).toEqual([]);
  });

  it('keeps secret-looking and over-long metadata out, and splits a name', () => {
    const kept = eventMetadata({
      key: 'REGION',
      token: 'x',
      nested: { password: 'p', fine: 1, deep: { deeper: { deepest: 1 } } },
      list: Array.from({ length: 300 }, (_v, index) => index),
      text: 'a'.repeat(900),
    });
    expect(kept.key).toBe('REGION');
    expect('token' in kept).toBe(false);
    expect(kept.nested).toEqual({ fine: 1, deep: {} });
    expect((kept.list as unknown[]).length).toBe(100);
    expect((kept.text as string).length).toBe(500);
    expect(splitName('Ann Marie Lee')).toEqual({ firstName: 'Ann', lastName: 'Marie Lee' });
    expect(splitName('Ann')).toEqual({ firstName: 'Ann', lastName: '' });
  });
});

/** every file under packages/server/src */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('completeness', () => {
  it('every audit action written in server/src is mapped or audit-only', () => {
    const known = new Set([...Object.keys(AUDIT_EVENT_MAP), ...AUDIT_ONLY_ACTIONS]);
    const families = new Set([...known].map((action) => action.split('.')[0]));
    // a dotted text that is no audit action
    const notAudit = new Set(['assistant.mcpConnection']);
    const found = new Map<string, string>();
    for (const file of sourceFiles(join(__dirname, '..', 'src'))) {
      // the event files name the actions and the event names; they cannot vouch for themselves
      if (file.replace(/\\/g, '/').includes('/services/events/')) continue;
      // span attribute names (workflow.id, execution.mode, ...) share the family names; tracing writes no audit row
      if (file.replace(/\\/g, '/').includes('/services/tracing/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/'([A-Za-z_]+(?:\.[A-Za-z_]+)+)'/g)) {
        const action = match[1];
        if (!families.has(action.split('.')[0]) || notAudit.has(action)) continue;
        // an audit action sits after `action:` or in an audit helper call; other dotted texts (node types,
        // setting paths) share the family names
        const line = text.slice(Math.max(0, match.index - 160), match.index + action.length + 2);
        if (
          /action|audit|ternary|\?/i.test(line) ||
          /^(credential|project|provisioning|sso)\./.test(action)
        ) {
          found.set(action, file);
        }
      }
    }
    const missing = [...found.keys()].filter((action) => !known.has(action));
    expect(missing).toEqual([]);
    // the two template families expand to these actions
    const manager = readFileSync(join(__dirname, '..', 'src/services/secrets/manager.ts'), 'utf8');
    const sourceControl = readFileSync(
      join(__dirname, '..', 'src/services/source-control/settings.ts'),
      'utf8',
    );
    expect(manager).toContain('`secret_connection.${');
    expect(sourceControl).toContain('`source_control.${');
    for (const action of ['created', 'updated', 'deleted', 'tested', 'reloaded']) {
      expect(known.has(`secret_connection.${action}`), action).toBe(true);
    }
    for (const action of [
      'connected',
      'disconnected',
      'preferences_updated',
      'key_generated',
      'pushed',
      'pulled',
      'read_only_changed',
    ]) {
      expect(known.has(`source_control.${action}`), action).toBe(true);
    }
    // a sanity floor: the scan found the rows the plan names
    expect(found.size).toBeGreaterThan(100);
  });
});

/** the metadata the rows that map by metadata need */
const METADATA: Record<string, Record<string, unknown>> = {
  'workflow_review.decided': { decision: 'approved' },
  'public_api_rate_limit.updated': { enabled: true },
};

describe('each mapped action emits its name with the user fields', () => {
  it('emits the mapped name with _email, _firstName, _lastName, userId and globalRole', async () => {
    const o = await signup();
    for (const [action, name] of Object.entries(AUDIT_EVENT_MAP)) {
      const before = await mark();
      await server.ctx.repos.audit.add(o.tenant.id, {
        userId: o.user.id,
        action,
        resourceType: 'thing',
        resourceId: randomUUID(),
        ...(METADATA[action] ? { metadata: METADATA[action] } : {}),
        ip: '203.0.113.9',
      });
      const heard = (await eventsFor(o.tenant.id, before)).filter((event) => event.eventName === name);
      expect(heard, `${action} -> ${name}`).toHaveLength(1);
      expect(heard[0].payload).toMatchObject({
        userId: o.user.id,
        _email: o.user.email,
        globalRole: 'owner',
      });
      expect(typeof heard[0].payload._firstName).toBe('string');
      expect(typeof heard[0].payload._lastName).toBe('string');
      // the client address is no part of an event
      expect(JSON.stringify(heard[0].payload)).not.toContain('203.0.113.9');
    }
  });

  it('an audit-only action and a row with no user emit no event, or no user fields', async () => {
    const o = await signup();
    let before = await mark();
    await server.ctx.repos.audit.add(o.tenant.id, { userId: o.user.id, action: 'auth.logout' });
    await server.ctx.repos.audit.add(o.tenant.id, { userId: o.user.id, action: 'tenant.settings_updated' });
    expect(await eventsFor(o.tenant.id, before)).toEqual([]);
    before = await mark();
    await server.ctx.repos.audit.add(o.tenant.id, { action: 'workflow_review.closed', resourceId: 'r1' });
    const [system] = await eventsFor(o.tenant.id, before);
    expect(system.eventName).toBe('audit.workflow-review.closed');
    expect(system.payload).toEqual({ resourceId: 'r1' });
    expect('userId' in system.payload).toBe(false);
    expect('_email' in system.payload).toBe(false);
  });

  it("one workspace's row reaches no other workspace's events", async () => {
    const a = await signup();
    const b = await signup();
    const before = await mark();
    await server.ctx.repos.audit.add(a.tenant.id, { userId: a.user.id, action: 'apikey.created' });
    expect(await eventsFor(b.tenant.id, before)).toEqual([]);
    expect(await eventsFor(a.tenant.id, before)).toHaveLength(1);
  });

  it('mcp rows: the consent names the client, the access switch needs its flag', async () => {
    const o = await signup();
    let before = await mark();
    await server.ctx.repos.audit.add(o.tenant.id, {
      userId: o.user.id,
      action: 'mcp.oauth_consent_granted',
      resourceType: 'oauth_client',
      resourceId: 'client-1',
      metadata: { scopes: ['tools'], resource: 'r' },
    });
    const [consent] = await eventsFor(o.tenant.id, before);
    expect(consent.eventName).toBe('audit.mcp.oauth.completed');
    expect(consent.payload).toMatchObject({ clientId: 'client-1', _email: o.user.email });
    before = await mark();
    await server.ctx.repos.audit.add(o.tenant.id, {
      userId: o.user.id,
      action: 'mcp.settings_updated',
      metadata: { enabled: true },
    });
    await server.ctx.repos.audit.add(o.tenant.id, {
      userId: o.user.id,
      action: 'mcp.settings_updated',
      metadata: { autoExposeNewWorkflows: true },
    });
    expect((await eventsFor(o.tenant.id, before)).map((e) => e.eventName)).toEqual([
      'audit.mcp.access.updated',
    ]);
  });
});

describe('the rows L1 adds', () => {
  it("a variable's create, update and delete emit with the key and never the value", async () => {
    const o = await signup();
    const before = await mark();
    const VALUE = 'canary-variable-value-31ff';
    const created = await o.client.data<{ id: string }>(
      o.client.post('/rest/variables', { key: 'REGION', value: VALUE }),
    );
    await o.client.data(o.client.patch(`/rest/variables/${created.id}`, { value: `${VALUE}-2` }));
    await o.client.data(o.client.delete(`/rest/variables/${created.id}`));
    const heard = (await eventsFor(o.tenant.id, before)).filter((e) =>
      e.eventName.startsWith('audit.variable.'),
    );
    expect(heard.map((e) => e.eventName)).toEqual([
      'audit.variable.created',
      'audit.variable.updated',
      'audit.variable.deleted',
    ]);
    for (const event of heard) {
      expect(event.payload).toMatchObject({
        variableKey: 'REGION',
        variableId: created.id,
        _email: o.user.email,
      });
    }
    await server.ctx.events.flush();
    expect(JSON.stringify(capture.events)).not.toContain('canary-variable-value');
    const rows = await server.ctx.repos.audit.list(o.tenant.id, 50);
    expect(JSON.stringify(rows)).not.toContain('canary-variable-value');
  });

  it('sharing a credential writes credential.shared once per change and emits audit.user.credentials.shared', async () => {
    const o = await signup();
    const home = await projectIn(server, o.tenant.id, `Home ${suffix()}`);
    const away = await projectIn(server, o.tenant.id, `Away ${suffix()}`);
    const credential = await credentialIn(server, o.tenant.id, home.id);
    const before = await mark();
    await o.client.data(
      o.client.put(`/rest/credentials/${credential.id}/share`, { shareWithIds: [away.id] }),
    );
    // the same list again changes nothing
    await o.client.data(
      o.client.put(`/rest/credentials/${credential.id}/share`, { shareWithIds: [away.id] }),
    );
    const shared = (await eventsFor(o.tenant.id, before)).filter(
      (e) => e.eventName === 'audit.user.credentials.shared',
    );
    expect(shared).toHaveLength(1);
    expect(shared[0].payload).toMatchObject({
      credentialId: credential.id,
      added: [away.id],
      removed: [],
      _email: o.user.email,
    });
    const rows = await server.ctx.repos.audit.list(o.tenant.id, 50);
    expect(rows.filter((row) => row.action === 'credential.shared')).toHaveLength(1);
  });

  it('forgot password writes auth.password_reset_requested for a known user only', async () => {
    const o = await signup();
    vi.spyOn(server.ctx.mailer, 'isConfigured').mockReturnValue(true);
    vi.spyOn(server.ctx.mailer, 'sendPasswordReset').mockResolvedValue(undefined as never);
    try {
      const before = await mark();
      const unknown = await o.client.post('/rest/auth/forgot-password', {
        email: `nobody-${suffix()}@example.com`,
      });
      expect(unknown.statusCode).toBe(200);
      expect(await eventsFor(o.tenant.id, before)).toEqual([]);
      const known = await o.client.post('/rest/auth/forgot-password', { email: o.user.email });
      expect(known.statusCode).toBe(200);
      const requested = (await eventsFor(o.tenant.id, before)).filter(
        (e) => e.eventName === 'audit.user.reset.requested',
      );
      expect(requested).toHaveLength(1);
      expect(requested[0].payload).toMatchObject({ userId: o.user.id, _email: o.user.email });
      // no token or link in the event
      expect(JSON.stringify(requested[0].payload)).not.toMatch(/token|reset-password/i);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('mfa enforcement writes tenant.settings_updated only when the value changes', async () => {
    const o = await signup();
    const STEP_MS = 30_000;
    const codeAt = (secret: string, steps: number) =>
      totp({ secret, timestampMs: Date.now() + steps * STEP_MS }).token;
    const setup = await o.client.data<{ secret: string }>(o.client.get('/rest/auth/mfa/setup'));
    expect(
      (await o.client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -6) })).statusCode,
    ).toBe(200);
    const before = await mark();
    expect((await o.client.post('/rest/settings/mfa-enforce', { enforce: true })).statusCode).toBe(200);
    expect((await o.client.post('/rest/settings/mfa-enforce', { enforce: true })).statusCode).toBe(200);
    expect((await o.client.post('/rest/settings/mfa-enforce', { enforce: false })).statusCode).toBe(200);
    const names = (await eventsFor(o.tenant.id, before))
      .filter((e) => e.eventName.startsWith('audit.2fa-enforcement.'))
      .map((e) => e.eventName);
    expect(names).toEqual(['audit.2fa-enforcement.enabled', 'audit.2fa-enforcement.disabled']);
    const rows = (await server.ctx.repos.audit.list(o.tenant.id, 50)).filter(
      (row) => row.action === 'tenant.settings_updated',
    );
    expect(rows.map((row) => row.metadata)).toEqual([
      { mfa: { enforced: false } },
      { mfa: { enforced: true } },
    ]);
  });

  it('the workflow reviews switch emits when this save changes it', async () => {
    const o = await signup();
    const before = await mark();
    await o.client.data(o.client.patch('/rest/settings', { workflowReviews: { enabled: true } }));
    await o.client.data(o.client.patch('/rest/settings', { workflowReviews: { enabled: true } }));
    await o.client.data(o.client.patch('/rest/settings', { timezone: 'Europe/Paris' }));
    await o.client.data(o.client.patch('/rest/settings', { workflowReviews: { enabled: false } }));
    const names = (await eventsFor(o.tenant.id, before))
      .filter((e) => e.eventName.startsWith('audit.workflow-reviews.'))
      .map((e) => e.eventName);
    expect(names).toEqual(['audit.workflow-reviews.enabled', 'audit.workflow-reviews.disabled']);
  });

  it('the security policy row names what changed, and each change emits its event', async () => {
    const o = await signup();
    const post = (body: Record<string, unknown>) =>
      o.client.data(o.client.post('/rest/settings/security', body));
    const before = await mark();
    await post({ personalSpacePublishing: false });
    await post({ personalSpacePublishing: false });
    await post({ personalSpaceSharing: false, redaction: { floor: 'all' } });
    await post({ personalSpacePublishing: true });
    const names = (await eventsFor(o.tenant.id, before))
      .filter((e) => !e.eventName.startsWith('audit.workflow-reviews.'))
      .map((e) => e.eventName);
    expect(names).toEqual([
      'audit.personal-publishing-restricted.enabled',
      'audit.personal-sharing-restricted.enabled',
      'audit.redaction-enforcement.updated',
      'audit.personal-publishing-restricted.disabled',
    ]);
    const rows = (await server.ctx.repos.audit.list(o.tenant.id, 50)).filter(
      (row) => row.action === 'tenant.security_policy_updated',
    );
    // newest first: the repeated save changed nothing
    expect(rows.map((row) => (row.metadata as { changed: string[] }).changed)).toEqual([
      ['personalSpacePublishing'],
      ['personalSpaceSharing', 'redactionFloor'],
      [],
      ['personalSpacePublishing'],
    ]);
  });

  it('archiving a workflow with an open review writes workflow_review.closed with no user', async () => {
    const o = await signup();
    await o.client.data(o.client.patch('/rest/settings', { workflowReviews: { enabled: true } }));
    const reviewer = await memberAs(o, 'admin');
    const path = `p${suffix()}`;
    const workflow = await createWorkflow(o.client, {
      nodes: [
        node('Webhook', 'core.webhook', { httpMethod: 'POST', path }, [0, 0], { webhookId: `id-${path}` }),
      ],
    });
    const review = await o.client.data<{ id: string }>(
      o.client.post('/rest/workflow-reviews', {
        workflowId: workflow.id,
        title: 'Please check',
        versionName: 'v1',
        reviewerUserIds: [reviewer.user.id],
      }),
    );
    const before = await mark();
    await o.client.data(o.client.post(`/rest/workflows/${workflow.id}/archive`));
    const closed = (await eventsFor(o.tenant.id, before)).filter(
      (e) => e.eventName === 'audit.workflow-review.closed',
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].payload).toMatchObject({
      reviewId: review.id,
      workflowId: workflow.id,
      reason: 'archived',
    });
    expect('userId' in closed[0].payload).toBe(false);
    const row = (await server.ctx.repos.audit.list(o.tenant.id, 50)).find(
      (entry) => entry.action === 'workflow_review.closed',
    );
    expect(row?.userId).toBeNull();
  });

  it('a bulk execution delete writes one execution.deleted with the ids and the cut-off', async () => {
    const o = await signup();
    const workflow = await createWorkflow(o.client, { nodes: [node('Start', 'core.manualTrigger')] });
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const { executionId } = await o.client.data<{ executionId: string }>(
        o.client.post(`/rest/workflows/${workflow.id}/run`, {}),
      );
      await waitForExecution(server.ctx, o.tenant.id, executionId, ['success']);
      ids.push(executionId);
    }
    const before = await mark();
    const deleteBefore = new Date(Date.now() + 60_000).toISOString();
    const res = await o.client.data<{ deleted: number }>(
      o.client.post('/rest/executions/delete', { ids, deleteBefore }),
    );
    expect(res.deleted).toBe(2);
    const deleted = (await eventsFor(o.tenant.id, before)).filter(
      (e) => e.eventName === 'audit.user.execution.deleted',
    );
    expect(deleted).toHaveLength(1);
    expect(deleted[0].payload).toMatchObject({ deleted: 2, deleteBefore, _email: o.user.email });
    expect([...(deleted[0].payload.executionIds as string[])].sort()).toEqual([...ids].sort());
    // a delete that removes nothing writes nothing more
    await o.client.post('/rest/executions/delete', { filters: { workflowId: workflow.id }, deleteBefore });
    expect(
      (await eventsFor(o.tenant.id, before)).filter((e) => e.eventName === 'audit.user.execution.deleted'),
    ).toHaveLength(1);
  });

  it('one execution delete writes execution.deleted from the route (commit 0)', async () => {
    const o = await signup();
    const workflow = await createWorkflow(o.client, { nodes: [node('Start', 'core.manualTrigger')] });
    const { executionId } = await o.client.data<{ executionId: string }>(
      o.client.post(`/rest/workflows/${workflow.id}/run`, {}),
    );
    await waitForExecution(server.ctx, o.tenant.id, executionId, ['success']);
    const before = await mark();
    await o.client.data(o.client.delete(`/rest/executions/${executionId}`));
    const deleted = (await eventsFor(o.tenant.id, before)).filter(
      (e) => e.eventName === 'audit.user.execution.deleted',
    );
    expect(deleted).toHaveLength(1);
    expect(deleted[0].payload).toMatchObject({ executionId, _email: o.user.email });
  });
});

describe('roles resolved at an SSO sign-in', () => {
  const rule = (owner: Owner, body: Record<string, unknown>) =>
    owner.client.post('/rest/sso/role-mapping-rules', body);

  async function signIn(owner: Owner, email: string, claims: Record<string, unknown>) {
    const tenant = (await server.ctx.repos.tenants.get(owner.tenant.id))!;
    return server.ctx.ssoLogin.signIn(
      tenant,
      {
        providerType: 'oidc',
        providerId: `sub-${email}`,
        email,
        emailVerified: true,
        claims: claims as never,
      },
      { ip: '10.9.9.9' },
      { authMethod: 'oidc' },
    );
  }

  it('claim mode: one audit row and one event with the roles, their previous roles and the removed projects', async () => {
    const o = await signup();
    const member = await realMember(o);
    const a = await projectIn(server, o.tenant.id, `A ${suffix()}`);
    const b = await projectIn(server, o.tenant.id, `B ${suffix()}`);
    await server.ctx.repos.projects.relations.add(o.tenant.id, a.id, member.user.id, 'project:viewer');
    await ssoOn(server, o.tenant.id, 'oidc', {
      provisioning: { scopesProvisionInstanceRole: true, scopesProvisionProjectRoles: true },
    });
    const before = await mark();
    await signIn(o, member.email, { instance_role: 'admin', projects: [`${b.id}:project:editor`] });
    const heard = (await eventsFor(o.tenant.id, before)).filter(
      (e) => e.eventName === 'audit.role-mapping.roles-resolved',
    );
    expect(heard).toHaveLength(1);
    // an admin reaches every team project: only the workspace role is resolved and applied
    expect(heard[0].payload).toMatchObject({
      provider: 'oidc',
      userId: member.user.id,
      _email: member.email,
      instanceRole: { role: 'admin', previousRole: 'member', changed: true, fallback: false },
    });
    const rows = (await server.ctx.repos.audit.list(o.tenant.id, 100)).filter(
      (row) => row.action === 'provisioning.roles_resolved',
    );
    expect(rows).toHaveLength(1);

    // back to a member: project roles replace the old ones, the missing project is removed
    const again = await mark();
    await signIn(o, member.email, { instance_role: 'member', projects: [`${b.id}:project:editor`] });
    const second = (await eventsFor(o.tenant.id, again)).find(
      (e) => e.eventName === 'audit.role-mapping.roles-resolved',
    )!;
    expect(second.payload).toMatchObject({
      instanceRole: { role: 'member', previousRole: 'admin', changed: true },
      projectRoles: [{ projectId: b.id, role: 'project:editor', previousRole: null }],
      removedProjectIds: [a.id],
    });
    const third = await mark();
    await signIn(o, member.email, { instance_role: 'member', projects: [] });
    const last = (await eventsFor(o.tenant.id, third)).find(
      (e) => e.eventName === 'audit.role-mapping.roles-resolved',
    )!;
    expect(last.payload).toMatchObject({
      instanceRole: { role: 'member', previousRole: 'member', changed: false },
      removedProjectIds: [b.id],
    });
  });

  it('rule mode: the matched rule ids and the fallback are named', async () => {
    const o = await signup();
    const member = await realMember(o);
    const project = await projectIn(server, o.tenant.id, `R ${suffix()}`);
    await ssoOn(server, o.tenant.id, 'oidc', {
      provisioning: {
        scopesProvisionInstanceRole: true,
        scopesProvisionProjectRoles: true,
        scopesUseExpressionMapping: true,
        defaultInstanceRole: 'member',
      },
    });
    const instanceRule = await o.client.data<{ id: string }>(
      rule(o, { type: 'instance', expression: "{{ $claims.groups.includes('wf-admins') }}", role: 'admin' }),
    );
    const projectRule = await o.client.data<{ id: string }>(
      rule(o, {
        type: 'project',
        expression: "{{ $claims.groups.includes('wf-admins') }}",
        role: 'project:viewer',
        projectIds: [project.id],
      }),
    );
    // a rule created emits the role mapping rule events
    const created = (await eventsFor(o.tenant.id)).filter(
      (e) => e.eventName === 'audit.role-mapping.rule.created',
    );
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(created.at(-1)?.payload).toMatchObject({ ruleId: projectRule.id, _email: o.user.email });

    let before = await mark();
    await signIn(o, member.email, { groups: ['wf-admins'] });
    const matched = (await eventsFor(o.tenant.id, before)).find(
      (e) => e.eventName === 'audit.role-mapping.roles-resolved',
    )!;
    expect(matched.payload).toMatchObject({
      instanceRole: { role: 'admin', matchedRule: instanceRule.id, fallback: false, changed: true },
    });

    before = await mark();
    await signIn(o, member.email, { groups: ['other'] });
    const fallback = (await eventsFor(o.tenant.id, before)).find(
      (e) => e.eventName === 'audit.role-mapping.roles-resolved',
    )!;
    expect(fallback.payload).toMatchObject({
      instanceRole: { role: 'member', previousRole: 'admin', fallback: true, changed: true },
    });
    expect('matchedRule' in (fallback.payload.instanceRole as object)).toBe(false);
  });
});
