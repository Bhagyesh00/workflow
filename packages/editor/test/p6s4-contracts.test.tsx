/**
 * Phase 6 S4 C0 contracts (C0e and C0f): the Environments link shows for an admin and hides for a member;
 * `/settings/environments` renders; `useProtectedWorkspace` follows the demo's `setDemoProtected` (GET /settings
 * `sourceControl.readOnly`); the moved variables page and the project Variables tab render as before; the API key
 * form lists the three source control scopes; the builder panel and the Assistant page still render with their
 * slots mounted; and every demo `/source-control/*` route is registered. Stubs (501, null) are the lanes' and
 * are not asserted beyond being registered and mounted.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../src/api/queries';
import type { Settings } from '../src/api/types';
import { ApiKeyScopesField } from '../src/components/settings/ApiKeyScopesField';
import { MockBackend } from '../src/demo/mock-backend';
import { useProtectedWorkspace } from '../src/lib/protected';
import { VARIABLE_KEY, VariableRow, VariablesSettingsPage } from '../src/pages/SettingsPages';
import * as moved from '../src/pages/settings/VariablesSettingsPage';
import { useAssistantStore } from '../src/stores/assistant-store';
import { useBuilderStore } from '../src/stores/builder-store';
import { backend, signedIn } from './backend';
import { renderApp, testQueryClient, withProviders } from './utils';

const T = { timeout: 20_000 };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function call(method: Method, path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return {
    status: res.status,
    body: res.body as { data?: unknown; error?: { code: string; message: string } },
  };
}

const trigger: WorkflowNode = {
  id: 't1',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

function Probe() {
  return <p>{useProtectedWorkspace() ? 'protected' : 'writable'}</p>;
}

afterEach(() => {
  vi.restoreAllMocks();
  useBuilderStore.getState().reset();
  useAssistantStore.getState().reset();
});

describe('Environments link and route', () => {
  it('shows the Environments link to an admin and hides it from a member', async () => {
    signedIn().setDemoRole('admin');
    const first = renderApp('/settings/account');
    const link = await screen.findByRole('link', { name: 'Environments' }, T);
    expect(link.getAttribute('href')).toBe('/settings/environments');
    first.unmount();
    backend().setDemoRole('member');
    renderApp('/settings/account');
    await screen.findByRole('link', { name: 'API keys' }, T);
    // the role has loaded once the account page shows it
    await screen.findAllByText('member', {}, T);
    expect(screen.queryByRole('link', { name: 'Environments' })).toBeNull();
  });

  it('/settings/environments renders in the settings layout', async () => {
    signedIn();
    renderApp('/settings/environments');
    expect(await screen.findByRole('heading', { name: 'Settings' }, T)).toBeTruthy();
    expect(screen.queryByText('This page does not exist')).toBeNull();
  });
});

describe('protected flag (demo FULL, lib/protected.ts)', () => {
  it('useProtectedWorkspace follows setDemoProtected', async () => {
    signedIn();
    const queryClient = testQueryClient();
    withProviders(<Probe />, queryClient);
    expect(await screen.findByText('writable', {}, T)).toBeTruthy();
    backend().setDemoProtected(true);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.settings }));
    expect(await screen.findByText('protected', {}, T)).toBeTruthy();
    backend().setDemoProtected(false);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.settings }));
    expect(await screen.findByText('writable', {}, T)).toBeTruthy();
  });

  it('GET /settings answers sourceControl.readOnly from the signed-in workspace; false signed out', async () => {
    const demo = signedIn();
    expect(demo.isDemoProtected()).toBe(false);
    let res = await call('GET', '/settings');
    expect((res.body.data as Settings).sourceControl).toEqual({ readOnly: false });
    demo.setDemoProtected(true);
    expect(demo.isDemoProtected()).toBe(true);
    res = await call('GET', '/settings');
    expect((res.body.data as Settings).sourceControl).toEqual({ readOnly: true });
    demo.session = null;
    res = await call('GET', '/settings');
    expect((res.body.data as Settings).sourceControl).toEqual({ readOnly: false });
  });

  it('acts on one workspace only, the first membership when signed out', () => {
    const demo = new MockBackend();
    demo.createAccount({ email: 'a@example.com', password: 'secret-pass-1', name: 'A', workspaceName: 'A' });
    demo.createAccount({ email: 'b@example.com', password: 'secret-pass-1', name: 'B', workspaceName: 'B' });
    demo.session = null;
    demo.setDemoProtected(true);
    expect(demo.isDemoProtected()).toBe(true);
    demo.signIn('a@example.com');
    expect(demo.isDemoProtected()).toBe(true);
    demo.signIn('b@example.com');
    expect(demo.isDemoProtected()).toBe(false);
  });
});

describe('variables page moved, project Variables tab', () => {
  it('re-exports the moved names from SettingsPages', () => {
    expect(VariableRow).toBe(moved.VariableRow);
    expect(VariablesSettingsPage).toBe(moved.VariablesSettingsPage);
    expect(VARIABLE_KEY.test('region_1')).toBe(true);
    expect(VARIABLE_KEY.test('1region')).toBe(false);
  });

  it('the workspace page and the project tab render their variables as before', async () => {
    const demo = signedIn();
    const tenantId = demo.auth().tenant.id;
    const project = demo.createProject({ tenantId, name: 'Growth', type: 'team' });
    demo.variables.push(
      { id: 'v1', key: 'inproject', value: '1', projectId: project.id, tenantId },
      { id: 'v2', key: 'inworkspace', value: '2', tenantId },
    );
    const page = renderApp('/settings/variables');
    expect(await screen.findByLabelText('Value of inworkspace', {}, T)).toBeTruthy();
    expect(screen.queryByLabelText('Value of inproject')).toBeNull();
    page.unmount();
    renderApp(`/projects/${project.id}/variables`);
    expect(await screen.findByLabelText('Value of inproject', {}, T)).toBeTruthy();
  });
});

describe('API key scopes', () => {
  it('lists the three source control scopes', () => {
    render(<ApiKeyScopesField value={['sourceControl:pull']} onChange={vi.fn()} />);
    for (const scope of ['sourceControl:pull', 'sourceControl:push', 'sourceControl:read'])
      expect(screen.getByRole('checkbox', { name: scope })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'sourceControl:pull' }) as HTMLInputElement).checked).toBe(
      true,
    );
    const group = screen.getByRole('group', { name: 'Source control' });
    // the group's own select-all box plus one box per scope
    const scopes = within(group)
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('aria-label') ?? box.closest('label')?.textContent ?? '')
      .filter((name) => name.startsWith('sourceControl:'));
    expect(scopes).toEqual(['sourceControl:pull', 'sourceControl:push', 'sourceControl:read']);
  });
});

describe('builder panel and Assistant page with the ProtectedNotice slots', () => {
  it('the builder panel still renders, protected or not', async () => {
    const demo = signedIn();
    demo.setDemoProtected(true);
    const wf = demo.seedWorkflow({ name: 'Leads', nodes: [trigger], connections: {} });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, T);
    const user = userEvent.setup();
    const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' }, T);
    await user.click(entry);
    const panel = await screen.findByRole('complementary', { name: 'AI builder' }, T);
    expect(within(panel).getByRole('textbox', { name: 'Message the AI builder' })).toBeTruthy();
  });

  it('the Assistant page still renders its composer', async () => {
    signedIn();
    renderApp('/assistant');
    expect(await screen.findByRole('textbox', { name: 'Message' }, T)).toBeTruthy();
    expect(screen.queryByText('This page does not exist')).toBeNull();
  });
});

describe('demo /source-control/* routes (stub, L6)', () => {
  it('registers every REST path (501 until L6, never 404)', async () => {
    signedIn();
    const paths: Array<[Method, string]> = [
      ['GET', '/source-control/preferences'],
      ['POST', '/source-control/preferences'],
      ['PATCH', '/source-control/preferences'],
      ['POST', '/source-control/disconnect'],
      ['GET', '/source-control/get-branches'],
      ['POST', '/source-control/generate-key-pair'],
      ['GET', '/source-control/get-status?direction=push'],
      ['GET', '/source-control/status'],
      ['POST', '/source-control/push-workfolder'],
      ['POST', '/source-control/pull-workfolder'],
      ['GET', '/source-control/remote-content/workflow/w1'],
    ];
    for (const [method, path] of paths)
      expect((await call(method, path)).status, `${method} ${path}`).not.toBe(404);
  });
});
