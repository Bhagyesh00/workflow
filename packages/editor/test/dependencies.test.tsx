/**
 * P6-86: "Used by" counts and details. One batched POST per kind per page (ids within one tick, duplicates
 * removed, at most 100 ids); the pill replaces the table-only one and keeps its label; the details popover;
 * the delete warnings (credential, data table, folder); the header menu entry; the unpublish dialog; the move
 * dialog; the credential sharing dialog.
 */
import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { dataTablesApi, dependenciesApi, foldersApi, workflowsApi } from '../src/api/endpoints';
import { fetchDependencyCounts } from '../src/api/queries';
import { DependencyDialogsHost } from '../src/components/dependencies/DependencyDialogsHost';
import { DependencyPill } from '../src/components/dependencies/DependencyPill';
import { ProjectDialogsHost } from '../src/components/projects/ProjectDialogsHost';
import { ShareDialog } from '../src/components/projects/ShareDialog';
import { ConfirmHost } from '../src/components/ui/Dialog';
import { DeleteFolderDialog } from '../src/components/workflow/FolderDialog';
import { MoveToFolderDialog } from '../src/components/workflow/MoveToFolderDialog';
import { unpublishWorkflow } from '../src/features/editor/publish-actions';
import {
  confirmUnpublish,
  openDependencyDetails,
  useDependencyDialogStore,
} from '../src/stores/dependency-dialog-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { type backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

configure({ asyncUtilTimeout: 20_000 });

beforeEach(() => useDependencyDialogStore.setState({ request: null }));
afterEach(() => {
  setCurrentTenant(null);
  vi.restoreAllMocks();
});

const node = (type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}) =>
  ({
    id: `n-${type}`,
    name: type,
    type,
    typeVersion: 1,
    position: [0, 0],
    parameters,
    ...extra,
  }) as WorkflowNode;
const callNode = (workflowId: string) =>
  node('core.executeWorkflow', {
    source: 'database',
    workflowId: { __rl: true, mode: 'id', value: workflowId },
  });
const credNode = (credentialId: string) =>
  node('core.httpRequest', {}, { credentials: { testApi: { id: credentialId, name: 'c' } } });

function seedCredential(demo: ReturnType<typeof backend>, projectId: string, id = 'cred-1') {
  const at = new Date().toISOString();
  demo.credentials.push({
    id,
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

function setup() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const project = demo.oldestTeamProject(tenantId);
  return { demo, tenantId, project };
}

/** a component under a memory router (the details rows navigate) */
function inRouter(ui: React.ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: ['/start'] });
  const utils = withProviders(<RouterProvider router={router} />);
  return { ...utils, router };
}

describe('counts batching', () => {
  it('sends one POST per kind for the ids asked in one tick, duplicates once, 100 ids at most', async () => {
    setup();
    const spy = vi.spyOn(dependenciesApi, 'counts');
    const ids = Array.from({ length: 130 }, (_, i) => `wf-${i}`);
    await Promise.all([...ids, 'wf-0', 'wf-1'].map((id) => fetchDependencyCounts('workflow', id)));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(([kind, sent]) => [kind, sent.length])).toEqual([
      ['workflow', 100],
      ['workflow', 30],
    ]);
    expect(new Set(spy.mock.calls.flatMap(([, sent]) => sent)).size).toBe(130);
  });

  it('a page of pills makes one counts call per kind', async () => {
    const { demo, project } = setup();
    seedCredential(demo, project.id, 'c1');
    seedCredential(demo, project.id, 'c2');
    demo.seedWorkflow({ name: 'Uses c1', nodes: [credNode('c1')], projectId: project.id });
    const spy = vi.spyOn(dependenciesApi, 'counts');
    inRouter(
      <>
        <DependencyPill kind="credential" id="c1" />
        <DependencyPill kind="credential" id="c2" />
        <DependencyPill kind="credential" id="c1" />
      </>,
    );
    expect(await screen.findAllByRole('button', { name: 'Used by 1 workflow' })).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1].sort()).toEqual(['c1', 'c2']);
  });
});

describe('pill and details', () => {
  it('shows the count of a credential and lists the workflows in the popover; a row opens the workflow', async () => {
    const { demo, project } = setup();
    seedCredential(demo, project.id);
    const one = demo.seedWorkflow({ name: 'Mailer', nodes: [credNode('cred-1')], projectId: project.id });
    demo.seedWorkflow({ name: 'Reporter', nodes: [credNode('cred-1')], projectId: project.id });
    demo.seedWorkflow({ name: 'Unrelated', projectId: project.id });
    const { router } = inRouter(<DependencyPill kind="credential" id="cred-1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Used by 2 workflows' }));
    expect(await screen.findByRole('menuitem', { name: 'Reporter' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Unrelated' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Mailer' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflow/${one.id}`));
  });

  it('shows nothing when nothing uses the resource', async () => {
    const { demo, project } = setup();
    seedCredential(demo, project.id);
    const spy = vi.spyOn(dependenciesApi, 'counts');
    const { container } = inRouter(<DependencyPill kind="credential" id="cred-1" />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await act(async () => {});
    expect(container.querySelector('button')).toBeNull();
  });

  it('a workflow pill counts the callers and the workflows that name it as their error workflow', async () => {
    const { demo, project } = setup();
    const sub = demo.seedWorkflow({ name: 'Sub', projectId: project.id });
    demo.seedWorkflow({ name: 'Caller', nodes: [callNode(sub.id)], projectId: project.id });
    demo.seedWorkflow({ name: 'Watched', settings: { errorWorkflow: sub.id }, projectId: project.id });
    inRouter(<DependencyPill kind="workflow" id={sub.id} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Used by 2 workflows' }));
    const menu = await screen.findByRole('menu', { name: 'Dependencies' });
    expect(within(menu).getByRole('group', { name: 'Called by workflows' })).toBeTruthy();
    expect(within(menu).getByRole('group', { name: 'Error workflow of' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Caller' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Watched' })).toBeTruthy();
  });

  it('the data table list shows the table pill with its old label', async () => {
    const { demo, project } = setup();
    const table = await dataTablesApi.create({ name: 'Leads', columns: [] });
    demo.seedWorkflow({
      name: 'Uses leads',
      nodes: [node('core.dataTable', { dataTableId: { __rl: true, mode: 'id', value: table.id } })],
      projectId: project.id,
    });
    renderApp('/data-tables');
    expect(await screen.findByRole('button', { name: 'Used by 1 workflow' })).toBeTruthy();
  });
});

describe('delete warnings', () => {
  it('a credential delete lists the workflows that use it', async () => {
    const { demo, project } = setup();
    seedCredential(demo, project.id);
    demo.seedWorkflow({ name: 'Mailer', nodes: [credNode('cred-1')], projectId: project.id });
    renderApp('/home/credentials');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Shared key' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: /Delete .Shared key.\?/ });
    expect(await within(dialog).findByText('Used by 1 workflow')).toBeTruthy();
    expect(within(dialog).getByText('Mailer')).toBeTruthy();
  });

  it('a credential nothing uses deletes with the plain warning', async () => {
    const { demo, project } = setup();
    seedCredential(demo, project.id);
    renderApp('/home/credentials');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Shared key' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: /Delete .Shared key.\?/ });
    expect(within(dialog).queryByText(/^Used by/)).toBeNull();
    expect(within(dialog).getByText(/Workflows that use it will fail/)).toBeTruthy();
  });

  it('a data table delete lists the workflows that use it', async () => {
    const { demo, project } = setup();
    const table = await dataTablesApi.create({ name: 'Leads', columns: [] });
    demo.seedWorkflow({
      name: 'Uses leads',
      nodes: [node('core.dataTable', { dataTableId: { __rl: true, mode: 'name', value: 'Leads' } })],
      projectId: project.id,
    });
    renderApp(`/data-tables/${table.id}`);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Used by 1 workflow' });
    await user.click(await screen.findByRole('button', { name: 'Actions for Leads' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete data table' });
    expect(await within(dialog).findByText('Uses leads')).toBeTruthy();
  });

  it('a folder delete warns about the tree workflows other workflows use, more strongly when they are archived', async () => {
    const { demo, project } = setup();
    const folder = await foldersApi.create({ name: 'Shared', parentFolderId: null });
    const inside = demo.seedWorkflow({ name: 'Inside', folderId: folder.id, projectId: project.id });
    demo.seedWorkflow({ name: 'Outside', nodes: [callNode(inside.id)], projectId: project.id });
    withProviders(<DeleteFolderDialog open folder={folder} onClose={() => {}} />);
    const user = userEvent.setup();
    expect(await screen.findByText(/keep working after the move/)).toBeTruthy();
    expect(screen.getByText('Inside, used by Outside')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /Archive/ }));
    expect(await screen.findByText(/They stop working correctly/)).toBeTruthy();
  });
});

describe('header menu and dialogs', () => {
  it('the editor header menu opens the dependencies of the workflow', async () => {
    const { demo, project } = setup();
    const sub = demo.seedWorkflow({ name: 'Sub flow', projectId: project.id });
    demo.seedWorkflow({ name: 'Caller', nodes: [callNode(sub.id)], projectId: project.id });
    renderApp(`/workflow/${sub.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Dependencies' }));
    const dialog = await screen.findByRole('dialog', { name: /Dependencies of .Sub flow./ });
    expect(await within(dialog).findByRole('menuitem', { name: 'Caller' })).toBeTruthy();
  });

  it('the details dialog says when nothing uses the workflow', async () => {
    const { demo, project } = setup();
    const lonely = demo.seedWorkflow({ name: 'Lonely', projectId: project.id });
    withProviders(<DependencyDialogsHost />);
    act(() => openDependencyDetails('workflow', lonely.id, 'Lonely'));
    expect(await screen.findByText('Nothing uses it yet.')).toBeTruthy();
  });

  it('unpublish asks first when a published workflow depends on it; Cancel keeps it published', async () => {
    const { demo, project } = setup();
    const sub = demo.seedWorkflow({ name: 'Sub', active: true, projectId: project.id });
    demo.seedWorkflow({
      name: 'Live caller',
      active: true,
      nodes: [callNode(sub.id)],
      projectId: project.id,
    });
    demo.seedWorkflow({
      name: 'Draft caller',
      active: false,
      nodes: [callNode(sub.id)],
      projectId: project.id,
    });
    useWorkflowStore.getState().load({ id: sub.id, name: 'Sub', nodes: [], connections: {} });
    const deactivate = vi.spyOn(workflowsApi, 'deactivate');
    withProviders(<DependencyDialogsHost />);
    const user = userEvent.setup();
    const result = unpublishWorkflow({} as never);
    const dialog = await screen.findByRole('dialog', { name: /Unpublish .Sub.\?/ });
    expect(within(dialog).getByText('Live caller')).toBeTruthy();
    expect(within(dialog).queryByText('Draft caller')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await result).toBe(false);
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('unpublish goes ahead after Unpublish is chosen, and with no dependents it asks nothing', async () => {
    const { demo, project } = setup();
    const sub = demo.seedWorkflow({ name: 'Sub', active: true, projectId: project.id });
    demo.seedWorkflow({
      name: 'Live caller',
      active: true,
      nodes: [callNode(sub.id)],
      projectId: project.id,
    });
    const alone = demo.seedWorkflow({ name: 'Alone', active: true, projectId: project.id });
    const deactivate = vi.spyOn(workflowsApi, 'deactivate');
    withProviders(<DependencyDialogsHost />);
    const user = userEvent.setup();

    useWorkflowStore.getState().load({ id: sub.id, name: 'Sub', nodes: [], connections: {} });
    const first = unpublishWorkflow({} as never);
    await user.click(await screen.findByRole('button', { name: 'Unpublish' }));
    expect(await first).toBe(true);
    expect(deactivate).toHaveBeenCalledWith(sub.id);

    useWorkflowStore.getState().load({ id: alone.id, name: 'Alone', nodes: [], connections: {} });
    expect(await unpublishWorkflow({} as never)).toBe(true);
    expect(screen.queryByRole('dialog', { name: /Unpublish/ })).toBeNull();
  });

  it('closing the unpublish dialog answers false', async () => {
    setup();
    withProviders(<DependencyDialogsHost />);
    const answer = confirmUnpublish('w1', 'W', [
      {
        key: 'workflowParent',
        id: 'p',
        name: 'Parent',
        resourceType: 'workflow',
        projectId: null,
        active: true,
      },
    ]);
    await screen.findByRole('dialog', { name: /Unpublish .W.\?/ });
    act(() => useDependencyDialogStore.getState().close());
    expect(await answer).toBe(false);
  });
});

describe('move dialog and credential sharing', () => {
  it('the move dialog tells that the callers keep working', async () => {
    const { demo, project } = setup();
    const sub = demo.seedWorkflow({ name: 'Sub', projectId: project.id });
    demo.seedWorkflow({ name: 'Caller', nodes: [callNode(sub.id)], projectId: project.id });
    withProviders(
      <MoveToFolderDialog
        open
        target={{ kind: 'workflow', ids: [sub.id], name: 'Sub', folderId: null, projectId: project.id }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText('They keep working after the move.')).toBeTruthy();
    expect(screen.getByText('Caller')).toBeTruthy();
  });

  it('the credential sharing dialog lists the workflows that use the credential', async () => {
    const { demo, project } = setup();
    seedCredential(demo, project.id);
    demo.seedWorkflow({ name: 'Mailer', nodes: [credNode('cred-1')], projectId: project.id });
    inRouter(
      <>
        <ProjectDialogsHost />
        <ConfirmHost />
        <ShareDialog resource="credential" id="cred-1" onClose={() => {}} />
      </>,
    );
    const dialog = await screen.findByRole('dialog', { name: /Share Shared key/ });
    expect(await within(dialog).findByRole('menuitem', { name: 'Mailer' })).toBeTruthy();
    expect(within(dialog).getByText(/lose access to this credential/)).toBeTruthy();
  });
});

describe('the endpoints', () => {
  it('refuses 101 ids', async () => {
    setup();
    const ids = Array.from({ length: 101 }, (_, i) => `r-${i}`);
    await expect(dependenciesApi.counts('workflow', ids)).rejects.toMatchObject({ status: 400 });
  });
});
