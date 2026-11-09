/**
 * P6-39 (L24), the role cutover in the editor and its demo: the old workspace words `editor` and `viewer` are
 * gone. `ROLES` and the member routes hold owner, admin and member (plus custom global slugs), a create with no
 * project goes to the caller's personal project, `setDemoRole('viewer' | 'editor')` makes a `member` with that
 * project role on the team project, and the five rules that change on purpose hold in the demo too.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../src/api/types';
import { MISSING_SCOPE } from '../src/demo/mock-backend';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

const trigger: WorkflowNode = {
  id: 't',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body, query: {} });
  return {
    status: res.status,
    body: res.body as { data?: Record<string, unknown>; error?: { message: string } },
  };
}

async function created(path: string, body: Record<string, unknown>): Promise<string> {
  const res = await call('POST', path, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.data?.projectId);
}

const teamId = () => backend().oldestTeamProject(backend().auth().tenant.id).id;
const personalId = () => {
  const { tenant, user } = backend().auth();
  return backend().personalProject(tenant.id, user.id).id;
};

beforeEach(() => {
  signedIn();
});

describe('workspace roles', () => {
  it('ROLES holds the system roles only', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'member']);
  });

  it('the member routes refuse the old words and invite as member by default', async () => {
    for (const role of ['editor', 'viewer']) {
      const invite = await call('POST', '/members/invite', { email: `${role}@example.com`, role });
      expect(invite.status).toBe(400);
    }
    expect((await call('POST', '/members/invite', { email: 'plain@example.com' })).status).toBe(200);
    expect(backend().invitations.find((i) => i.email === 'plain@example.com')?.role).toBe('member');
    const other = backend().createAccount({
      email: 'mia@example.com',
      password: 'secret-pass-1',
      name: 'Mia',
      workspaceName: 'Other',
    });
    backend().memberships.push({
      tenantId: backend().auth().tenant.id,
      userId: other.user.id,
      role: 'member',
    });
    expect((await call('PATCH', `/members/${other.user.id}`, { role: 'editor' })).status).toBe(400);
    expect((await call('PATCH', `/members/${other.user.id}`, { role: 'admin' })).status).toBe(200);
  });

  it('the invite dialog offers no old word and starts on Member', async () => {
    renderApp('/settings/members');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Invite' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a member' }, T);
    const select = within(dialog).getByLabelText('Role') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['admin', 'member']));
    expect(values).not.toContain('editor');
    expect(values).not.toContain('viewer');
    expect(select.value).toBe('member');
  });

  it("setDemoRole('viewer') is a member holding project:viewer on the team project", async () => {
    backend().setDemoRole('viewer');
    const me = (await call('GET', '/auth/me')).body.data as { role: string };
    expect(me.role).toBe('member');
    const relation = backend().projectRelations.find(
      (r) => r.projectId === teamId() && r.userId === backend().auth().user.id,
    );
    expect(relation?.role).toBe('project:viewer');
    const refused = await call('POST', '/workflows', { name: 'Team', projectId: teamId() });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toBe(MISSING_SCOPE);
  });
});

describe('creates with no project', () => {
  it("go to the caller's personal project", async () => {
    const personal = personalId();
    expect(await created('/workflows', { name: 'Mine', nodes: [], connections: {} })).toBe(personal);
    expect((await call('POST', '/credentials', { name: 'Key', type: 'crmApi', data: {} })).status).toBe(200);
    expect(backend().credentials.find((c) => c.name === 'Key')?.projectId).toBe(personal);
    expect(await created('/folders', { name: 'Folder' })).toBe(personal);
    expect(await created('/data-tables', { name: 'Table', columns: [] })).toBe(personal);
  });

  it('a project viewer still creates in its own personal project', async () => {
    backend().setDemoRole('viewer');
    expect(await created('/workflows', { name: 'Mine', nodes: [], connections: {} })).toBe(personalId());
  });
});

describe('the rules that change on purpose', () => {
  it('a project viewer writes tags and annotation tags; only owner and admin delete a tag', async () => {
    backend().setDemoRole('viewer');
    const tag = await call('POST', '/tags', { name: 'by-viewer' });
    expect(tag.status).toBe(200);
    const tagId = String(tag.body.data?.id);
    expect((await call('PATCH', `/tags/${tagId}`, { name: 'renamed' })).status).toBe(200);
    backend().setDemoRole('editor');
    expect((await call('DELETE', `/tags/${tagId}`)).status).toBe(403);
    backend().setDemoRole('owner');
    expect((await call('DELETE', `/tags/${tagId}`)).status).toBe(200);

    backend().setDemoRole('viewer');
    const annotation = await call('POST', '/annotation-tags', { name: 'by-viewer' });
    expect(annotation.status).toBe(200);
    const annotationId = String(annotation.body.data?.id);
    expect((await call('PATCH', `/annotation-tags/${annotationId}`, { name: 'renamed' })).status).toBe(200);
    expect((await call('DELETE', `/annotation-tags/${annotationId}`)).status).toBe(200);
  });

  it("a project viewer annotates the project's run; a member outside the project may not", async () => {
    const wf = backend().seedWorkflow({ name: 'Runner', nodes: [trigger], projectId: teamId() });
    expect((await call('POST', `/workflows/${wf.id}/run`, {})).status).toBe(200);
    const runId = backend().executions[0].id;
    backend().setDemoRole('viewer');
    expect((await call('PATCH', `/executions/${runId}`, { vote: 'up' })).status).toBe(200);
    backend().setDemoRole('member');
    backend().projectRelations = backend().projectRelations.filter((r) => r.projectId !== teamId());
    expect((await call('PATCH', `/executions/${runId}`, { vote: 'down' })).status).toBe(403);
  });

  it('listening for a test event needs workflow:execute on the workflow', async () => {
    const wf = backend().seedWorkflow({ name: 'Hook', nodes: [trigger], projectId: teamId() });
    backend().setDemoRole('viewer');
    const refused = await call('POST', `/workflows/${wf.id}/listen-test-trigger`, { nodeName: 'Start' });
    expect(refused.status).toBe(403);
    backend().setDemoRole('editor');
    expect(
      (await call('POST', `/workflows/${wf.id}/listen-test-trigger`, { nodeName: 'Start' })).status,
    ).toBe(200);
    expect((await call('DELETE', `/workflows/${wf.id}/listen-test-trigger`)).status).toBe(200);
  });

  it('a version name needs workflow:update on the workflow', async () => {
    const wf = backend().seedWorkflow({ name: 'Versions', nodes: [trigger], projectId: teamId() });
    backend().setDemoRole('viewer');
    const path = `/workflows/${wf.id}/versions/${wf.versionId}`;
    expect((await call('PATCH', path, { versionName: 'v1' })).status).toBe(403);
    backend().setDemoRole('editor');
    expect((await call('PATCH', path, { versionName: 'v1' })).status).toBe(200);
  });
});
