/**
 * Phase 6 S3 C0 contracts (C0e and C0f): a request hands the tab's `clientId` to the transport and `fetchTransport`
 * sends it as `push-ref`; the Insights link hides for a member; the `/insights` and `/settings/usage` routes render;
 * the Security shell lists the two new sections in n8n's order; the API key form shows the three new scope groups;
 * the workflow settings modal with both stub slots still saves; and the FULL demo parts of commit 0: `/settings`
 * `usage`, `limits.activeWorkflows` and `redactionFloor`, `/settings/security` `redaction`, GET `/executions/:id`
 * and GET `/workflows` `executionBlockedBy`, `core.timeSaved` in the node types and each new demo route registered.
 * Stubs (501) are the lanes' and are not asserted here (a route is only asserted to be registered).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApiRequest, api, fetchTransport, setTransport } from '../src/api/client';
import type { SecurityPolicy, Settings, WorkflowSummary } from '../src/api/types';
import { SECURITY_SECTIONS } from '../src/components/security/sections';
import { ApiKeyScopesField } from '../src/components/settings/ApiKeyScopesField';
import { WorkflowSettingsModal } from '../src/components/workflow/WorkflowSettingsModal';
import { demoAvailableTypes, demoNodeTypes } from '../src/demo/fixtures';
import { MockBackend } from '../src/demo/mock-backend';
import { restrictedDemoTypes } from '../src/demo/mock-type-policies';
import { clientId } from '../src/lib/client-id';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const T = { timeout: 20_000 };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function call(method: Method, path: string, body?: unknown, query?: Record<string, string>) {
  const res = await backend().handle({ method, path, body, query });
  return {
    status: res.status,
    body: res.body as { data?: unknown; error?: { code: string; message: string } },
  };
}

async function data<R>(method: Method, path: string, body?: unknown, query?: Record<string, string>) {
  const res = await call(method, path, body, query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as R;
}

const trigger: WorkflowNode = {
  id: 't1',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client id (lib/client-id.ts, api/client.ts)', () => {
  it('is one id per tab, the same on every call', () => {
    const id = clientId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(clientId()).toBe(id);
  });

  it('a request hands clientId to the transport', async () => {
    const seen: ApiRequest[] = [];
    setTransport(async (request) => {
      seen.push(request);
      return { status: 200, body: { data: null } };
    });
    await api.get('/probe');
    await api.post('/probe', {});
    expect(seen).toHaveLength(2);
    for (const request of seen) expect(request.clientId).toBe(clientId());
  });

  it('fetchTransport sends it as the push-ref header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"data":null}', { status: 200 }));
    await fetchTransport({ method: 'GET', path: '/probe', clientId: 'tab-1', tenantId: 'ten-1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(headers.get('push-ref')).toBe('tab-1');
    expect(headers.get('x-tenant-id')).toBe('ten-1');
  });
});

describe('Insights and Usage routes and links', () => {
  it('shows the Insights link to an owner and hides it from a member', async () => {
    signedIn();
    const first = renderApp('/settings/account');
    const link = await screen.findByRole('link', { name: 'Insights' }, T);
    expect(link.getAttribute('href')).toBe('/insights');
    first.unmount();
    backend().setDemoRole('member');
    renderApp('/settings/account');
    await screen.findByRole('link', { name: 'API keys' }, T);
    // the role has loaded once the account page shows it
    await screen.findAllByText('member', {}, T);
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull();
  });

  it('/insights renders in the shell', async () => {
    signedIn();
    renderApp('/insights');
    expect(await screen.findAllByRole('link', { name: 'Settings' }, T)).not.toHaveLength(0);
    expect(screen.queryByText('This page does not exist')).toBeNull();
  });

  it('/settings/usage renders in the settings layout, with its link for a member too', async () => {
    signedIn();
    backend().setDemoRole('member');
    renderApp('/settings/usage');
    expect(await screen.findByRole('heading', { name: 'Settings' }, T)).toBeTruthy();
    expect(screen.queryByText('This page does not exist')).toBeNull();
    const links = await screen.findAllByRole('link', { name: 'Usage' }, T);
    expect(links.map((l) => l.getAttribute('href'))).toContain('/settings/usage');
  });
});

describe('Security shell sections', () => {
  it('lists data redaction right after two-factor and rate limits last', () => {
    expect(SECURITY_SECTIONS.map((s) => s.id)).toEqual([
      'mfa',
      'data-redaction',
      'personal-space',
      'workflow-reviews',
      'rate-limits',
    ]);
  });

  it('still renders the workflow reviews section with the new stub sections mounted', async () => {
    signedIn();
    renderApp('/settings/security');
    expect(await screen.findByRole('heading', { name: 'Security' }, T)).toBeTruthy();
    expect(await screen.findByRole('switch', { name: 'Workflow reviews' }, T)).toBeTruthy();
  });
});

describe('API key scopes', () => {
  it('shows the three new groups, appended last', () => {
    render(<ApiKeyScopesField value={['insights:read']} onChange={vi.fn()} />);
    for (const scope of ['nodeTypePolicy:manage', 'credentialTypePolicy:manage', 'insights:read'])
      expect(screen.getByRole('checkbox', { name: scope })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'insights:read' }) as HTMLInputElement).checked).toBe(true);
    const groups = screen
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label'))
      .filter((label): label is string => label !== null);
    expect(groups.slice(-3)).toEqual(['Node type policies', 'Credential type policies', 'Insights']);
  });
});

describe('Workflow settings modal with the redaction and time saved slots', () => {
  it('still saves, keeping the fields the stub slots do not show', async () => {
    const user = userEvent.setup();
    signedIn();
    const onSave = vi.fn();
    const value = {
      timeSavedMode: 'fixed' as const,
      timeSavedPerExecution: 5,
      redactionPolicy: 'all' as const,
      redactCallerExecutions: true,
    };
    withProviders(
      <WorkflowSettingsModal
        open
        onClose={() => undefined}
        value={value}
        workflowId="w1"
        onSave={onSave}
        readOnly={false}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Apply settings' }, T));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject(value);
  });
});

describe('demo /settings (FULL)', () => {
  it('sends usage with activeWorkflows, the limit and the redaction floor when signed in', async () => {
    signedIn();
    const wf = backend().seedWorkflow({ name: 'Live', active: true, nodes: [trigger], connections: {} });
    backend().seedWorkflow({ name: 'Draft', active: false, nodes: [trigger], connections: {} });
    const stored = backend().workflow(wf.id);
    backend().startExecution(stored, stored, { mode: 'manual' });
    const settings = await data<Settings>('GET', '/settings');
    expect(settings.usage).toMatchObject({
      period: new Date().toISOString().slice(0, 7),
      executions: 1,
      activeWorkflows: 1,
    });
    expect(settings.usage?.executionMs).toBeGreaterThanOrEqual(0);
    expect(settings.limits).toMatchObject({ executionTimeoutMax: 3600, activeWorkflows: null });
    expect(settings.redactionFloor).toBe('off');
  });

  it('sends no usage and no floor signed out; the limit follows the option', async () => {
    const settings = await data<Settings>('GET', '/settings');
    expect(settings.usage).toBeUndefined();
    expect(settings.redactionFloor).toBeUndefined();
    const limited = new MockBackend({ activeWorkflowsLimit: 5 });
    const res = await limited.handle({ method: 'GET', path: '/settings' });
    expect((res.body as { data: Settings }).data.limits).toMatchObject({ activeWorkflows: 5 });
  });

  it("does not count another workspace's runs or workflows", async () => {
    signedIn();
    const mine = await data<Settings>('GET', '/settings');
    const other = backend().seedWorkflow({
      name: 'Elsewhere',
      active: true,
      nodes: [trigger],
      connections: {},
    });
    const stored = backend().workflow(other.id);
    const id = backend().startExecution(stored, stored, { mode: 'manual' });
    backend().executions.find((e) => e.id === id)!.tenantId = 'another-tenant';
    stored.tenantId = 'another-tenant';
    const after = await data<Settings>('GET', '/settings');
    expect(after.usage?.activeWorkflows).toBe(mine.usage?.activeWorkflows);
    expect(after.usage?.executions).toBe(mine.usage?.executions);
  });
});

describe('demo /settings/security redaction (FULL)', () => {
  it('answers redaction.floor and its POST takes it', async () => {
    signedIn();
    expect((await data<SecurityPolicy>('GET', '/settings/security')).redaction).toEqual({ floor: 'off' });
    const next = await data<SecurityPolicy>('POST', '/settings/security', { redaction: { floor: 'all' } });
    expect(next.redaction).toEqual({ floor: 'all' });
    expect(next.personalSpacePublishing).toBe(true);
    expect((await data<SecurityPolicy>('GET', '/settings/security')).redaction).toEqual({ floor: 'all' });
    expect((await data<Settings>('GET', '/settings')).redactionFloor).toBe('all');
    expect(backend().redactionFloorOf(backend().session!.tenantId)).toBe('all');
  });

  it('refuses a bad floor with 400 and keeps the rest of the body unapplied', async () => {
    signedIn();
    for (const redaction of [{ floor: 'sometimes' }, {}, null, 'all']) {
      const res = await call('POST', '/settings/security', { personalSpaceSharing: false, redaction });
      expect(res.status).toBe(400);
    }
    const policy = await data<SecurityPolicy>('GET', '/settings/security');
    expect(policy.redaction).toEqual({ floor: 'off' });
    expect(policy.personalSpaceSharing).toBe(true);
  });

  it('a body without redaction keeps the floor', async () => {
    signedIn();
    await data('POST', '/settings/security', { redaction: { floor: 'production' } });
    const next = await data<SecurityPolicy>('POST', '/settings/security', { personalSpaceSharing: false });
    expect(next.redaction).toEqual({ floor: 'production' });
  });

  it('needs securitySettings:manage', async () => {
    signedIn().setDemoRole('editor');
    expect((await call('POST', '/settings/security', { redaction: { floor: 'all' } })).status).toBe(403);
  });
});

describe('demo executions and workflows (FULL seams)', () => {
  it('GET /executions/:id answers as before through the redaction seam', async () => {
    signedIn();
    const wf = backend().seedWorkflow({ name: 'Orders', nodes: [trigger], connections: {} });
    const stored = backend().workflow(wf.id);
    const id = backend().startExecution(stored, stored, { mode: 'manual' });
    const detail = await data<Record<string, unknown>>('GET', `/executions/${id}`);
    expect(detail).toMatchObject({ id, workflowId: wf.id });
    expect(detail.workflowData).toBeTruthy();
    expect(detail.state).toBeTruthy();
    expect(Array.isArray(detail.scopes)).toBe(true);
    const asked = await data<Record<string, unknown>>('GET', `/executions/${id}`, undefined, {
      redactExecutionData: 'false',
    });
    expect(asked.id).toBe(id);
  });

  it('GET /executions still lists and filters by custom data', async () => {
    signedIn();
    const wf = backend().seedWorkflow({ name: 'Orders', nodes: [trigger], connections: {} });
    const stored = backend().workflow(wf.id);
    const id = backend().startExecution(stored, stored, { mode: 'manual' });
    backend().executions.find((e) => e.id === id)!.customData = { orderId: '1042' };
    backend().startExecution(stored, stored, { mode: 'manual' });
    expect(await data<unknown[]>('GET', '/executions')).toHaveLength(2);
    const hit = await data<Array<{ id: string }>>('GET', '/executions', undefined, {
      customDataKey: 'orderId',
      customDataValue: '1042',
      customDataExact: 'true',
    });
    expect(hit.map((e) => e.id)).toEqual([id]);
  });

  it('GET /workflows executionBlockedBy=restrictedNode keeps only blocked workflows (none in a fresh demo)', async () => {
    signedIn();
    backend().seedWorkflow({ name: 'One', nodes: [trigger], connections: {} });
    backend().seedWorkflow({ name: 'Two', nodes: [trigger], connections: {} });
    const all = await data<WorkflowSummary[]>('GET', '/workflows');
    expect(all.map((w) => w.name)).toEqual(expect.arrayContaining(['One', 'Two']));
    expect(restrictedDemoTypes(backend(), backend().session!.tenantId, undefined)).toEqual([]);
    expect(
      await data<WorkflowSummary[]>('GET', '/workflows', undefined, { executionBlockedBy: 'restrictedNode' }),
    ).toEqual([]);
  });
});

describe('demo node types and new routes', () => {
  it('serves core.timeSaved as nodes-base describes it, and no available-types rows', async () => {
    signedIn();
    const types = await data<Array<{ name: string }>>('GET', '/node-types');
    expect(types.map((t) => t.name)).toContain('core.timeSaved');
    const timeSaved = demoNodeTypes.find((d) => d.name === 'core.timeSaved')!;
    expect(timeSaved).toMatchObject({
      displayName: 'Track Time Saved',
      group: ['organization'],
      defaults: { name: 'Time Saved' },
      inputs: ['main'],
      outputs: ['main'],
    });
    expect(timeSaved.properties.map((p) => p.name)).toEqual(['mode', 'minutesSaved']);
    expect(demoAvailableTypes).toEqual([]);
  });

  it.each([
    ['GET', '/projects/p1/available-types'],
    ['GET', '/projects/p1/available-credential-types'],
    ['GET', '/workflows/w1/sub-workflows/w2/policy-check'],
    ['GET', '/roles/project:viewer/assignments/p1/members'],
    ['GET', '/insights/summary'],
    ['GET', '/insights/by-workflow'],
    ['GET', '/insights/by-time'],
    ['GET', '/insights/by-time/time-saved'],
    ['GET', '/insights/settings'],
    ['POST', '/workflows/w1/presence'],
    ['POST', '/workflows/w1/write-access'],
    ['GET', '/settings/policies/rate-limits'],
    ['PUT', '/settings/policies/rate-limits'],
    ['POST', '/executions/stopMany'],
    ['POST', '/executions/delete'],
    ['POST', '/workflow-dependencies/counts'],
    ['POST', '/workflow-dependencies/details'],
    ['GET', '/workflow-dependencies/projects/p1/folders/f1'],
  ] as Array<[Method, string]>)('%s %s is registered', async (method, path) => {
    signedIn();
    const res = await call(method, path, method === 'GET' ? undefined : {});
    // a lane may answer 404 for an unknown id; only the demo's own "no route" answer means unregistered
    expect(res.body.error?.message ?? '').not.toMatch(/^No route for /);
  });
});
