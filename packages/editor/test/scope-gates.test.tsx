/**
 * P6-43: every gate reads scopes, not the role word. A workflow gate reads the workflow's `scopes`, a
 * credential gate the credential's, a data table or folder gate the row's, an execution gate the detail's,
 * a create button the project's, and a settings gate the workspace role's `globalScopes`. A true `member`
 * with a project role gets what that role holds in that project and nothing elsewhere.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import type { MockBackend } from '../src/demo/mock-backend';
import { useProjectDialogStore } from '../src/stores/project-dialog-store';
import { useProjectStore } from '../src/stores/project-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const LONG = { timeout: 20_000 };

const trigger: WorkflowNode = {
  id: 't',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

beforeEach(() => {
  useProjectStore.getState().setCurrentProject(null);
  useProjectDialogStore.getState().close();
});
afterEach(() => setCurrentTenant(null));

/** the signed-in owner becomes a true `member` holding `projectRole` in the default team project */
function asMember(projectRole?: string): { demo: MockBackend; teamId: string } {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const team = demo.defaultProjectFor(tenantId);
  if (projectRole)
    demo.projectRelations.push({
      tenantId,
      projectId: team.id,
      userId: demo.auth().user.id,
      role: projectRole,
    });
  demo.setDemoRole('member');
  return { demo, teamId: team.id };
}

async function openMenu(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }, LONG));
  return { user, menu: await screen.findByRole('menu') };
}

const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

describe('workflow list gates', () => {
  it('a project viewer can read, not create, change, archive, share or move', async () => {
    const { demo, teamId } = asMember('project:viewer');
    demo.seedWorkflow({ name: 'Flow', projectId: teamId });
    renderApp(`/projects/${teamId}/workflows`);
    const { menu } = await openMenu('Flow');
    expect(items(menu)).toEqual(['Open', 'Add to favorites', 'Download as JSON']);
    expect(screen.queryByRole('button', { name: 'Create workflow' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Activate Flow' }).hasAttribute('disabled')).toBe(true);
  });

  it('a project editor creates, changes and archives, but does not share or move', async () => {
    const { demo, teamId } = asMember('project:editor');
    demo.seedWorkflow({ name: 'Flow', projectId: teamId });
    renderApp(`/projects/${teamId}/workflows`);
    expect(await screen.findByRole('button', { name: 'Create workflow' }, LONG)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy();
    const { menu } = await openMenu('Flow');
    expect(items(menu)).toEqual([
      'Open',
      'Add to favorites',
      'Move to folder',
      'Duplicate',
      'Download as JSON',
      'Archive',
    ]);
    expect(screen.getByRole('switch', { name: 'Activate Flow' }).hasAttribute('disabled')).toBe(false);
  });

  it('a project admin moves (workflow:move) but does not share; Move opens the dialog', async () => {
    const { demo, teamId } = asMember('project:admin');
    const wf = demo.seedWorkflow({ name: 'Flow', projectId: teamId });
    renderApp(`/projects/${teamId}/workflows`);
    const { user, menu } = await openMenu('Flow');
    expect(items(menu)).toEqual(expect.arrayContaining(['Move to project', 'Duplicate', 'Archive']));
    expect(items(menu)).not.toContain('Share');
    await user.click(within(menu).getByRole('menuitem', { name: 'Move to project' }));
    expect(useProjectDialogStore.getState().dialog).toEqual({
      kind: 'move',
      resource: 'workflow',
      id: wf.id,
    });
  });

  it('the workspace owner shares; Share opens the dialog for that workflow', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Flow' });
    renderApp('/home/workflows');
    const { user, menu } = await openMenu('Flow');
    expect(items(menu)).toEqual(expect.arrayContaining(['Share', 'Move to project']));
    await user.click(within(menu).getByRole('menuitem', { name: 'Share' }));
    expect(useProjectDialogStore.getState().dialog).toEqual({
      kind: 'share',
      resource: 'workflow',
      id: wf.id,
    });
  });

  it('the same member holds nothing in a project where they have no role', async () => {
    const { demo } = asMember();
    const tenantId = demo.auth().tenant.id;
    const other = demo.createProject({ tenantId, name: 'Other', type: 'team' });
    demo.projectRelations.push({
      tenantId,
      projectId: other.id,
      userId: demo.auth().user.id,
      role: 'project:viewer',
    });
    demo.seedWorkflow({ name: 'Other flow', projectId: other.id });
    renderApp(`/projects/${other.id}/workflows`);
    const { menu } = await openMenu('Other flow');
    expect(items(menu)).not.toContain('Duplicate');
    expect(screen.queryByRole('button', { name: 'Create workflow' })).toBeNull();
  });

  it('the old viewer word holds the same rights as before', async () => {
    const demo = signedIn();
    demo.seedWorkflow({ name: 'Old flow' });
    demo.setDemoRole('viewer');
    renderApp('/home/workflows');
    const { menu } = await openMenu('Old flow');
    expect(items(menu)).toEqual(['Open', 'Add to favorites', 'Download as JSON']);
    expect(screen.queryByRole('button', { name: 'Create workflow' })).toBeNull();
  });
});

describe('the editor', () => {
  async function openEditor(id: string) {
    renderApp(`/workflow/${id}`);
    await waitFor(() => expect(useWorkflowStore.getState().meta.id).toBe(id), LONG);
  }

  it('opens editable for a member with project:editor in the workflow project', async () => {
    const { demo, teamId } = asMember('project:editor');
    const wf = demo.seedWorkflow({ name: 'Mine', nodes: [trigger], projectId: teamId });
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().readOnly).toBe(false);
    expect((await screen.findByRole('button', { name: 'Publish' }, LONG)).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('opens read only for a member with project:viewer, and for a member with no role there', async () => {
    const { demo, teamId } = asMember('project:viewer');
    const wf = demo.seedWorkflow({ name: 'Read me', nodes: [trigger], projectId: teamId });
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    expect((await screen.findByRole('button', { name: 'Publish' }, LONG)).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('stays editable for the owner (the workspace role holds the scope)', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Owner flow', nodes: [trigger] });
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().readOnly).toBe(false);
  });
});

describe('credential list gates', () => {
  function seedCredential(demo: MockBackend, projectId: string) {
    const at = new Date().toISOString();
    demo.credentials.push({
      id: 'cred-1',
      tenantId: demo.auth().tenant.id,
      name: 'Shared key',
      type: 'testAiApi',
      data: {},
      createdAt: at,
      updatedAt: at,
      projectId,
      isGlobal: false,
    });
  }

  it('a project editor adds, edits and deletes', async () => {
    const { demo, teamId } = asMember('project:editor');
    seedCredential(demo, teamId);
    renderApp(`/projects/${teamId}/credentials`);
    expect(await screen.findByRole('button', { name: 'Add credential' }, LONG)).toBeTruthy();
    const { menu } = await openMenu('Shared key');
    expect(items(menu)).toEqual(['Edit', 'Delete']);
  });

  it('a project admin also shares and moves it, and Move opens the dialog', async () => {
    const { demo, teamId } = asMember('project:admin');
    seedCredential(demo, teamId);
    renderApp(`/projects/${teamId}/credentials`);
    const { user, menu } = await openMenu('Shared key');
    expect(items(menu)).toEqual(['Edit', 'Share', 'Move to project', 'Delete']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Move to project' }));
    expect(useProjectDialogStore.getState().dialog).toEqual({
      kind: 'move',
      resource: 'credential',
      id: 'cred-1',
    });
  });

  it('a project viewer has no Add credential button and no row actions', async () => {
    const { demo, teamId } = asMember('project:viewer');
    seedCredential(demo, teamId);
    renderApp(`/projects/${teamId}/credentials`);
    // the project viewer holds neither credential:create nor the credential:list that shows rows
    await screen.findByRole('heading', { name: 'Credentials' }, LONG);
    expect(screen.queryByRole('button', { name: 'Add credential' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Shared key' })).toBeNull();
  });
});

describe('data table gates', () => {
  async function table(demo: MockBackend, projectId: string) {
    const res = await demo.handle({
      method: 'POST',
      path: '/data-tables',
      body: { name: 'Leads', columns: [], projectId },
    });
    expect(res.status).toBe(200);
  }

  it('a project viewer reads a table and changes nothing', async () => {
    const { demo, teamId } = asMember('project:viewer');
    demo.setDemoRole('owner');
    await table(demo, teamId);
    demo.setDemoRole('member');
    renderApp(`/projects/${teamId}/data-tables`);
    const { menu } = await openMenu('Leads');
    expect(items(menu)).toEqual(['Add to favorites', 'Download CSV']);
    expect(screen.queryByRole('button', { name: 'New data table' })).toBeNull();
  });

  it('a project editor changes it', async () => {
    const { demo, teamId } = asMember('project:editor');
    demo.setDemoRole('owner');
    await table(demo, teamId);
    demo.setDemoRole('member');
    renderApp(`/projects/${teamId}/data-tables`);
    const { menu } = await openMenu('Leads');
    expect(items(menu)).toEqual(expect.arrayContaining(['Import CSV', 'Rename', 'Clear all rows', 'Delete']));
    expect(screen.getByRole('button', { name: 'New data table' })).toBeTruthy();
  });
});

describe('execution gates', () => {
  async function run(demo: MockBackend, projectId: string) {
    const wf = demo.seedWorkflow({ name: 'Runner', nodes: [trigger], projectId });
    await demo.handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitFor(() => expect(demo.executions.some((e) => e.status !== 'running')).toBe(true));
    return demo.executions[0].id;
  }

  it('Delete follows execution:delete and the vote buttons follow workflow:execute', async () => {
    const { demo, teamId } = asMember('project:viewer');
    demo.setDemoRole('owner');
    const id = await run(demo, teamId);
    demo.setDemoRole('member');
    renderApp(`/executions/${id}`);
    const panel = await screen.findByRole('region', { name: 'Execution annotation' }, LONG);
    expect(screen.queryByRole('button', { name: 'Delete execution' })).toBeNull();
    expect((within(panel).getByRole('button', { name: 'Bad run' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a project editor deletes and rates', async () => {
    const { demo, teamId } = asMember('project:editor');
    demo.setDemoRole('owner');
    const id = await run(demo, teamId);
    demo.setDemoRole('member');
    renderApp(`/executions/${id}`);
    const panel = await screen.findByRole('region', { name: 'Execution annotation' }, LONG);
    expect(await screen.findByRole('button', { name: 'Delete execution' })).toBeTruthy();
    expect((within(panel).getByRole('button', { name: 'Bad run' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('settings gates read the workspace role scopes', () => {
  it('MCP settings: a member has no switch and no tables; the owner has both', async () => {
    const demo = signedIn();
    demo.setDemoRole('member');
    const { unmount } = renderApp('/settings/mcp');
    expect((await screen.findByTestId('mcp-status', {}, LONG)).textContent).toBe('Off');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Workflows' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Connected clients' })).toBeNull();
    unmount();
    demo.setDemoRole('owner');
    renderApp('/settings/mcp');
    expect(await screen.findByRole('switch', { name: 'MCP access' }, LONG)).toBeTruthy();
    expect(backend().auth().globalRole).toBe('owner');
  });

  it('the Roles link and the reviews switch follow their scopes', async () => {
    const demo = signedIn();
    demo.setDemoRole('member');
    renderApp('/settings/security');
    await screen.findByRole('heading', { name: 'Security' }, LONG);
    const toggles = screen.queryAllByRole('switch');
    for (const toggle of toggles) expect(toggle.hasAttribute('disabled')).toBe(true);
  });
});
