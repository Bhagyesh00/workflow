/**
 * P6-43: pickers work inside a project. The node credential picker lists the credentials the open
 * workflow's project may use (its own, shared to it, global), and option, list and mapper calls name the
 * saved workflow, else the working project (the personal project on `/home/*`); the demo refuses a call that
 * names neither, as the server does after P6-27.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeTypesApi } from '../src/api/endpoints';
import { NodeCredentials } from '../src/components/credentials/NodeCredentials';
import { kitchenSink } from '../src/demo/fixtures';
import type { MockBackend } from '../src/demo/mock-backend';
import { demoShares } from '../src/demo/mock-sharing';
import { useOpenWorkflowStore } from '../src/features/editor/open-resources';
import { useProjectStore } from '../src/stores/project-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderParameters, withProviders } from './utils';

const LONG = { timeout: 20_000 };

const description: NodeTypeDescription = {
  name: 'test.notionLike',
  displayName: 'Notion Like',
  group: ['transform'],
  version: 1,
  description: '',
  defaults: { name: 'Notion Like' },
  inputs: ['main'],
  outputs: ['main'],
  properties: [],
  credentials: [{ name: 'notionApi', required: true }],
};

const node: WorkflowNode = {
  id: 'n',
  name: 'Notion',
  type: description.name,
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

beforeEach(() => {
  useProjectStore.getState().setCurrentProject(null);
  useOpenWorkflowStore.getState().clear();
  useWorkflowStore.getState().reset();
});
afterEach(() => vi.restoreAllMocks());

function credential(demo: MockBackend, name: string, projectId: string, isGlobal = false) {
  const at = new Date().toISOString();
  const id = `cred-${name}`;
  demo.credentials.push({
    id,
    tenantId: demo.auth().tenant.id,
    name,
    type: 'notionApi',
    data: {},
    createdAt: at,
    updatedAt: at,
    projectId,
    isGlobal,
  });
  return id;
}

function openWorkflow(demo: MockBackend, projectId: string) {
  const wf = demo.seedWorkflow({ name: `In ${projectId}`, projectId });
  const dto = demo.toDto(demo.workflow(wf.id));
  useWorkflowStore.getState().load(dto, { readOnly: false });
  useOpenWorkflowStore.getState().set(dto);
  return dto;
}

const optionNames = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('node credential picker', () => {
  function setup() {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    const alpha = demo.defaultProjectFor(tenantId);
    const beta = demo.createProject({ tenantId, name: 'Beta team', type: 'team' });
    credential(demo, 'Alpha key', alpha.id);
    credential(demo, 'Beta key', beta.id);
    const shared = credential(demo, 'Shared into Alpha', beta.id);
    credential(demo, 'Global key', beta.id, true);
    demoShares(demo).push({
      tenantId,
      resourceType: 'credential',
      resourceId: shared,
      projectId: alpha.id,
      role: 'credential:user',
    });
    return { demo, alpha, beta };
  }

  it('lists the open workflow project credentials: own, shared to it and global, not another project’s', async () => {
    const { demo, alpha } = setup();
    openWorkflow(demo, alpha.id);
    withProviders(
      <NodeCredentials node={node} description={description} readOnly={false} onChange={() => {}} />,
    );
    const select = await screen.findByRole('combobox', {}, LONG);
    await waitFor(() => expect(optionNames(select)).toContain('Alpha key'), LONG);
    expect(optionNames(select)).toEqual(
      expect.arrayContaining(['Alpha key', 'Shared into Alpha', 'Global key']),
    );
    expect(optionNames(select)).not.toContain('Beta key');
  });

  it('follows the workflow: a workflow of the other project lists that project’s credentials', async () => {
    const { demo, beta } = setup();
    openWorkflow(demo, beta.id);
    withProviders(
      <NodeCredentials node={node} description={description} readOnly={false} onChange={() => {}} />,
    );
    const select = await screen.findByRole('combobox', {}, LONG);
    await waitFor(() => expect(optionNames(select)).toContain('Beta key'), LONG);
    expect(optionNames(select)).toEqual(
      expect.arrayContaining(['Beta key', 'Shared into Alpha', 'Global key']),
    );
    expect(optionNames(select)).not.toContain('Alpha key');
  });

  it('a new workflow lists the project page’s credentials', async () => {
    const { alpha } = setup();
    useProjectStore.getState().setCurrentProject(alpha.id);
    withProviders(
      <NodeCredentials node={node} description={description} readOnly={false} onChange={() => {}} />,
    );
    const select = await screen.findByRole('combobox', {}, LONG);
    await waitFor(() => expect(optionNames(select)).toContain('Alpha key'), LONG);
    expect(optionNames(select)).not.toContain('Beta key');
  });

  async function asMemberIn(role: string) {
    const { demo, alpha } = setup();
    demo.projectRelations.push({
      tenantId: demo.auth().tenant.id,
      projectId: alpha.id,
      userId: demo.auth().user.id,
      role,
    });
    demo.setDemoRole('member');
    openWorkflow(demo, alpha.id);
    withProviders(
      <NodeCredentials node={node} description={description} readOnly={false} onChange={() => {}} />,
    );
    return screen.findByRole('combobox', {}, LONG);
  }

  it('offers Create new credential where the project role may create', async () => {
    const select = await asMemberIn('project:editor');
    await waitFor(() => expect(optionNames(select)).toContain('+ Create new credential'), LONG);
  });

  it('offers no Create new credential to a project viewer', async () => {
    const select = await asMemberIn('project:viewer');
    await waitFor(() => expect(optionNames(select)).toContain('Select notionApi…'), LONG);
    // let the project load, then check the entry is still absent
    await waitFor(
      () => expect(backend().requests.some((r) => r.path.startsWith('/projects/'))).toBe(true),
      LONG,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(optionNames(select)).not.toContain('+ Create new credential');
  });
});

describe('option and list calls', () => {
  it('a saved workflow is named by its id', async () => {
    const demo = signedIn();
    const dto = openWorkflow(demo, demo.defaultProjectFor(demo.auth().tenant.id).id);
    const spy = vi.spyOn(nodeTypesApi, 'loadOptions');
    renderParameters(kitchenSink, { parameters: { resource: 'deal' } });
    await waitFor(() => expect(spy).toHaveBeenCalled(), LONG);
    expect(spy.mock.calls[0][0]).toMatchObject({ workflowId: dto.id });
    expect(spy.mock.calls[0][0].projectId).toBeUndefined();
  });

  it('with no saved workflow the call names the project page’s project', async () => {
    const demo = signedIn();
    const team = demo.defaultProjectFor(demo.auth().tenant.id);
    useProjectStore.getState().setCurrentProject(team.id);
    const spy = vi.spyOn(nodeTypesApi, 'loadOptions');
    renderParameters(kitchenSink, { parameters: { resource: 'deal' } });
    await waitFor(() => expect(spy).toHaveBeenCalled(), LONG);
    expect(spy.mock.calls[0][0]).toMatchObject({ projectId: team.id });
    expect(spy.mock.calls[0][0].workflowId).toBeUndefined();
  });

  it('on Overview (no project page) the call names the personal project', async () => {
    const demo = signedIn();
    const personal = demo.personalProject(demo.auth().tenant.id, demo.auth().user.id);
    const spy = vi.spyOn(nodeTypesApi, 'loadOptions');
    renderParameters(kitchenSink, { parameters: { resource: 'deal' } });
    await waitFor(() => expect(spy).toHaveBeenCalled(), LONG);
    expect(spy.mock.calls[0][0]).toMatchObject({ projectId: personal.id });
  });

  it('the demo refuses a call that names neither a workflow nor a project, and an unknown project', async () => {
    signedIn();
    const body = { nodeType: 'app.crm', method: 'getPipelines', kind: 'loadOptions', node: {} };
    const neither = await backend().handle({ method: 'POST', path: '/node-types/options', body });
    expect(neither.status).toBe(400);
    const unknown = await backend().handle({
      method: 'POST',
      path: '/node-types/options',
      body: { ...body, projectId: 'nope' },
    });
    expect(unknown.status).toBe(404);
    const team = backend().defaultProjectFor(backend().auth().tenant.id);
    const named = await backend().handle({
      method: 'POST',
      path: '/node-types/options',
      body: { ...body, projectId: team.id },
    });
    expect(named.status).toBe(200);
  });
});
