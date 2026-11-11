/**
 * P6-80 (L9): a protected workspace (n8n's branchReadOnly) in the editor, on the demo backend with
 * `setDemoProtected(true)`. `usePermissions().can` and the list create gate mask the create, update and delete
 * scopes the server refuses; `canWith` stays raw. The canvas lock is the fourth part of the workflow store's
 * `readOnly`; Publish and Unpublish still follow the role, the archive state, the write lock and the workflow's
 * own scopes; a variable's key is read-only on edit and its value still saves; the sidebar shows the lock. The AI
 * builder still streams its draft onto the canvas (Accept is off); a data table offers no column change, its rows
 * stay editable.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Scope, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBuildStreamConnector } from '../src/api/ai-stream';
import { setCurrentTenant } from '../src/api/client';
import { dataTablesApi } from '../src/api/endpoints';
import { queryKeys } from '../src/api/queries';
import type { MockBackend } from '../src/demo/mock-backend';
import { addDemoRole } from '../src/demo/mock-roles';
import { canWith, usePermissions } from '../src/lib/permissions';
import { useBuilderStore } from '../src/stores/builder-store';
import { useProjectDialogStore } from '../src/stores/project-dialog-store';
import { useProjectStore } from '../src/stores/project-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, testQueryClient, withProviders } from './utils';

const LONG = { timeout: 20_000 };

const trigger: WorkflowNode = {
  id: 't',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

const MASKED: Scope[] = [
  'workflow:create',
  'workflow:update',
  'workflow:delete',
  'credential:create',
  'project:create',
  'variable:create',
  'variable:delete',
  'projectVariable:create',
  'projectVariable:delete',
  'folder:create',
  'folder:update',
  'folder:delete',
  'dataTable:create',
  'dataTable:update',
  'dataTable:delete',
];

beforeEach(() => {
  useProjectStore.getState().setCurrentProject(null);
  useProjectDialogStore.getState().close();
  useWorkflowStore.getState().reset();
});
afterEach(() => {
  setCurrentTenant(null);
  setBuildStreamConnector(null);
  useBuilderStore.getState().reset();
});

/** the signed-in owner becomes a true `member` holding `projectRole` in the default team project */
function asMember(projectRole: string): { demo: MockBackend; teamId: string } {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const team = demo.oldestTeamProject(tenantId);
  demo.projectRelations.push({
    tenantId,
    projectId: team.id,
    userId: demo.auth().user.id,
    role: projectRole,
  });
  demo.setDemoRole('member');
  return { demo, teamId: team.id };
}

async function openEditor(id: string, expectProtected = true) {
  renderApp(`/workflow/${id}`);
  await waitFor(() => expect(useWorkflowStore.getState().meta.id).toBe(id), LONG);
  if (expectProtected)
    await waitFor(() => expect(useWorkflowStore.getState().protectedReadOnly).toBe(true), LONG);
}

function PermissionsProbe({ scopes }: { scopes: Scope[] }) {
  const { can } = usePermissions();
  return <p data-testid="probe">{scopes.map((s) => `${s}=${can(s)}`).join(' ')}</p>;
}

describe('usePermissions on a protected workspace', () => {
  it('masks the create, update and delete scopes; canWith stays raw', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    const queryClient = testQueryClient();
    withProviders(
      <PermissionsProbe scopes={[...MASKED, 'workflow:publish', 'workflow:read']} />,
      queryClient,
    );
    const probe = await screen.findByTestId('probe');
    await waitFor(() => {
      const text = probe.textContent ?? '';
      expect(text).toContain('workflow:read=true');
      for (const scope of MASKED) expect(text).toContain(`${scope}=false`);
    }, LONG);
    expect(probe.textContent).toContain('workflow:publish=true');
    const me = {
      globalScopes: ['workflow:create', 'variable:delete'] as Scope[],
    };
    expect(canWith(me, 'workflow:create')).toBe(true);
    expect(canWith(me, 'variable:delete')).toBe(true);
  });

  it('masks nothing on a writable workspace, and again when the switch goes off', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    const queryClient = testQueryClient();
    withProviders(<PermissionsProbe scopes={['workflow:create', 'dataTable:delete']} />, queryClient);
    const probe = await screen.findByTestId('probe');
    await waitFor(() => expect(probe.textContent).toBe('workflow:create=false dataTable:delete=false'), LONG);
    demo.setDemoProtected(false);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.settings }));
    await waitFor(() => expect(probe.textContent).toBe('workflow:create=true dataTable:delete=true'), LONG);
  });
});

describe('the workflow store protected part', () => {
  it('keeps protectedReadOnly in readOnly through load, setArchived, setLockReadOnly and reset', () => {
    const store = useWorkflowStore.getState();
    store.setProtectedReadOnly(true);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    expect(useWorkflowStore.getState().protectedReadOnly).toBe(true);
    useWorkflowStore.getState().load({ name: 'A' }, { readOnly: false });
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    useWorkflowStore.getState().setArchived(true, false);
    useWorkflowStore.getState().setArchived(false, false);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    useWorkflowStore.getState().setLockReadOnly(true);
    useWorkflowStore.getState().setLockReadOnly(false);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    useWorkflowStore.getState().setProtectedReadOnly(false);
    expect(useWorkflowStore.getState().readOnly).toBe(false);
    // the other parts still hold it
    useWorkflowStore.getState().setLockReadOnly(true);
    useWorkflowStore.getState().setProtectedReadOnly(true);
    useWorkflowStore.getState().setProtectedReadOnly(false);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    useWorkflowStore.getState().reset();
    expect(useWorkflowStore.getState().readOnly).toBe(false);
    expect(useWorkflowStore.getState().protectedReadOnly).toBe(false);
  });
});

describe('the editor on a protected workspace', () => {
  it('opens read-only, and Publish stays enabled for a workflow that may be published', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Flow', nodes: [trigger] });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    expect(useWorkflowStore.getState().roleReadOnly).toBe(false);
    const publish = await screen.findByRole('button', { name: 'Publish' }, LONG);
    expect(publish.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: /^Save/ }).hasAttribute('disabled')).toBe(true);
  });

  it('the Build with AI entry is shown on a writable workspace', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Flow', nodes: [trigger] });
    await openEditor(wf.id, false);
    expect((await screen.findAllByRole('button', { name: 'Build with AI' }, LONG)).length).toBeGreaterThan(0);
  });

  it('the Build with AI entry and the prompt box stay on a protected workspace, with the notice', async () => {
    // the protected part of readOnly alone never hides the builder (n8n); Accept is off and the notice says why
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Flow', nodes: [trigger] });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    await screen.findByRole('button', { name: 'Publish' }, LONG);
    const user = userEvent.setup();
    const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' }, LONG);
    await user.click(entry);
    const panel = await screen.findByRole('complementary', { name: 'AI builder' }, LONG);
    expect(within(panel).getByRole('textbox', { name: 'Message the AI builder' })).toBeTruthy();
    expect(within(panel).queryByText('This workflow is read only.')).toBeNull();
    expect(within(panel).getByTestId('protected-notice-builder')).toBeTruthy();
  });

  it('a send on a protected workspace streams and the draft shows on the canvas, with Accept off', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Flow', nodes: [trigger] });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    await screen.findByRole('button', { name: 'Publish' }, LONG);
    const shape: WorkflowNode = { ...trigger, id: 's', name: 'Shape', type: 'core.set', position: [300, 0] };
    setBuildStreamConnector(async (_body, onChunk) => {
      onChunk({
        type: 'workflow-updated',
        workflow: { name: 'Flow', nodes: [trigger, shape], connections: {} },
      });
      onChunk({ type: 'message', id: 'a1', text: 'Added Shape.' });
    });
    const user = userEvent.setup();
    const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' }, LONG);
    await user.click(entry);
    const panel = await screen.findByRole('complementary', { name: 'AI builder' }, LONG);
    await user.type(within(panel).getByRole('textbox', { name: 'Message the AI builder' }), 'Add a step');
    await user.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(useBuilderStore.getState().streaming).toBe(false), LONG);
    expect(within(panel).getByText('Added Shape.')).toBeTruthy();
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'Shape']);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    const bar = await within(panel).findByRole('region', { name: 'Draft review' }, LONG);
    expect(within(bar).getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(true);
    expect(within(bar).getByRole('button', { name: 'Discard' }).hasAttribute('disabled')).toBe(false);
    await user.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start']);
    expect(useWorkflowStore.getState().roleReadOnly).toBe(false);
  }, 60_000);

  it('an archived workflow on a protected workspace hides the entry and closes the prompt box', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Old', nodes: [trigger], isArchived: true });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    await screen.findByRole('button', { name: 'Publish' }, LONG);
    expect(screen.queryByRole('button', { name: 'Build with AI' })).toBeNull();
    act(() => useBuilderStore.getState().setOpen(true));
    const panel = await screen.findByRole('complementary', { name: 'AI builder' }, LONG);
    expect(within(panel).queryByRole('textbox', { name: 'Message the AI builder' })).toBeNull();
    expect(within(panel).getByText('This workflow is read only.')).toBeTruthy();
  });

  it('Unpublish stays enabled in the menu', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Live', nodes: [trigger], active: true });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }, LONG));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Unpublish' }).hasAttribute('disabled')).toBe(false);
    expect(within(menu).getByRole('menuitem', { name: 'Unpublish' }).getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });

  it('an archived workflow keeps Publish disabled, and Restore and Delete are disabled', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Old', nodes: [trigger], isArchived: true });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    expect((await screen.findByRole('button', { name: 'Publish' }, LONG)).hasAttribute('disabled')).toBe(
      true,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    for (const name of ['Restore', 'Delete']) {
      const item = within(menu).getByRole('menuitem', { name });
      expect(item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true').toBe(true);
    }
  });

  it('an archived workflow on a writable workspace still restores and deletes (the role holds them)', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Old', nodes: [trigger], isArchived: true });
    await openEditor(wf.id, false);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }, LONG));
    const menu = await screen.findByRole('menu');
    for (const name of ['Restore', 'Delete']) {
      const item = within(menu).getByRole('menuitem', { name });
      expect(item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true').toBe(false);
    }
  });

  it("a viewer's Publish stays disabled", async () => {
    const { demo, teamId } = asMember('project:viewer');
    const wf = demo.seedWorkflow({ name: 'Read me', nodes: [trigger], projectId: teamId });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().roleReadOnly).toBe(true);
    expect((await screen.findByRole('button', { name: 'Publish' }, LONG)).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('a project editor still publishes (the workflow holds workflow:publish)', async () => {
    const { demo, teamId } = asMember('project:editor');
    const wf = demo.seedWorkflow({ name: 'Edit me', nodes: [trigger], projectId: teamId });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    expect((await screen.findByRole('button', { name: 'Publish' }, LONG)).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

describe('archive, publish and the command bar on a protected workspace', () => {
  const bannerRestore = () =>
    within(
      screen.getByText('This workflow is archived.').closest('[role="status"]') as HTMLElement,
    ).queryByRole('button', { name: 'Restore' });
  const openBar = async () => {
    // the shortcut is registered once the shell is up: press until the bar opens
    await waitFor(() => {
      act(() => {
        fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
      });
      expect(screen.queryByRole('dialog', { name: 'Command bar' })).toBeTruthy();
    }, LONG);
    const bar = screen.getByRole('dialog', { name: 'Command bar' });
    await userEvent.setup().click(within(bar).getByRole('tab', { name: 'Actions' }));
    return within(bar);
  };

  it('the archived banner has no Restore button, as the top bar menu', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Old', nodes: [trigger], isArchived: true });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    await screen.findByText('This workflow is archived.', {}, LONG);
    expect(bannerRestore()).toBeNull();
  });

  it('the archived banner keeps Restore on a writable workspace', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Old', nodes: [trigger], isArchived: true });
    await openEditor(wf.id, false);
    await screen.findByText('This workflow is archived.', {}, LONG);
    expect(bannerRestore()).toBeTruthy();
  });

  it('the command bar lists no Unarchive and no Delete for an archived workflow', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Old', nodes: [trigger], isArchived: true });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    await screen.findByRole('button', { name: 'Publish' }, LONG);
    const bar = await openBar();
    await bar.findByRole('option', { name: /Download workflow/ });
    expect(bar.queryByRole('option', { name: /Unarchive workflow/ })).toBeNull();
    expect(bar.queryByRole('option', { name: /Delete workflow/ })).toBeNull();
  });

  it('the command bar keeps Unarchive and Delete on a writable workspace', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Old', nodes: [trigger], isArchived: true });
    await openEditor(wf.id, false);
    await screen.findByText('This workflow is archived.', {}, LONG);
    const bar = await openBar();
    expect(await bar.findByRole('option', { name: /Unarchive workflow/ })).toBeTruthy();
    expect(bar.getByRole('option', { name: /Delete workflow/ })).toBeTruthy();
  });

  it('the command bar keeps Publish, and no write command, on a protected workspace', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Flow', nodes: [trigger] });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    await screen.findByRole('button', { name: 'Publish' }, LONG);
    const bar = await openBar();
    expect(await bar.findByRole('option', { name: /Publish workflow/ })).toBeTruthy();
    expect(bar.queryByRole('option', { name: /Add sticky note/ })).toBeNull();
    expect(bar.queryByRole('option', { name: /Archive workflow/ })).toBeNull();
  });

  it('the command bar keeps Unpublish for a published workflow on a protected workspace', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Live', nodes: [trigger], active: true });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    const bar = await openBar();
    expect(await bar.findByRole('option', { name: /Unpublish workflow/ })).toBeTruthy();
  });

  it('Publish is off for a workflow with no id yet, and the command bar has no Publish', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    renderApp('/workflow/new');
    await waitFor(() => expect(useWorkflowStore.getState().protectedReadOnly).toBe(true), LONG);
    const publish = await screen.findByRole('button', { name: 'Publish' }, LONG);
    expect(publish.hasAttribute('disabled')).toBe(true);
    const bar = await openBar();
    await bar.findByRole('option', { name: /Download workflow/ });
    expect(bar.queryByRole('option', { name: /Publish workflow/ })).toBeNull();
  });

  it('Publish is off while the saved workflow has unsaved changes', async () => {
    const demo = signedIn();
    const wf = demo.seedWorkflow({ name: 'Flow', nodes: [trigger] });
    demo.setDemoProtected(true);
    await openEditor(wf.id);
    const publish = await screen.findByRole('button', { name: 'Publish' }, LONG);
    expect(publish.hasAttribute('disabled')).toBe(false);
    act(() => useWorkflowStore.setState({ dirty: true }));
    await waitFor(() => expect(publish.hasAttribute('disabled')).toBe(true));
  });
});

describe('create buttons on a protected workspace', () => {
  it('shows no Create workflow or New folder button, and still lists the workflow', async () => {
    const demo = signedIn();
    demo.seedWorkflow({ name: 'Flow' });
    demo.setDemoProtected(true);
    renderApp('/home/workflows');
    expect(await screen.findByText('Flow', {}, LONG)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create workflow' })).toBeNull(), LONG);
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
  });

  it('shows the Create workflow button on a writable workspace', async () => {
    const demo = signedIn();
    demo.seedWorkflow({ name: 'Flow' });
    renderApp('/home/workflows');
    expect(await screen.findByRole('button', { name: 'Create workflow' }, LONG)).toBeTruthy();
  });

  it('shows no Add credential button', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    renderApp('/home/credentials');
    expect(await screen.findByRole('heading', { name: 'Credentials' }, LONG)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add credential' })).toBeNull(), LONG);
  });

  it('shows no New data table button on a protected workspace', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    renderApp('/home/data-tables');
    expect(await screen.findByRole('heading', { name: 'Data tables' }, LONG)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'New data table' })).toBeNull(), LONG);
    expect(screen.queryByRole('button', { name: 'Create a data table' })).toBeNull();
  });

  it('shows the New data table button on a writable workspace', async () => {
    signedIn();
    renderApp('/home/data-tables');
    expect(await screen.findByRole('button', { name: 'New data table' }, LONG)).toBeTruthy();
  });

  it('hides the Add project button once the settings say protected', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    renderApp('/home/workflows');
    await screen.findByRole('navigation', { name: 'Projects' }, LONG);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull(), LONG);
  });
});

describe('variables on a protected workspace', () => {
  it('the workspace page has no Add form and no Delete, the key is read-only and the value still saves', async () => {
    const demo = signedIn();
    demo.variables.push({ id: 'v1', key: 'region', value: 'eu', tenantId: demo.auth().tenant.id });
    demo.setDemoProtected(true);
    renderApp('/settings/variables');
    const value = (await screen.findByLabelText('Value of region', {}, LONG)) as HTMLInputElement;
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete region' })).toBeNull();
    const key = screen.getByLabelText('Key') as HTMLInputElement;
    expect(key.readOnly).toBe(true);
    expect(value.readOnly).toBe(false);
    const user = userEvent.setup();
    await user.clear(value);
    await user.type(value, 'us');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend().variables[0]?.value).toBe('us'));
    expect(backend().variables[0]?.key).toBe('region');
  });

  it('the workspace page on a writable workspace keeps the Add form, the Delete button and an editable key', async () => {
    const demo = signedIn();
    demo.variables.push({ id: 'v1', key: 'region', value: 'eu', tenantId: demo.auth().tenant.id });
    renderApp('/settings/variables');
    await screen.findByLabelText('Value of region', {}, LONG);
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete region' })).toBeTruthy();
    expect((screen.getByLabelText('Key', { selector: 'li input' }) as HTMLInputElement).readOnly).toBe(false);
  });

  describe.each([
    ['a writable workspace', false],
    ['a protected workspace', true],
  ])('a role with variable:update and no variable:delete on %s', (_label, protectedOn) => {
    // n8n: edit needs the update scope only; the key renames on a writable workspace, not on a protected one
    it('edits the value', async () => {
      const slug = 'global:varEditor';
      const demo = signedIn();
      addDemoRole(demo, {
        tenantId: demo.auth().tenant.id,
        slug,
        displayName: 'Variable editor',
        description: null,
        systemRole: false,
        roleType: 'global',
        scopes: ['variable:list', 'variable:read', 'variable:update'],
      });
      demo.setDemoRole(slug);
      demo.variables.push({ id: 'v1', key: 'region', value: 'eu', tenantId: demo.auth().tenant.id });
      if (protectedOn) demo.setDemoProtected(true);
      renderApp('/settings/variables');
      const value = (await screen.findByLabelText('Value of region', {}, LONG)) as HTMLInputElement;
      expect(value.readOnly).toBe(false);
      expect((screen.getByLabelText('Key') as HTMLInputElement).readOnly).toBe(protectedOn);
      expect(screen.queryByRole('button', { name: 'Delete region' })).toBeNull();
      const user = userEvent.setup();
      await user.clear(value);
      await user.type(value, 'us');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(backend().variables[0]?.value).toBe('us'));
    });
  });

  it('a project Variables tab has the same split', async () => {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    const project = demo.createProject({ tenantId, name: 'Growth', type: 'team' });
    demo.variables.push({ id: 'v1', key: 'region', value: 'eu', projectId: project.id, tenantId });
    demo.setDemoProtected(true);
    renderApp(`/projects/${project.id}/variables`);
    const value = (await screen.findByLabelText('Value of region', {}, LONG)) as HTMLInputElement;
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Delete region' })).toBeNull();
    expect((screen.getByLabelText('Key') as HTMLInputElement).readOnly).toBe(true);
    expect(value.readOnly).toBe(false);
    const user = userEvent.setup();
    await user.clear(value);
    await user.type(value, 'us');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend().variables[0]?.value).toBe('us'));
  });
});

describe('a data table on a protected workspace', () => {
  async function openTable(protect: boolean) {
    const demo = signedIn();
    const table = await dataTablesApi.create({ name: 'Leads', columns: [{ name: 'name', type: 'string' }] });
    await dataTablesApi.insertRows(table.id, [{ name: 'Ann' }], 'count');
    demo.setDemoProtected(protect);
    renderApp(`/data-tables/${table.id}`);
    await screen.findByRole('grid', { name: 'Rows of Leads' }, LONG);
    await screen.findByRole('gridcell', { name: 'Ann' }, LONG);
  }

  it('offers no column change (Add column, Rename column), and rows stay editable', async () => {
    await openTable(true);
    await screen.findByRole('status', { name: /Protected workspace/ }, LONG);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add column' })).toBeNull(), LONG);
    expect(screen.getByRole('button', { name: 'Add row' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select row 1' })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Column menu for name' }));
    await screen.findByRole('menuitem', { name: 'Sort ascending' });
    expect(screen.queryByRole('menuitem', { name: 'Rename column' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete column' })).toBeNull();
  });

  it('keeps Add column and Rename column on a writable workspace', async () => {
    await openTable(false);
    expect(await screen.findByRole('button', { name: 'Add column' }, LONG)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Column menu for name' }));
    expect(await screen.findByRole('menuitem', { name: 'Rename column' })).toBeTruthy();
  });
});

describe('the sidebar lock', () => {
  it('shows the lock on a protected workspace', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    renderApp('/home/credentials');
    expect(await screen.findByRole('status', { name: /Protected workspace/ }, LONG)).toBeTruthy();
  });

  it('shows nothing on a writable workspace', async () => {
    signedIn();
    renderApp('/home/credentials');
    await screen.findByRole('navigation', { name: 'Projects' }, LONG);
    await screen.findByRole('button', { name: 'Add credential' }, LONG);
    expect(screen.queryByRole('status', { name: /Protected workspace/ })).toBeNull();
  });
});
