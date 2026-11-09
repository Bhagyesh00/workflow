/**
 * P6-44: the Share dialog. A project picker sends the full list of project ids; the home project is not
 * offered; a personal credential without `credential:share` shows "Sharing is disabled in personal
 * spaces..." (`info.personalSpaceRestricted`); `credential:shareGlobally` adds the share with all users
 * control; the dialog opens from `openProjectDialog` through `ProjectDialogsHost`.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { sharingApi } from '../src/api/endpoints';
import { ProjectDialogsHost } from '../src/components/projects/ProjectDialogsHost';
import { ShareDialog } from '../src/components/projects/ShareDialog';
import type { MockBackend } from '../src/demo/mock-backend';
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
  const gamma = demo.createProject({ tenantId, name: 'Gamma team', type: 'team' });
  const wf = demo.seedWorkflow({ name: 'Alpha flow', projectId: alpha.id });
  return { demo, tenantId, alpha, beta, gamma, wf };
}

function seedCredential(demo: MockBackend, projectId: string, id = 'cred-1') {
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

const projectBoxes = async () => {
  const group = await screen.findByRole('group', { name: 'Projects' }, LONG);
  return within(group);
};

describe('ShareDialog', () => {
  it('shares a workflow with the picked projects and not with its home project', async () => {
    const { demo, alpha, beta, gamma, wf } = setup();
    const onClose = vi.fn();
    withProviders(<ShareDialog resource="workflow" id={wf.id} onClose={onClose} />);
    const boxes = await projectBoxes();
    await waitFor(() => expect(boxes.getAllByRole('checkbox').length).toBeGreaterThan(0));
    expect(boxes.queryByLabelText(alpha.name)).toBeNull();
    const user = userEvent.setup();
    await user.click(boxes.getByLabelText('Beta team'));
    await user.click(boxes.getByLabelText('Gamma team'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    const shares = demoShares(demo).filter((s) => s.resourceId === wf.id);
    expect(shares.map((s) => s.projectId).sort()).toEqual([beta.id, gamma.id].sort());
    expect(shares.every((s) => s.role === 'workflow:editor')).toBe(true);
  });

  it('Save stays off until something changes, and the full list goes to the server', async () => {
    const { demo, tenantId, beta, gamma, wf } = setup();
    demoShares(demo).push({
      tenantId,
      resourceType: 'workflow',
      resourceId: wf.id,
      projectId: beta.id,
      role: 'workflow:editor',
    });
    const spy = vi.spyOn(sharingApi, 'shareWorkflow');
    withProviders(<ShareDialog resource="workflow" id={wf.id} onClose={() => {}} />);
    const boxes = await projectBoxes();
    await waitFor(() => expect((boxes.getByLabelText('Beta team') as HTMLInputElement).checked).toBe(true));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(boxes.getByLabelText('Gamma team'));
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(wf.id, [beta.id, gamma.id]), LONG);
  });

  it('unticking a project removes the share', async () => {
    const { demo, tenantId, beta, wf } = setup();
    demoShares(demo).push({
      tenantId,
      resourceType: 'workflow',
      resourceId: wf.id,
      projectId: beta.id,
      role: 'workflow:editor',
    });
    const onClose = vi.fn();
    withProviders(<ShareDialog resource="workflow" id={wf.id} onClose={onClose} />);
    const boxes = await projectBoxes();
    const user = userEvent.setup();
    await waitFor(() => expect((boxes.getByLabelText('Beta team') as HTMLInputElement).checked).toBe(true));
    await user.click(boxes.getByLabelText('Beta team'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    expect(demoShares(demo).filter((s) => s.resourceId === wf.id)).toEqual([]);
  });

  it('says that moving removes the sharing', async () => {
    const { wf } = setup();
    withProviders(<ShareDialog resource="workflow" id={wf.id} onClose={() => {}} />);
    expect(await screen.findByText(/Moving will remove any existing sharing/, {}, LONG)).toBeTruthy();
  });

  it('shares a credential with a project as credential:user', async () => {
    const { demo, alpha, beta } = setup();
    seedCredential(demo, alpha.id);
    const onClose = vi.fn();
    withProviders(<ShareDialog resource="credential" id="cred-1" onClose={onClose} />);
    const boxes = await projectBoxes();
    const user = userEvent.setup();
    await waitFor(() => expect(boxes.getAllByRole('checkbox').length).toBeGreaterThan(0));
    await user.click(boxes.getByLabelText('Beta team'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    expect(demoShares(demo).filter((s) => s.resourceId === 'cred-1')).toMatchObject([
      { projectId: beta.id, role: 'credential:user' },
    ]);
  });
});

describe('personal spaces', () => {
  /** a true member whose personal project holds a credential; the workspace turned personal sharing off */
  async function personalMember(sharing: boolean) {
    const { demo, tenantId } = setup();
    const me = demo.auth().user;
    const personal = demo.personalProject(tenantId, me.id);
    seedCredential(demo, personal.id);
    if (!sharing)
      await demo.handle({
        method: 'POST',
        path: '/settings/security',
        body: { personalSpaceSharing: false },
      });
    demo.setDemoRole('member');
    return { demo, personal };
  }

  it('shows "Sharing is disabled in personal spaces" and no picker when sharing is off', async () => {
    await personalMember(false);
    withProviders(<ShareDialog resource="credential" id="cred-1" onClose={() => {}} />);
    expect(await screen.findByText(/Sharing is disabled in personal spaces\./, {}, LONG)).toBeTruthy();
    expect(screen.getByText(/Move the credential to a team project/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Projects' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('switch', { name: 'Share with all users' })).toBeNull();
  });

  it('offers the picker when personal sharing is on', async () => {
    await personalMember(true);
    withProviders(<ShareDialog resource="credential" id="cred-1" onClose={() => {}} />);
    expect(await projectBoxes()).toBeTruthy();
    expect(screen.queryByText(/Sharing is disabled in personal spaces/)).toBeNull();
  });
});

describe('share with all users', () => {
  it('a holder of credential:shareGlobally flips the switch and the credential becomes global', async () => {
    const { demo, alpha } = setup();
    seedCredential(demo, alpha.id);
    const onClose = vi.fn();
    withProviders(<ShareDialog resource="credential" id="cred-1" onClose={onClose} />);
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: 'Share with all users' }, LONG);
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), LONG);
    expect(demo.credentials.find((c) => c.id === 'cred-1')?.isGlobal).toBe(true);
  });

  it('a project admin without credential:shareGlobally has the picker and no switch', async () => {
    const { demo, tenantId, alpha } = setup();
    seedCredential(demo, alpha.id);
    demo.projectRelations.push({
      tenantId,
      projectId: alpha.id,
      userId: demo.auth().user.id,
      role: 'project:admin',
    });
    demo.setDemoRole('member');
    withProviders(<ShareDialog resource="credential" id="cred-1" onClose={() => {}} />);
    expect(await projectBoxes()).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Share with all users' })).toBeNull();
  });

  it('a global credential disables the project picker', async () => {
    const { demo, alpha } = setup();
    seedCredential(demo, alpha.id);
    demo.credentials[0].isGlobal = true;
    withProviders(<ShareDialog resource="credential" id="cred-1" onClose={() => {}} />);
    const boxes = await projectBoxes();
    await waitFor(() => expect(boxes.getAllByRole('checkbox').length).toBeGreaterThan(0));
    expect(boxes.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).disabled)).toBe(true);
    expect(
      (screen.getByRole('switch', { name: 'Share with all users' }) as HTMLButtonElement).getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
  });
});

describe('ProjectDialogsHost', () => {
  it('renders the Share dialog openProjectDialog asked for, and nothing after it closes', async () => {
    const { wf } = setup();
    withProviders(<ProjectDialogsHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openProjectDialog({ kind: 'share', resource: 'workflow', id: wf.id }));
    expect(await screen.findByRole('dialog', {}, LONG)).toBeTruthy();
    expect(await screen.findByRole('group', { name: 'Projects' }, LONG)).toBeTruthy();
    act(() => closeProjectDialog());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
