/**
 * P5-71 Settings > Assistant: an admin sets a model and the page says when none is set; a member sees the
 * Assistant link only after that; below admin the page only says who can change it; the 22-row permission
 * table offers Always allow on three rows only, with the MCP read note; search, MCP access, data sharing and
 * on/off save with PATCH /assistant/settings; the demo server refuses what the real one refuses.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ASSISTANT_PERMISSION_KEYS } from '@workflow/workflow';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { assistantApi, credentialsApi, settingsApi } from '../src/api/endpoints';
import type { AssistantSettingsDTO, Role } from '../src/api/types';
import { ASSISTANT_PERMISSION_ROW_KEYS, MCP_READ_NOTE } from '../src/pages/AssistantSettingsPage';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

const WAIT = { timeout: 5000 };

afterEach(() => setCurrentTenant(null));

function as(role: Role) {
  const mock = signedIn();
  mock.memberships[0].role = role;
  setCurrentTenant(mock.session!.tenantId);
  return mock;
}

async function seedCredentials() {
  const model = await credentialsApi.create({ name: 'My model key', type: 'openAiApi', data: { apiKey: 'k' } });
  const brave = await credentialsApi.create({ name: 'My Brave key', type: 'braveSearchApi', data: { apiKey: 'b' } });
  const other = await credentialsApi.create({ name: 'Unrelated Redis', type: 'redis', data: {} });
  return { model, brave, other };
}

function sent(method: string, path: string) {
  return backend().requests.filter((r) => r.method === method && r.path.split('?')[0] === path);
}

const noModel = () => {
  backend().options.assistant = { enabled: true, modelSet: false };
};

describe('Settings > Assistant: the model', () => {
  it('says when no model is set, then an admin sets one and the Assistant is ready', async () => {
    const user = userEvent.setup();
    as('admin');
    noModel();
    const { model } = await seedCredentials();
    renderApp('/settings/assistant');

    expect(await screen.findByText('No model is set', undefined, WAIT)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Chat Model' })).toBeTruthy(), WAIT);
    await user.selectOptions(screen.getByLabelText(/Model provider/), 'ai.lmChatDemo');
    await user.selectOptions(screen.getByLabelText(/Credential/), model.id);
    const field = screen.getByLabelText(/^Model/, { selector: 'input' }) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, 'fast-2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Assistant model saved', undefined, WAIT)).toBeTruthy();
    expect(sent('PATCH', '/assistant/settings')[0].body).toEqual({
      nodeType: 'ai.lmChatDemo',
      credentialId: model.id,
      model: 'fast-2',
    });
    await waitFor(() => expect(screen.queryByText('No model is set')).toBeNull());
    expect((await settingsApi.get()).features.assistant).toEqual({ enabled: true, modelSet: true });
  });

  it('shows a member the Assistant link only after the model is set', async () => {
    const user = userEvent.setup();
    const mock = as('admin');
    noModel();
    const { model } = await seedCredentials();
    // an editor with no model: no link
    mock.memberships[0].role = 'editor';
    const before = renderApp('/workflows');
    await screen.findByRole('link', { name: /Workflows/ }, WAIT);
    expect(screen.queryByRole('link', { name: 'Assistant' })).toBeNull();
    before.unmount();

    // the admin saves a model
    mock.memberships[0].role = 'admin';
    const second = renderApp('/settings/assistant');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Chat Model' })).toBeTruthy(), WAIT);
    await user.selectOptions(screen.getByLabelText(/Model provider/), 'ai.lmChatDemo');
    await user.selectOptions(screen.getByLabelText(/Credential/), model.id);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Assistant model saved', undefined, WAIT);
    second.unmount();

    mock.memberships[0].role = 'editor';
    renderApp('/workflows');
    expect(await screen.findByRole('link', { name: 'Assistant' }, WAIT)).toBeTruthy();
  });

  it("only offers credentials that fit and says when the server refuses", async () => {
    const user = userEvent.setup();
    as('admin');
    noModel();
    const { model } = await seedCredentials();
    server.use(
      http.patch('/rest/assistant/settings', () =>
        HttpResponse.json({ error: { code: 'bad_request', message: 'The AI credential was not found' } }, { status: 400 }),
      ),
    );
    renderApp('/settings/assistant');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Chat Model' })).toBeTruthy(), WAIT);
    await user.selectOptions(screen.getByLabelText(/Model provider/), 'ai.lmChatDemo');
    await user.selectOptions(screen.getByLabelText(/Credential/), model.id);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Couldn't save the model", undefined, WAIT)).toBeTruthy();
    expect(screen.getByText('No model is set')).toBeTruthy();
  });
});

describe('Settings > Assistant: who sees it', () => {
  it.each(['editor', 'viewer'] as const)('tells an %s who can change it and asks the server for nothing', async (role) => {
    as(role);
    renderApp('/settings/assistant');
    expect(await screen.findByText('Only admins can change the Assistant settings.', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Assistant permissions' })).toBeNull();
    expect(sent('GET', '/assistant/settings')).toHaveLength(0);
  });

  it('refuses a viewer and an editor on the demo server as the real one does', async () => {
    as('editor');
    await expect(assistantApi.settings()).rejects.toThrow();
    await expect(assistantApi.patchSettings({ enabled: false })).rejects.toThrow();
  });
});

describe('Settings > Assistant: permissions', () => {
  it('lists the 22 tools in plain words, Always allow on three rows only', async () => {
    as('admin');
    renderApp('/settings/assistant');
    const table = await screen.findByRole('table', { name: 'Assistant permissions' }, WAIT);
    expect(ASSISTANT_PERMISSION_ROW_KEYS).toHaveLength(22);
    expect([...ASSISTANT_PERMISSION_ROW_KEYS].sort()).toEqual([...ASSISTANT_PERMISSION_KEYS].sort());
    expect(within(table).getAllByRole('combobox')).toHaveLength(22);
    const withAlways = within(table)
      .getAllByRole('combobox')
      .filter((select) => within(select).queryByRole('option', { name: 'Always allow' }))
      .map((select) => select.id);
    expect(withAlways.sort()).toEqual(['permission-fetchUrl', 'permission-mcpRead', 'permission-webSearch']);
    expect(within(table).getByText(MCP_READ_NOTE)).toBeTruthy();
    expect(MCP_READ_NOTE).toBe("The server says these tools only read. We can't check that.");
    expect(document.body.textContent ?? '').not.toMatch(/sandbox/i);
  });

  it('saves a changed row and shows it again', async () => {
    const user = userEvent.setup();
    as('admin');
    renderApp('/settings/assistant');
    const select = (await screen.findByLabelText('Run workflows', undefined, WAIT)) as HTMLSelectElement;
    expect(select.value).toBe('require_approval');
    await user.selectOptions(select, 'blocked');
    await waitFor(() => expect(sent('PATCH', '/assistant/settings')).toHaveLength(1));
    expect(sent('PATCH', '/assistant/settings')[0].body).toEqual({ permissions: { runWorkflow: 'blocked' } });
    await waitFor(() => expect((screen.getByLabelText('Run workflows') as HTMLSelectElement).value).toBe('blocked'));
    await user.selectOptions(screen.getByLabelText('Search the web'), 'always_allow');
    await waitFor(() => expect((screen.getByLabelText('Search the web') as HTMLSelectElement).value).toBe('always_allow'));
  });

  it('refuses always_allow on a tool outside the three, as the server does', async () => {
    as('admin');
    await expect(assistantApi.patchSettings({ permissions: { runWorkflow: 'always_allow' } })).rejects.toThrow();
    const dto = await assistantApi.settings();
    expect(dto.permissions.runWorkflow).toBe('require_approval');
  });
});

describe('Settings > Assistant: the other settings', () => {
  it('turns the Assistant off and on', async () => {
    const user = userEvent.setup();
    as('admin');
    renderApp('/settings/assistant');
    const toggle = await screen.findByRole('switch', { name: 'Turn the Assistant on' }, WAIT);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Turn the Assistant on' }).getAttribute('aria-checked')).toBe('false'),
    );
    expect(sent('PATCH', '/assistant/settings')[0].body).toEqual({ enabled: false });
    expect((await settingsApi.get()).features.assistant).toEqual({ enabled: false, modelSet: true });
  });

  it('saves a search key, turns search off, and lists only search credentials', async () => {
    const user = userEvent.setup();
    as('admin');
    const { brave } = await seedCredentials();
    renderApp('/settings/assistant');
    const select = (await screen.findByLabelText('Search key', undefined, WAIT)) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole('option', { name: 'My Brave key' })).toBeTruthy());
    expect(within(select).queryByRole('option', { name: 'Unrelated Redis' })).toBeNull();
    await user.selectOptions(select, brave.id);
    await waitFor(() => expect((screen.getByLabelText('Search key') as HTMLSelectElement).value).toBe(brave.id));
    expect(sent('PATCH', '/assistant/settings')[0].body).toEqual({ searchCredentialId: brave.id });
    await user.selectOptions(screen.getByLabelText('Search key'), '__off');
    await waitFor(() => expect((screen.getByLabelText('Search key') as HTMLSelectElement).value).toBe('__off'));
    expect(sent('PATCH', '/assistant/settings')[1].body).toEqual({ searchDisabled: true });
  });

  it('turns MCP access on', async () => {
    const user = userEvent.setup();
    as('admin');
    renderApp('/settings/assistant');
    const toggle = await screen.findByRole('switch', { name: 'Let the Assistant use MCP servers' }, WAIT);
    await user.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Let the Assistant use MCP servers' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(sent('PATCH', '/assistant/settings')[0].body).toEqual({ mcpAccessEnabled: true });
  });

  it('saves the parameter value switch, and shows it off and locked when the server turned it off', async () => {
    const user = userEvent.setup();
    as('admin');
    const first = renderApp('/settings/assistant');
    const toggle = await screen.findByRole('switch', { name: 'Send parameter values' }, WAIT);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Send parameter values' }).getAttribute('aria-checked')).toBe('false'),
    );
    expect(sent('PATCH', '/assistant/settings')[0].body).toEqual({ allowSendingParameterValues: false });
    first.unmount();

    const locked: AssistantSettingsDTO = {
      ...(await assistantApi.settings()),
      allowSendingParameterValues: true,
      instanceAllowsSendingParameterValues: false,
    };
    server.use(http.get('/rest/assistant/settings', () => HttpResponse.json({ data: locked })));
    renderApp('/settings/assistant');
    const off = (await screen.findByRole('switch', { name: 'Send parameter values' }, WAIT)) as HTMLButtonElement;
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(off.disabled).toBe(true);
    expect(screen.getByText('Your server turned this off, so the model never sees parameter values.')).toBeTruthy();
  });
});
