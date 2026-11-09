/**
 * P5-09 Settings > AI: admins pick the chat model node, a credential of that provider, the model id and
 * whether values may be sent; Save sends PATCH /settings `ai`; a failed save says "Couldn't save the AI
 * settings"; the saved setup is shown again; below admin the page only says who can change it.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeTypeDescription } from '@workflow/workflow';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { credentialsApi } from '../src/api/endpoints';
import type { Settings, TenantAiSettings } from '../src/api/types';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

afterEach(() => setCurrentTenant(null));

const testModel: NodeTypeDescription = {
  name: 'ai.lmChatTestAi',
  displayName: 'Test AI Chat Model',
  description: 'A chat model for this test',
  group: ['transform'],
  version: 1,
  defaults: { name: 'Test AI' },
  inputs: [],
  outputs: ['ai_languageModel'],
  credentials: [{ name: 'testAiApi', required: true }],
  properties: [{ displayName: 'Model', name: 'model', type: 'options', default: 'test-large', options: [] }],
};

/** the mock server's answers, plus the test model, an `ai` setup and the builder flag */
function serve(options: { ai?: TenantAiSettings; enabled?: boolean } = {}) {
  const patches: unknown[] = [];
  server.use(
    http.get('/rest/node-types', async () => {
      const res = await backend().handle({ method: 'GET', path: '/node-types', query: {}, body: undefined });
      const list = (res.body as { data: NodeTypeDescription[] }).data;
      return HttpResponse.json({ data: [...list, testModel] });
    }),
    http.get('/rest/settings', async () => {
      const res = await backend().handle({ method: 'GET', path: '/settings', query: {}, body: undefined });
      const settings = (res.body as { data: Settings }).data;
      return HttpResponse.json({
        data: {
          ...settings,
          features: {
            ...settings.features,
            aiBuilder: { enabled: options.enabled ?? true, setup: Boolean(options.ai) },
          },
          ...(options.ai ? { ai: options.ai } : {}),
        },
      });
    }),
    http.patch('/rest/settings', async ({ request }) => {
      const body = (await request.json()) as { ai: TenantAiSettings };
      patches.push(body);
      options.ai = body.ai;
      return HttpResponse.json({ data: { ai: body.ai } });
    }),
  );
  return patches;
}

async function seedCredentials() {
  const mock = signedIn();
  setCurrentTenant(mock.session!.tenantId);
  const fitting = await credentialsApi.create({
    name: 'My test AI key',
    type: 'testAiApi',
    data: { apiKey: 'k' },
  });
  await credentialsApi.create({ name: 'Unrelated Redis', type: 'redis', data: {} });
  return { mock, fitting };
}

describe('AI settings page (P5-09)', () => {
  it('saves the model setup: provider, a fitting credential, model id and send values', async () => {
    const user = userEvent.setup();
    const { fitting } = await seedCredentials();
    const patches = serve();
    renderApp('/settings/ai');

    const provider = await screen.findByLabelText(/Model provider/);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Test AI Chat Model' })).toBeTruthy());
    expect(screen.getByTestId('ai-setup-state').textContent).toBe('No model is set yet.');
    await user.selectOptions(provider, 'ai.lmChatTestAi');

    // only credentials of the chosen provider are offered
    const credential = screen.getByLabelText(/Credential/);
    expect(screen.queryByRole('option', { name: 'Unrelated Redis' })).toBeNull();
    await user.selectOptions(credential, fitting.id);
    const model = screen.getByLabelText(/^Model/, { selector: 'input' }) as HTMLInputElement;
    expect(model.value).toBe('test-large');
    await user.clear(model);
    await user.type(model, 'test-small');
    await user.click(screen.getByRole('switch', { name: 'Send parameter values' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      ai: {
        nodeType: 'ai.lmChatTestAi',
        credentialId: fitting.id,
        model: 'test-small',
        allowSendingParameterValues: false,
      },
    });
    expect(await screen.findByText('AI settings saved')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('ai-setup-state').textContent).toBe('The builder has a model.'),
    );
  });

  it('shows the saved setup and keeps Save off until every field is filled', async () => {
    const user = userEvent.setup();
    const { fitting } = await seedCredentials();
    serve({ ai: { nodeType: 'ai.lmChatTestAi', credentialId: fitting.id, model: 'test-mini' } });
    renderApp('/settings/ai');
    await waitFor(() =>
      expect((screen.getByLabelText(/Model provider/) as HTMLSelectElement).value).toBe('ai.lmChatTestAi'),
    );
    await waitFor(() =>
      expect((screen.getByLabelText(/Credential/) as HTMLSelectElement).value).toBe(fitting.id),
    );
    const model = screen.getByLabelText(/^Model/, { selector: 'input' }) as HTMLInputElement;
    expect(model.value).toBe('test-mini');
    expect(screen.getByRole('switch', { name: 'Send parameter values' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.clear(model);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Enter a model')).toBeTruthy();
  });

  it("says it couldn't save when the server refuses", async () => {
    const user = userEvent.setup();
    const { fitting } = await seedCredentials();
    serve();
    server.use(
      http.patch('/rest/settings', () =>
        HttpResponse.json(
          { error: { code: 'bad_request', message: 'The AI credential was not found in this workspace' } },
          { status: 400 },
        ),
      ),
    );
    renderApp('/settings/ai');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Test AI Chat Model' })).toBeTruthy());
    await user.selectOptions(screen.getByLabelText(/Model provider/), 'ai.lmChatTestAi');
    await user.selectOptions(screen.getByLabelText(/Credential/), fitting.id);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Couldn't save the AI settings")).toBeTruthy();
    expect(await screen.findByText('The AI credential was not found in this workspace')).toBeTruthy();
  });

  it('warns when the builder is off on the server', async () => {
    await seedCredentials();
    serve({ enabled: false });
    renderApp('/settings/ai');
    expect(await screen.findByText('The AI builder is off on this server')).toBeTruthy();
  });

  it('below admin: no form, only who can change it', async () => {
    await seedCredentials();
    backend().setDemoRole('editor');
    serve();
    renderApp('/settings/ai');
    expect(await screen.findByText('Only admins can change the AI settings.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText(/Model provider/)).toBeNull();
  });
});
