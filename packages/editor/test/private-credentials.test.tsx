/**
 * P6-15 private credentials in the editor: the type choice of a new OAuth credential (team project and
 * `credential:createEndUser` only), the saved credential's switch, connect and disconnect with the connected
 * count, the card state on the credentials page, the node credential row, the workflow card icon, the run
 * icon and the move dialog warning.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { CredentialModal } from '../src/components/credentials/CredentialModal';
import { NodeCredentials } from '../src/components/credentials/NodeCredentials';
import {
  PRIVATE_LABEL,
  PRIVATE_PERSONAL_REASON,
  PRIVATE_SCOPE_REASON,
} from '../src/components/credentials/PrivateCredentialSection';
import { MoveDialog, PRIVATE_MOVE_TEXT } from '../src/components/projects/MoveDialog';
import type { MockBackend } from '../src/demo/mock-backend';
import { useOpenWorkflowStore } from '../src/features/editor/open-resources';
import { useProjectStore } from '../src/stores/project-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const LONG = { timeout: 20_000 };

beforeEach(() => {
  useProjectStore.getState().setCurrentProject(null);
  useOpenWorkflowStore.getState().clear();
  useWorkflowStore.getState().reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  setCurrentTenant(null);
});

function setup() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const team = demo.oldestTeamProject(tenantId);
  return { demo, tenantId, team, userId: demo.auth().user.id };
}

function seedOAuth(demo: MockBackend, projectId: string, input: { id: string; name: string; isResolvable?: boolean }) {
  const at = new Date().toISOString();
  demo.credentials.push({
    id: input.id,
    tenantId: demo.auth().tenant.id,
    name: input.name,
    type: 'oAuth2Api',
    data: { clientId: 'client-1', authUrl: 'https://auth.example.com', scope: 'read' },
    createdAt: at,
    updatedAt: at,
    projectId,
    isGlobal: false,
    ...(input.isResolvable ? { isResolvable: true } : {}),
  });
}

const connectedAs = (demo: MockBackend, credentialId: string, ...userIds: string[]) =>
  demo.privateConnections.set(credentialId, new Set(userIds));

describe('a new OAuth credential', () => {
  it('in a team project the owner makes it private and the create sends isResolvable', async () => {
    const user = userEvent.setup();
    const { demo, team } = setup();
    useProjectStore.getState().setCurrentProject(team.id);
    withProviders(<CredentialModal open type="oAuth2Api" onClose={() => undefined} />);
    const toggle = await screen.findByRole('switch', { name: PRIVATE_LABEL }, LONG);
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(demo.requests.some((r) => r.method === 'POST' && r.path === '/credentials')).toBe(true));
    const create = demo.requests.find((r) => r.method === 'POST' && r.path === '/credentials');
    expect(create?.body).toMatchObject({ type: 'oAuth2Api', isResolvable: true, projectId: team.id });
    const saved = demo.credentials.find((c) => c.type === 'oAuth2Api');
    expect(saved?.isResolvable).toBe(true);
    // the saved credential shows its private part: not connected yet, nobody connected
    const section = await screen.findByRole('region', { name: PRIVATE_LABEL }, LONG);
    expect(await within(section).findByText('Not connected')).toBeTruthy();
    expect(within(section).getByText('0 users connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect my account' })).toBeTruthy();
  });

  it('is locked in a personal project and without credential:createEndUser; not offered for other types', async () => {
    const { demo, team } = setup();
    const { unmount } = withProviders(<CredentialModal open type="oAuth2Api" onClose={() => undefined} />);
    const personal = await screen.findByRole('switch', { name: PRIVATE_LABEL }, LONG);
    expect((personal as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(PRIVATE_PERSONAL_REASON)).toBeTruthy();
    unmount();

    // a project editor creates credentials there but holds no credential:createEndUser
    demo.setDemoRole('editor');
    useProjectStore.getState().setCurrentProject(team.id);
    const second = withProviders(<CredentialModal open type="oAuth2Api" onClose={() => undefined} />);
    expect(await screen.findByText(PRIVATE_SCOPE_REASON, {}, LONG)).toBeTruthy();
    expect((screen.getByRole('switch', { name: PRIVATE_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    second.unmount();

    withProviders(<CredentialModal open type="notionApi" onClose={() => undefined} />);
    await screen.findByRole('button', { name: 'Save' }, LONG);
    expect(screen.queryByRole('switch', { name: PRIVATE_LABEL })).toBeNull();
  });
});

describe('a saved private credential', () => {
  it('connects through POST /credentials/:id/authorize and disconnects the caller only', async () => {
    const user = userEvent.setup();
    const { demo, team, userId } = setup();
    seedOAuth(demo, team.id, { id: 'cred-private', name: 'Team mail', isResolvable: true });
    connectedAs(demo, 'cred-private', userId, 'someone-else');
    withProviders(<CredentialModal open credentialId="cred-private" onClose={() => undefined} />);
    const section = await screen.findByRole('region', { name: PRIVATE_LABEL }, LONG);
    expect(await within(section).findByText('Connected')).toBeTruthy();
    expect(within(section).getByText('2 users connected')).toBeTruthy();

    // the demo has no provider: the per user route answers after its own checks
    await user.click(screen.getByRole('button', { name: 'Reconnect my account' }));
    await waitFor(() =>
      expect(demo.requests.some((r) => r.method === 'POST' && r.path === '/credentials/cred-private/authorize')).toBe(
        true,
      ),
    );
    expect(demo.requests.some((r) => r.path === '/oauth2/authorize')).toBe(false);

    await user.click(within(section).getByRole('button', { name: 'Disconnect my account' }));
    await waitFor(() => expect(within(section).getByText('Not connected')).toBeTruthy());
    expect(within(section).getByText('1 user connected')).toBeTruthy();
    expect([...(demo.privateConnections.get('cred-private') ?? [])]).toEqual(['someone-else']);
  });

  it('switching back to one shared account asks first, then removes every connection', async () => {
    const user = userEvent.setup();
    const { demo, team, userId } = setup();
    seedOAuth(demo, team.id, { id: 'cred-private', name: 'Team mail', isResolvable: true });
    connectedAs(demo, 'cred-private', userId);
    withProviders(<CredentialModal open credentialId="cred-private" onClose={() => undefined} />);
    const toggle = await screen.findByRole('switch', { name: PRIVATE_LABEL }, LONG);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await user.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: 'Use one shared account?' }, LONG);
    await user.click(within(dialog).getByRole('button', { name: 'Remove connections' }));
    await waitFor(() => expect(demo.credentials.find((c) => c.id === 'cred-private')?.isResolvable).toBeUndefined());
    const patch = demo.requests.find((r) => r.method === 'PATCH' && r.path === '/credentials/cred-private');
    expect(patch?.body).toEqual({ isResolvable: false });
    expect(demo.privateConnections.has('cred-private')).toBe(false);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });
});

describe('private credentials on the other screens', () => {
  it('the credentials page shows the private state and the connected count', async () => {
    const { demo, team, userId } = setup();
    seedOAuth(demo, team.id, { id: 'cred-private', name: 'Team mail', isResolvable: true });
    seedOAuth(demo, team.id, { id: 'cred-fixed', name: 'Shared mail' });
    connectedAs(demo, 'cred-private', userId);
    renderApp('/credentials');
    const list = await screen.findByRole('region', { name: 'Credential list' }, LONG);
    const row = (await within(list).findByText('Team mail', {}, LONG)).closest('li')!;
    expect(within(row as HTMLElement).getByText('Private')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('Connected')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('1 user connected')).toBeTruthy();
    const fixed = within(list).getByText('Shared mail').closest('li')!;
    expect(within(fixed as HTMLElement).queryByText('Private')).toBeNull();
  });

  it('the node credential row tells the user to connect their own account', async () => {
    const { demo, team } = setup();
    seedOAuth(demo, team.id, { id: 'cred-private', name: 'Team mail', isResolvable: true });
    const wf = demo.seedWorkflow({ name: 'In team', projectId: team.id });
    const dto = demo.toDto(demo.workflow(wf.id));
    useWorkflowStore.getState().load(dto, { readOnly: false });
    useOpenWorkflowStore.getState().set(dto);
    const description: NodeTypeDescription = {
      name: 'test.mailer',
      displayName: 'Mailer',
      group: ['transform'],
      version: 1,
      description: '',
      defaults: { name: 'Mailer' },
      inputs: ['main'],
      outputs: ['main'],
      properties: [],
      credentials: [{ name: 'oAuth2Api', required: true }],
    };
    const node: WorkflowNode = {
      id: 'n',
      name: 'Mailer',
      type: description.name,
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
      credentials: { oAuth2Api: { id: 'cred-private', name: 'Team mail' } },
    };
    withProviders(<NodeCredentials node={node} description={description} readOnly={false} onChange={() => {}} />);
    const row = await screen.findByTestId('private-credential-row', {}, LONG);
    expect(within(row).getByText('Not connected')).toBeTruthy();
    expect(within(row).getByText('Connect your own account in the credential before you run this node.')).toBeTruthy();
  });

  it('a workflow card and a run show the private credentials icon', async () => {
    const { demo, team } = setup();
    seedOAuth(demo, team.id, { id: 'cred-private', name: 'Team mail', isResolvable: true });
    demo.seedWorkflow({
      name: 'Uses private',
      projectId: team.id,
      nodes: [
        {
          id: 'n1',
          name: 'Mailer',
          type: 'core.noOp',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
          credentials: { oAuth2Api: { id: 'cred-private', name: 'Team mail' } },
        },
      ],
      connections: {},
    });
    demo.seedWorkflow({ name: 'Plain', projectId: team.id });
    const { unmount } = renderApp('/workflows');
    expect(await screen.findByRole('img', { name: 'Uses private credentials' }, LONG)).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'Uses private credentials' })).toHaveLength(1);
    unmount();

    const wf = demo.seedWorkflow({ name: 'Runner', projectId: team.id, nodes: [], connections: {} });
    await demo.handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitFor(() => expect(demo.executions.filter((e) => e.status !== 'running')).toHaveLength(1));
    demo.executions[0].usedPrivateCredentials = true;
    renderApp('/executions');
    expect(
      await screen.findByRole('img', { name: 'Ran with the account of the user who started it' }, LONG),
    ).toBeTruthy();
  });

  it('the move dialog warns for a private credential and offers no personal project', async () => {
    const { demo, tenantId, team } = setup();
    demo.createProject({ tenantId, name: 'Beta team', type: 'team' });
    seedOAuth(demo, team.id, { id: 'cred-private', name: 'Team mail', isResolvable: true });
    withProviders(<MoveDialog resource="credential" id="cred-private" onClose={() => undefined} />);
    expect(await screen.findByText(PRIVATE_MOVE_TEXT, {}, LONG)).toBeTruthy();
    const select = screen.getByLabelText('Destination project');
    await waitFor(() => expect(within(select).queryByRole('option', { name: 'Beta team' })).toBeTruthy());
    expect(within(select).queryAllByRole('option').some((o) => /\(personal\)/.test(o.textContent ?? ''))).toBe(false);
    expect(backend()).toBe(demo);
  });
});
