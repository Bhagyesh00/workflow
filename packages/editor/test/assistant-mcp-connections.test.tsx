/**
 * P5-72 Settings > Assistant > MCP servers: an admin lists, adds, edits, switches off and deletes the
 * outside MCP servers the Assistant can use; the address must be https (or http on localhost); the sign-in
 * method decides which credential can be chosen; a tool setting only tightens; a member below admin sees the
 * list and no buttons; the answers hold a credential id and never a secret; the demo server refuses what
 * the real one refuses.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { assistantApi, credentialsApi } from '../src/api/endpoints';
import type { Role } from '../src/api/types';
import { AssistantMcpConnections } from '../src/components/settings/AssistantMcpConnections';
import { ConfirmHost } from '../src/components/ui/Dialog';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const WAIT = { timeout: 5000 };
const TOKEN = 'bearer-token-that-must-stay-secret-123';

afterEach(() => setCurrentTenant(null));

function as(role: Role) {
  const mock = signedIn();
  mock.setDemoRole(role);
  setCurrentTenant(mock.session!.tenantId);
  return mock;
}

function sent(method: string, path: string) {
  return backend().requests.filter((r) => r.method === method && r.path.split('?')[0] === path);
}

/** opens Settings > Assistant with MCP access on */
async function openPage() {
  await assistantApi.patchSettings({ mcpAccessEnabled: true });
  const view = renderApp('/settings/assistant');
  await screen.findByText('MCP servers the Assistant can use', undefined, WAIT);
  return view;
}

describe('Settings > Assistant > MCP servers', () => {
  it('says so when there are none, and shows the list only while MCP access is on', async () => {
    as('admin');
    const view = renderApp('/settings/assistant');
    await screen.findByRole('switch', { name: 'Let the Assistant use MCP servers' }, WAIT);
    expect(screen.queryByText('MCP servers the Assistant can use')).toBeNull();
    view.unmount();

    await openPage();
    expect(await screen.findByText('No MCP servers yet', undefined, WAIT)).toBeTruthy();
    expect(screen.getByText(/not this app's own MCP server/)).toBeTruthy();
  });

  it('adds a server with a bearer credential and lists it with the credential id only', async () => {
    const user = userEvent.setup();
    as('admin');
    const bearer = await credentialsApi.create({
      name: 'Files token',
      type: 'httpBearerAuth',
      data: { token: TOKEN },
    });
    await credentialsApi.create({
      name: 'Wrong type',
      type: 'httpHeaderAuth',
      data: { name: 'x', value: 'y' },
    });
    await openPage();

    await user.click(await screen.findByRole('button', { name: 'Add server' }, WAIT));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/), 'Files');
    await user.type(within(dialog).getByLabelText(/^Address/), 'https://mcp.example.com/mcp');
    // no credential field while the sign-in is None
    expect(within(dialog).queryByLabelText(/^Credential/)).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText('Sign in with'), 'bearerAuth');
    const credential = within(dialog).getByLabelText(/^Credential/);
    // only credentials of the matching type are offered
    expect(within(credential as HTMLElement).queryByRole('option', { name: 'Wrong type' })).toBeNull();
    await user.selectOptions(credential, bearer.id);
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));

    expect(await screen.findByText('MCP server added', undefined, WAIT)).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Configured MCP servers' });
    expect(within(list).getByText('Files')).toBeTruthy();
    expect(within(list).getByText('https://mcp.example.com/mcp')).toBeTruthy();
    expect(within(list).getByText('Bearer token')).toBeTruthy();
    expect(sent('POST', '/assistant/mcp-connections')[0].body).toEqual({
      name: 'Files',
      url: 'https://mcp.example.com/mcp',
      transport: 'httpStreamable',
      authentication: 'bearerAuth',
      credentialId: bearer.id,
      enabled: true,
      toolPermissions: {},
    });
    const stored = await assistantApi.mcpConnections();
    expect(stored[0].credentialId).toBe(bearer.id);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('checks the address and the credential before sending, and shows the server refusal', async () => {
    const user = userEvent.setup();
    as('admin');
    await assistantApi.createMcpConnection({ name: 'Taken', url: 'https://taken.example.com/mcp' });
    await openPage();
    const posts = () => sent('POST', '/assistant/mcp-connections').length;
    const before = posts();

    await user.click(await screen.findByRole('button', { name: 'Add server' }, WAIT));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/), 'Docs');
    await user.type(within(dialog).getByLabelText(/^Address/), 'http://example.com/mcp');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(await within(dialog).findByText(/Use an https address/)).toBeTruthy();
    expect(posts()).toBe(before);

    // localhost over http is fine
    const address = within(dialog).getByLabelText(/^Address/);
    await user.clear(address);
    await user.type(address, 'http://localhost:4000/mcp');
    await user.selectOptions(within(dialog).getByLabelText('Sign in with'), 'headerAuth');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(await within(dialog).findByText('Choose the credential this server signs in with')).toBeTruthy();
    expect(posts()).toBe(before);

    // the server's own refusal (a name used twice) reaches the person
    await user.selectOptions(within(dialog).getByLabelText('Sign in with'), 'none');
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Taken');
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(await screen.findByText("Couldn't save the MCP server", undefined, WAIT)).toBeTruthy();
    expect(screen.getByText(/already exists/)).toBeTruthy();
    expect(posts()).toBe(before + 1);
  });

  it('edits a server: a new name, the transport and a tool setting that blocks one tool', async () => {
    const user = userEvent.setup();
    as('admin');
    await assistantApi.createMcpConnection({ name: 'Old name', url: 'https://old.example.com/mcp' });
    await openPage();

    await user.click(await screen.findByRole('button', { name: 'Edit Old name' }, WAIT));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'New name');
    await user.selectOptions(within(dialog).getByLabelText('Transport'), 'sse');
    await user.click(within(dialog).getByRole('button', { name: 'Add a tool setting' }));
    await user.type(within(dialog).getByLabelText('Tool name'), 'delete_everything');
    await user.selectOptions(within(dialog).getByLabelText('Tool mode'), 'blocked');
    // a tool setting offers no way to loosen
    expect(
      within(within(dialog).getByLabelText('Tool mode')).queryByRole('option', { name: 'Always allow' }),
    ).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('MCP server saved', undefined, WAIT)).toBeTruthy();
    const patch = sent(
      'PATCH',
      `/assistant/mcp-connections/${(await assistantApi.mcpConnections())[0].id}`,
    )[0];
    expect(patch.body).toMatchObject({
      name: 'New name',
      transport: 'sse',
      toolPermissions: { delete_everything: 'blocked' },
    });
    const list = await screen.findByRole('list', { name: 'Configured MCP servers' });
    expect(within(list).getByText('New name')).toBeTruthy();
    expect(within(list).getByText('SSE')).toBeTruthy();
    expect(within(list).getByText('1 tool settings')).toBeTruthy();
  });

  it('switches a server off and on without opening the form', async () => {
    const user = userEvent.setup();
    as('admin');
    const created = await assistantApi.createMcpConnection({
      name: 'Files',
      url: 'https://f.example.com/mcp',
    });
    await openPage();
    const toggle = await screen.findByRole('switch', { name: 'Use Files' }, WAIT);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    await waitFor(
      () =>
        expect(screen.getByRole('switch', { name: 'Use Files' }).getAttribute('aria-checked')).toBe('false'),
      WAIT,
    );
    expect(sent('PATCH', `/assistant/mcp-connections/${created.id}`)[0].body).toEqual({ enabled: false });
    await user.click(screen.getByRole('switch', { name: 'Use Files' }));
    await waitFor(
      () =>
        expect(screen.getByRole('switch', { name: 'Use Files' }).getAttribute('aria-checked')).toBe('true'),
      WAIT,
    );
  });

  it('deletes a server after asking', async () => {
    const user = userEvent.setup();
    as('admin');
    const created = await assistantApi.createMcpConnection({
      name: 'Files',
      url: 'https://f.example.com/mcp',
    });
    await openPage();

    await user.click(await screen.findByRole('button', { name: 'Delete Files' }, WAIT));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Files?' }, WAIT);
    // cancel first: nothing is sent
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(sent('DELETE', `/assistant/mcp-connections/${created.id}`)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete Files' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete Files?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(await screen.findByText('MCP server deleted', undefined, WAIT)).toBeTruthy();
    expect(sent('DELETE', `/assistant/mcp-connections/${created.id}`)).toHaveLength(1);
    expect(await screen.findByText('No MCP servers yet', undefined, WAIT)).toBeTruthy();
  });

  it.each(['editor', 'viewer'] as const)('shows %s the list and none of the buttons', async (role) => {
    const mock = as('admin');
    await assistantApi.createMcpConnection({ name: 'Files', url: 'https://f.example.com/mcp' });
    mock.setDemoRole(role);
    withProviders(
      <>
        <AssistantMcpConnections />
        <ConfirmHost />
      </>,
    );
    expect(await screen.findByText('Files', undefined, WAIT)).toBeTruthy();
    expect(await screen.findByText('Only an admin can change these servers.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add server' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Files' })).toBeNull();
    expect((screen.getByRole('switch', { name: 'Use Files' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the demo server refuses what the real one refuses', async () => {
    as('admin');
    const bearer = await credentialsApi.create({
      name: 'Token',
      type: 'httpBearerAuth',
      data: { token: 'x' },
    });
    const header = await credentialsApi.create({
      name: 'Header',
      type: 'httpHeaderAuth',
      data: { name: 'a', value: 'b' },
    });
    const url = 'https://mcp.example.com/mcp';
    await expect(
      assistantApi.createMcpConnection({ name: 'A', url: 'http://example.com/mcp' }),
    ).rejects.toThrow(/https/);
    await expect(
      assistantApi.createMcpConnection({ name: 'A', url: 'http://localhost.evil.com/mcp' }),
    ).rejects.toThrow(/https/);
    await expect(
      assistantApi.createMcpConnection({ name: 'A', url, authentication: 'bearerAuth' }),
    ).rejects.toThrow(/credential/i);
    await expect(
      assistantApi.createMcpConnection({
        name: 'A',
        url,
        authentication: 'bearerAuth',
        credentialId: header.id,
      }),
    ).rejects.toThrow(/httpBearerAuth/);
    await expect(
      assistantApi.createMcpConnection({ name: 'A', url, authentication: 'none', credentialId: bearer.id }),
    ).rejects.toThrow();
    const ok = await assistantApi.createMcpConnection({
      name: 'A',
      url,
      authentication: 'bearerAuth',
      credentialId: bearer.id,
    });
    await expect(assistantApi.createMcpConnection({ name: 'A', url })).rejects.toThrow(/already exists/);
    await expect(
      assistantApi.patchMcpConnection(ok.id, { toolPermissions: { t: 'always_allow' as 'blocked' } }),
    ).rejects.toThrow(/tighten/);
    await expect(assistantApi.deleteMcpConnection('missing')).rejects.toThrow(/not found/i);
    expect(await assistantApi.deleteMcpConnection(ok.id)).toEqual({ ok: true });
  });

  it('the demo server keeps each workspace to its own list and refuses a write below admin', async () => {
    const mock = as('admin');
    await assistantApi.createMcpConnection({ name: 'Mine', url: 'https://mine.example.com/mcp' });
    mock.setDemoRole('editor');
    await expect(
      assistantApi.createMcpConnection({ name: 'B', url: 'https://b.example.com/mcp' }),
    ).rejects.toThrow();
    expect((await assistantApi.mcpConnections()).map((c) => c.name)).toEqual(['Mine']);
  });
});
