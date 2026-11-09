/**
 * P6-44: the Move dialog. A destination project, the preview (restricted and unpublish lists), credential
 * picks that share into the destination, "Moving will remove any existing sharing"; a move works from the
 * dialog for a workflow, a credential and a folder (with its tree).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { transferApi } from '../src/api/endpoints';
import { MoveDialog } from '../src/components/projects/MoveDialog';
import { ProjectDialogsHost } from '../src/components/projects/ProjectDialogsHost';
import type { MockBackend } from '../src/demo/mock-backend';
import { folderState } from '../src/demo/mock-folders';
import { demoShares } from '../src/demo/mock-sharing';
import { closeProjectDialog, openProjectDialog } from '../src/stores/project-dialog-store';
import { signedIn } from './backend';
import { withProviders } from './utils';

const LONG = { timeout: 20_000 };

beforeEach(() => closeProjectDialog());
afterEach(() => {
  setCurrentTenant(null);
  vi.restoreAllMocks();
});

function setup() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const alpha = demo.defaultProjectFor(tenantId);
  const beta = demo.createProject({ tenantId, name: 'Beta team', type: 'team' });
  return { demo, tenantId, alpha, beta };
}

function seedCredential(demo: MockBackend, projectId: string, id: string, name: string) {
  const at = new Date().toISOString();
  demo.credentials.push({
    id,
    tenantId: demo.auth().tenant.id,
    name,
    type: 'testAiApi',
    data: {},
    createdAt: at,
    updatedAt: at,
    projectId,
    isGlobal: false,
  });
}

const node = (credId?: string) => ({
  id: 'n1',
  name: 'Ask',
  type: 'core.noOp',
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters: {},
  ...(credId ? { credentials: { testAiApi: { id: credId, name: 'Key' } } } : {}),
});

async function pick(name: string) {
  const select = await screen.findByLabelText('Destination project', {}, LONG);
  await waitFor(() => expect(within(select).queryByRole('option', { name })).toBeTruthy());
  await userEvent.setup().selectOptions(select, name);
}

const moveButton = () => screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement;

describe('MoveDialog for a workflow', () => {
  it('lists the other projects, warns about sharing and moves the workflow', async () => {
    const { demo, tenantId, alpha, beta } = setup();
    const wf = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id });
    demoShares(demo).push({
      tenantId,
      resourceType: 'workflow',
      resourceId: wf.id,
      projectId: beta.id,
      role: 'workflow:editor',
    });
    const onClose = vi.fn();
    withProviders(<MoveDialog resource="workflow" id={wf.id} onClose={onClose} />);
    expect(await screen.findByText(/Moving will remove any existing sharing/, {}, LONG)).toBeTruthy();
    const select = await screen.findByLabelText('Destination project', {}, LONG);
    await waitFor(() => expect(within(select).queryByRole('option', { name: 'Beta team' })).toBeTruthy());
    expect(within(select).queryByRole('option', { name: alpha.name })).toBeNull();
    expect(moveButton().disabled).toBe(true);
    await pick('Beta team');
    await waitFor(() => expect(moveButton().disabled).toBe(false), LONG);
    await userEvent.setup().click(moveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    expect(demo.workflows.find((w) => w.id === wf.id)?.projectId).toBe(beta.id);
    expect(demoShares(demo).filter((s) => s.resourceId === wf.id)).toEqual([]);
  });

  it('offers the credentials the workflow uses and shares the ticked ones into the destination', async () => {
    const { demo, alpha, beta } = setup();
    seedCredential(demo, alpha.id, 'c-used', 'Used key');
    seedCredential(demo, alpha.id, 'c-other', 'Other key');
    const wf = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id, nodes: [node('c-used')] });
    const onClose = vi.fn();
    withProviders(<MoveDialog resource="workflow" id={wf.id} onClose={onClose} />);
    await pick('Beta team');
    const group = await screen.findByRole('group', { name: 'Credentials to share' }, LONG);
    expect(within(group).queryByLabelText('Other key')).toBeNull();
    await userEvent.setup().click(within(group).getByLabelText('Used key'));
    await userEvent.setup().click(moveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    expect(demoShares(demo).filter((s) => s.resourceType === 'credential')).toMatchObject([
      { resourceId: 'c-used', projectId: beta.id, role: 'credential:user' },
    ]);
    expect(demo.workflows.find((w) => w.id === wf.id)?.projectId).toBe(beta.id);
  });

  it('sends the picks in the body and none when nothing is ticked', async () => {
    const { demo, alpha, beta } = setup();
    seedCredential(demo, alpha.id, 'c-used', 'Used key');
    const wf = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id, nodes: [node('c-used')] });
    const spy = vi.spyOn(transferApi, 'transferWorkflow');
    withProviders(<MoveDialog resource="workflow" id={wf.id} onClose={() => {}} />);
    await pick('Beta team');
    await screen.findByRole('group', { name: 'Credentials to share' }, LONG);
    await userEvent.setup().click(moveButton());
    await waitFor(() => expect(spy).toHaveBeenCalledWith(wf.id, { destinationProjectId: beta.id }), LONG);
  });

  it('lists why the move unpublishes the workflow, and why the destination refuses it', async () => {
    const { demo, alpha } = setup();
    const wf = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id });
    vi.spyOn(transferApi, 'previewWorkflow').mockResolvedValue({
      restricted: [{ kind: 'nodeType', checkId: 'nodes', message: 'Node HTTP Request is not allowed' }],
      checkFailed: true,
      unpublishReasons: [{ kind: 'publish', checkId: 'publish', message: 'Publishing is turned off there' }],
    });
    withProviders(<MoveDialog resource="workflow" id={wf.id} onClose={() => {}} />);
    await pick('Beta team');
    const preview = await screen.findByTestId('move-preview', {}, LONG);
    expect(within(preview).getByText('Node HTTP Request is not allowed')).toBeTruthy();
    expect(within(preview).getByText('This workflow will be unpublished')).toBeTruthy();
    expect(within(preview).getByText('Publishing is turned off there')).toBeTruthy();
    expect(within(preview).getByText(/Couldn't check every rule/)).toBeTruthy();
    expect(moveButton().disabled).toBe(true);
  });

  it('unpublish alone does not stop the move, and the demo unpublishes it in a personal space without publishing', async () => {
    const { demo, tenantId, alpha } = setup();
    const me = demo.auth().user;
    const personal = demo.personalProject(tenantId, me.id);
    await demo.handle({
      method: 'POST',
      path: '/settings/security',
      body: { personalSpacePublishing: false },
    });
    const wf = demo.seedWorkflow({ name: 'Live flow', projectId: alpha.id });
    const stored = demo.workflows.find((w) => w.id === wf.id);
    if (!stored) throw new Error('workflow not stored');
    stored.active = true;
    stored.publishedVersionId = stored.versionId;
    demo.projectRelations.push({ tenantId, projectId: alpha.id, userId: me.id, role: 'project:admin' });
    demo.setDemoRole('member');
    const onClose = vi.fn();
    withProviders(<MoveDialog resource="workflow" id={wf.id} onClose={onClose} />);
    await pick(`${personal.name} (personal)`);
    expect(await screen.findByText('Publishing is disabled in personal spaces.', {}, LONG)).toBeTruthy();
    await waitFor(() => expect(moveButton().disabled).toBe(false));
    await userEvent.setup().click(moveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    const moved = demo.workflows.find((w) => w.id === wf.id);
    expect(moved?.projectId).toBe(personal.id);
    expect(moved?.active).toBe(false);
    expect(moved?.publishedVersionId).toBeNull();
  });

  it('a project viewer sees no way to move', async () => {
    const { demo, tenantId, alpha } = setup();
    const wf = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id });
    demo.projectRelations.push({
      tenantId,
      projectId: alpha.id,
      userId: demo.auth().user.id,
      role: 'project:viewer',
    });
    demo.setDemoRole('member');
    withProviders(<MoveDialog resource="workflow" id={wf.id} onClose={() => {}} />);
    expect(await screen.findByText(/don't have permission to move this workflow/, {}, LONG)).toBeTruthy();
    expect(moveButton().disabled).toBe(true);
  });
});

describe('MoveDialog for a credential', () => {
  it('moves it, drops its shares and has no credential picks', async () => {
    const { demo, tenantId, alpha, beta } = setup();
    const gamma = demo.createProject({ tenantId, name: 'Gamma team', type: 'team' });
    seedCredential(demo, alpha.id, 'cred-1', 'Shared key');
    demoShares(demo).push({
      tenantId,
      resourceType: 'credential',
      resourceId: 'cred-1',
      projectId: gamma.id,
      role: 'credential:user',
    });
    const onClose = vi.fn();
    withProviders(<MoveDialog resource="credential" id="cred-1" onClose={onClose} />);
    await pick('Beta team');
    await waitFor(() => expect(moveButton().disabled).toBe(false), LONG);
    expect(screen.queryByRole('group', { name: 'Credentials to share' })).toBeNull();
    await userEvent.setup().click(moveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    expect(demo.credentials.find((c) => c.id === 'cred-1')?.projectId).toBe(beta.id);
    expect(demoShares(demo).filter((s) => s.resourceId === 'cred-1')).toEqual([]);
  });
});

describe('MoveDialog for a folder', () => {
  it('moves the folder with the workflows and folders inside it, and lists what it unpublishes', async () => {
    const { demo, tenantId, alpha, beta } = setup();
    const at = new Date().toISOString();
    folderState(demo).folders.push(
      {
        id: 'f-top',
        tenantId,
        name: 'Top',
        parentFolderId: null,
        projectId: alpha.id,
        tagIds: [],
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'f-sub',
        tenantId,
        name: 'Sub',
        parentFolderId: 'f-top',
        projectId: alpha.id,
        tagIds: [],
        createdAt: at,
        updatedAt: at,
      },
    );
    const inSub = demo.seedWorkflow({ name: 'Deep flow', projectId: alpha.id, folderId: 'f-sub' });
    vi.spyOn(transferApi, 'previewFolder').mockResolvedValue({
      restricted: [],
      checkFailed: false,
      workflowsToUnpublish: [{ id: inSub.id, name: 'Deep flow' }],
    });
    const onClose = vi.fn();
    withProviders(<MoveDialog resource="folder" id="f-top" onClose={onClose} />);
    await pick('Beta team');
    const preview = await screen.findByTestId('move-preview', {}, LONG);
    expect(within(preview).getByText('These workflows will be unpublished')).toBeTruthy();
    expect(within(preview).getByText('Deep flow')).toBeTruthy();
    await userEvent.setup().click(moveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    expect(folderState(demo).folders.map((f) => f.projectId)).toEqual([beta.id, beta.id]);
    expect(demo.workflows.find((w) => w.id === inSub.id)?.projectId).toBe(beta.id);
  });
});

describe('ProjectDialogsHost', () => {
  it('renders the Move dialog openProjectDialog asked for', async () => {
    const { demo, alpha } = setup();
    const wf = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id });
    withProviders(<ProjectDialogsHost />);
    act(() => openProjectDialog({ kind: 'move', resource: 'workflow', id: wf.id }));
    expect(await screen.findByLabelText('Destination project', {}, LONG)).toBeTruthy();
    act(() => closeProjectDialog());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renders nothing for a folder share, which n8n does not have', async () => {
    setup();
    withProviders(<ProjectDialogsHost />);
    act(() => openProjectDialog({ kind: 'share', resource: 'folder', id: 'f-1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
