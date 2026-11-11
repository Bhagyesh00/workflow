/**
 * P6-76 (L6): the Git push, pull, result and diff dialogs on the demo backend. A push with two picked files
 * sends exactly those (id, type); a pull with a conflict asks first; the result lists a delete; the remote
 * diff renders `WorkflowDiffSummary` over `diffWorkflows`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceControlApi, workflowsApi } from '../src/api/endpoints';
import type { PullResult, PushResult, SourceControlledFile } from '../src/api/types';
import { PullModal } from '../src/components/source-control/PullModal';
import { PullResultModal } from '../src/components/source-control/PullResultModal';
import { PushModal } from '../src/components/source-control/PushModal';
import { RemoteDiffDialog } from '../src/components/source-control/RemoteDiffDialog';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

const T = { timeout: 20_000 };

type Answer = { data?: any; error?: { code: string; message: string } };

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const res = await backend().handle({ method, path, body, query });
  return { status: res.status, body: res.body as Answer };
}

const trigger: WorkflowNode = {
  id: 't1',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

async function connect() {
  const res = await call('POST', '/source-control/preferences', {
    connectionType: 'https',
    repositoryUrl: 'https://git.example.test/team/flows.git',
    httpsUsername: 'bot',
    httpsPassword: 'tok-secret-1',
  });
  expect(res.status).toBe(200);
}

async function workflow(name: string): Promise<{ id: string; versionId: string }> {
  const res = await call('POST', '/workflows', { name, nodes: [trigger], connections: {} });
  expect(res.status).toBeLessThan(300);
  return res.body.data;
}

async function credential(name: string): Promise<{ id: string }> {
  const res = await call('POST', '/credentials', { name, type: 'httpBasicAuth', data: { user: 'u' } });
  expect(res.status).toBeLessThan(300);
  return res.body.data;
}

async function pushAll(): Promise<void> {
  const status = await call('GET', '/source-control/get-status', undefined, { direction: 'push' });
  const res = await call('POST', '/source-control/push-workfolder', {
    commitMessage: 'seed',
    fileNames: (status.body.data as SourceControlledFile[]).map((f) => ({ id: f.id, type: f.type })),
  });
  expect(res.status).toBe(200);
}

function bodies(path: string) {
  return backend().requests.filter((r) => r.method === 'POST' && r.path === path);
}

afterEach(() => vi.restoreAllMocks());

describe('PushModal', () => {
  it('lists the changed files by type; a push with two picked files sends exactly those (id, type)', async () => {
    signedIn();
    await connect();
    const alpha = await workflow('Alpha flow');
    await workflow('Beta flow');
    const cred = await credential('Gamma login');
    const user = userEvent.setup();
    const onPushed = vi.fn<(r: PushResult) => void>();
    withProviders(<PushModal open onClose={() => undefined} onPushed={onPushed} />);
    const dialog = await screen.findByRole('dialog', { name: 'Push to Git' }, T);
    expect(await within(dialog).findByText('Workflows', {}, T)).toBeTruthy();
    expect(within(dialog).getByText('Credentials')).toBeTruthy();
    const push = within(dialog).getByRole('button', { name: 'Push' }) as HTMLButtonElement;
    // nothing is picked and no message: off
    expect(push.disabled).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: /Alpha flow/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Gamma login/ }));
    expect(push.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Commit message'), 'Ship alpha and the login');
    expect(push.disabled).toBe(false);
    await user.click(push);
    await waitFor(() => expect(onPushed).toHaveBeenCalledTimes(1), T);
    const sent = bodies('/source-control/push-workfolder').at(-1)?.body as {
      commitMessage: string;
      fileNames: Array<{ id: string; type: string }>;
      force?: boolean;
    };
    expect(sent.commitMessage).toBe('Ship alpha and the login');
    expect(sent.fileNames).toEqual([
      { id: alpha.id, type: 'workflow' },
      { id: cred.id, type: 'credential' },
    ]);
    expect(onPushed.mock.calls[0][0].files).toHaveLength(2);
  });

  it('the filter narrows the list by name', async () => {
    signedIn();
    await connect();
    await workflow('Alpha flow');
    await workflow('Beta flow');
    const user = userEvent.setup();
    withProviders(<PushModal open onClose={() => undefined} onPushed={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Push to Git' }, T);
    await within(dialog).findByRole('checkbox', { name: /Alpha flow/ }, T);
    await user.type(within(dialog).getByLabelText('Filter files'), 'beta');
    expect(within(dialog).queryByRole('checkbox', { name: /Alpha flow/ })).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: /Beta flow/ })).toBeTruthy();
  });

  it('says so when nothing changed, and shows the server error on a refused push', async () => {
    signedIn();
    await connect();
    withProviders(<PushModal open onClose={() => undefined} onPushed={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Push to Git' }, T);
    expect(await within(dialog).findByText(/Nothing to push/, {}, T)).toBeTruthy();
  });

  it('a protected workspace shows the server refusal text', async () => {
    signedIn();
    await connect();
    await workflow('Alpha flow');
    await call('PATCH', '/source-control/preferences', { branchReadOnly: true });
    const user = userEvent.setup();
    withProviders(<PushModal open onClose={() => undefined} onPushed={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Push to Git' }, T);
    await user.click(await within(dialog).findByRole('checkbox', { name: /Alpha flow/ }, T));
    await user.type(within(dialog).getByLabelText('Commit message'), 'try');
    await user.click(within(dialog).getByRole('button', { name: 'Push' }));
    expect(await within(dialog).findByText('Cannot push onto read-only branch.', {}, T)).toBeTruthy();
  });

  it('View diff opens the remote diff of a modified workflow', async () => {
    signedIn();
    await connect();
    const wf = await workflow('Alpha flow');
    await pushAll();
    const extra: WorkflowNode = { ...trigger, id: 'n2', name: 'Extra step', type: 'core.noOp' };
    await call('PATCH', `/workflows/${wf.id}`, {
      versionId: wf.versionId,
      nodes: [trigger, extra],
      connections: {},
    });
    const user = userEvent.setup();
    withProviders(<PushModal open onClose={() => undefined} onPushed={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Push to Git' }, T);
    await within(dialog).findByRole('checkbox', { name: /Alpha flow/ }, T);
    await user.click(within(dialog).getByRole('button', { name: 'View diff of Alpha flow' }));
    const diff = await screen.findByRole('dialog', { name: /Alpha flow/ }, T);
    expect(await within(diff).findByText('Extra step', {}, T)).toBeTruthy();
  });
});

describe('PullModal', () => {
  it('lists the incoming changes; a clean pull sends no force', async () => {
    signedIn();
    await connect();
    const user = userEvent.setup();
    const onPulled = vi.fn<(r: PullResult) => void>();
    withProviders(<PullModal open onClose={() => undefined} onPulled={onPulled} />);
    const dialog = await screen.findByRole('dialog', { name: 'Pull from Git' }, T);
    expect(await within(dialog).findByText('Remote onboarding flow', {}, T)).toBeTruthy();
    expect(within(dialog).queryByText(/overwrite/i)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(onPulled).toHaveBeenCalledTimes(1), T);
    const sent = bodies('/source-control/pull-workfolder').at(-1)?.body as { force?: boolean };
    expect(sent.force ?? false).toBe(false);
    expect(onPulled.mock.calls[0][0].files.some((f) => f.status === 'deleted')).toBe(true);
  });

  it('a conflict asks first: nothing is pulled until "Pull and override" is confirmed', async () => {
    signedIn();
    await connect();
    const wf = await workflow('Alpha flow');
    await pushAll();
    await call('PATCH', `/workflows/${wf.id}`, { versionId: wf.versionId, name: 'Alpha flow edited' });
    const user = userEvent.setup();
    const onPulled = vi.fn<(r: PullResult) => void>();
    withProviders(<PullModal open onClose={() => undefined} onPulled={onPulled} />);
    const dialog = await screen.findByRole('dialog', { name: 'Pull from Git' }, T);
    expect(await within(dialog).findByText('1 conflict', {}, T)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Pull' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Pull and override' }));
    const confirm = await screen.findByRole('dialog', { name: /Override local changes/ }, T);
    expect(bodies('/source-control/pull-workfolder')).toHaveLength(0);
    // cancel keeps everything as it was
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(
      () => expect(screen.queryByRole('dialog', { name: /Override local changes/ })).toBeNull(),
      T,
    );
    expect(bodies('/source-control/pull-workfolder')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Pull and override' }));
    const again = await screen.findByRole('dialog', { name: /Override local changes/ }, T);
    await user.click(within(again).getByRole('button', { name: 'Pull and override' }));
    await waitFor(() => expect(onPulled).toHaveBeenCalledTimes(1), T);
    const last = bodies('/source-control/pull-workfolder').at(-1);
    expect((last?.body as { force?: boolean } | undefined)?.force).toBe(true);
  });
});

describe('PullResultModal', () => {
  const result: PullResult = {
    files: [
      {
        file: 'workflows/a.json',
        id: 'a',
        name: 'Fresh flow',
        type: 'workflow',
        status: 'created',
        location: 'remote',
        conflict: false,
        updatedAt: '2026-11-11T10:00:00.000Z',
      },
      {
        file: 'workflows/b.json',
        id: 'b',
        name: 'Changed flow',
        type: 'workflow',
        status: 'modified',
        location: 'remote',
        conflict: false,
        updatedAt: '2026-11-11T10:00:00.000Z',
      },
      {
        file: 'workflows/c.json',
        id: 'c',
        name: 'Retired flow',
        type: 'workflow',
        status: 'deleted',
        location: 'remote',
        conflict: false,
        updatedAt: '2026-11-11T10:00:00.000Z',
      },
    ],
    publishingErrors: [{ id: 'b', name: 'Changed flow', message: 'Webhook path is taken' }],
    contentImportPolicy: [
      { id: 'd', name: 'Blocked flow', violations: ['Node type core.executeCommand is blocked'] },
    ],
  };

  it('lists created, updated, deleted, publishing errors and content policy skips', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    withProviders(<PullResultModal result={result} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Pull finished' }, T);
    const created = within(dialog).getByRole('region', { name: 'Created' });
    expect(within(created).getByText('Fresh flow')).toBeTruthy();
    const updated = within(dialog).getByRole('region', { name: 'Updated' });
    expect(within(updated).getByText('Changed flow')).toBeTruthy();
    const deleted = within(dialog).getByRole('region', { name: 'Deleted' });
    expect(within(deleted).getByText('Retired flow')).toBeTruthy();
    const errors = within(dialog).getByRole('region', { name: 'Publishing errors' });
    expect(within(errors).getByText(/Webhook path is taken/)).toBeTruthy();
    const skipped = within(dialog).getByRole('region', { name: 'Skipped by the content policy' });
    expect(within(skipped).getByText('Blocked flow')).toBeTruthy();
    expect(within(skipped).getByText(/core.executeCommand is blocked/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing while there is no result', () => {
    withProviders(<PullResultModal result={null} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('RemoteDiffDialog', () => {
  it('renders the workflow diff against the remote copy', async () => {
    signedIn();
    await connect();
    const wf = await workflow('Alpha flow');
    await pushAll();
    const extra: WorkflowNode = { ...trigger, id: 'n2', name: 'Extra step', type: 'core.noOp' };
    await call('PATCH', `/workflows/${wf.id}`, {
      versionId: wf.versionId,
      nodes: [trigger, extra],
      connections: {},
    });
    const file: SourceControlledFile = {
      file: `workflows/${wf.id}.json`,
      id: wf.id,
      name: 'Alpha flow',
      type: 'workflow',
      status: 'modified',
      location: 'local',
      conflict: true,
      updatedAt: '2026-11-11T10:00:00.000Z',
    };
    const onClose = vi.fn();
    withProviders(<RemoteDiffDialog file={file} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: /Alpha flow/ }, T);
    expect(await within(dialog).findByText('Extra step', {}, T)).toBeTruthy();
    expect(within(dialog).getByText('Adds')).toBeTruthy();
  });

  it('reads the local copy by the id the remote answer names when the git id differs', async () => {
    signedIn();
    await connect();
    const wf = await workflow('Pulled flow');
    await pushAll();
    const extra: WorkflowNode = { ...trigger, id: 'n2', name: 'Extra step', type: 'core.noOp' };
    await call('PATCH', `/workflows/${wf.id}`, {
      versionId: wf.versionId,
      nodes: [trigger, extra],
      connections: {},
    });
    const gitId = '11111111-2222-4333-8444-555555555555';
    // like the server: a git id that maps to a local id answers with the local id
    const original = sourceControlApi.remoteContent.bind(sourceControlApi);
    const remoteSpy = vi.spyOn(sourceControlApi, 'remoteContent').mockImplementation(async (type, id) => ({
      ...(await original(type, wf.id)),
      id: id === gitId ? wf.id : id,
    }));
    const localSpy = vi.spyOn(workflowsApi, 'get');
    const file: SourceControlledFile = {
      file: `workflows/${gitId}.json`,
      id: gitId,
      name: 'Pulled flow',
      type: 'workflow',
      status: 'modified',
      location: 'local',
      conflict: true,
      updatedAt: '2026-11-11T10:00:00.000Z',
    };
    withProviders(<RemoteDiffDialog file={file} onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: /Pulled flow/ }, T);
    expect(await within(dialog).findByText('Extra step', {}, T)).toBeTruthy();
    expect(remoteSpy).toHaveBeenCalledWith('workflow', gitId);
    expect(localSpy).toHaveBeenCalledWith(wf.id);
    expect(localSpy).not.toHaveBeenCalledWith(gitId);
    remoteSpy.mockRestore();
    localSpy.mockRestore();
  });

  it('says so when the workflow is not on the remote yet', async () => {
    signedIn();
    await connect();
    const wf = await workflow('Brand new');
    const file: SourceControlledFile = {
      file: `workflows/${wf.id}.json`,
      id: wf.id,
      name: 'Brand new',
      type: 'workflow',
      status: 'new',
      location: 'local',
      conflict: false,
      updatedAt: '2026-11-11T10:00:00.000Z',
    };
    withProviders(<RemoteDiffDialog file={file} onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: /Brand new/ }, T);
    expect(await within(dialog).findByText(/not on the remote yet/, {}, T)).toBeTruthy();
  });

  it('renders nothing while no file is set', () => {
    withProviders(<RemoteDiffDialog file={null} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
