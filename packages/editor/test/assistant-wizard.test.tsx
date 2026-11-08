/**
 * P5-71 the first-setup wizard on /assistant: an owner or admin with no model gets step model, then step
 * search with Skip (sets searchDisabled); there is no sandbox step; the page opens the chat once it is done;
 * an editor or viewer gets no wizard.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { credentialsApi } from '../src/api/endpoints';
import type { Role } from '../src/api/types';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

const WAIT = { timeout: 5000 };

afterEach(() => setCurrentTenant(null));

async function setUp(role: Role = 'owner') {
  const mock = signedIn();
  backend().options.assistant = { enabled: true, modelSet: false };
  setCurrentTenant(mock.session!.tenantId);
  const model = await credentialsApi.create({ name: 'My model key', type: 'openAiApi', data: { apiKey: 'k' } });
  const brave = await credentialsApi.create({ name: 'My Brave key', type: 'braveSearchApi', data: { apiKey: 'b' } });
  mock.memberships[0].role = role;
  return { model, brave };
}

function patches() {
  return backend().requests.filter((r) => r.method === 'PATCH' && r.path.split('?')[0] === '/assistant/settings');
}

async function chooseModel(modelId: string) {
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Choose a model' }, WAIT);
  await waitFor(() => expect(screen.getByRole('option', { name: 'Chat Model' })).toBeTruthy(), WAIT);
  await user.selectOptions(screen.getByLabelText(/Model provider/), 'ai.lmChatDemo');
  await user.selectOptions(screen.getByLabelText(/Credential/), modelId);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  return user;
}

describe('Assistant wizard (P5-71)', () => {
  it('walks model then search and Skip sets searchDisabled; the chat opens after', async () => {
    const { model } = await setUp('owner');
    renderApp('/assistant');
    const user = await chooseModel(model.id);

    expect(await screen.findByRole('heading', { name: 'Add web search' }, WAIT)).toBeTruthy();
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();
    // the page keeps the wizard until the last step
    expect(screen.getByRole('region', { name: 'Set up the Assistant' })).toBeTruthy();
    expect(patches()[0].body).toEqual({ nodeType: 'ai.lmChatDemo', credentialId: model.id, model: 'fast' });
    expect(document.body.textContent ?? '').not.toMatch(/sandbox/i);

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByRole('textbox', { name: 'Message' }, WAIT)).toBeTruthy();
    expect(patches()[1].body).toEqual({ searchDisabled: true });
    expect(screen.queryByRole('region', { name: 'Set up the Assistant' })).toBeNull();
  });

  it('saves a search key from the second step', async () => {
    const { model, brave } = await setUp('admin');
    renderApp('/assistant');
    const user = await chooseModel(model.id);
    await screen.findByRole('heading', { name: 'Add web search' }, WAIT);
    expect((screen.getByRole('button', { name: 'Finish' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByRole('option', { name: 'My Brave key' })).toBeTruthy(), WAIT);
    expect(screen.queryByRole('option', { name: 'My model key' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Search key'), brave.id);
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByRole('textbox', { name: 'Message' }, WAIT)).toBeTruthy();
    expect(patches()[1].body).toEqual({ searchCredentialId: brave.id });
  });

  it("stays on the model step and says so when the model can't be saved", async () => {
    const { model } = await setUp('owner');
    server.use(
      http.patch('/rest/assistant/settings', () =>
        HttpResponse.json({ error: { code: 'bad_request', message: 'The AI credential does not fit' } }, { status: 400 }),
      ),
    );
    renderApp('/assistant');
    await chooseModel(model.id);
    expect(await screen.findByText("Couldn't save the model", undefined, WAIT)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Choose a model' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Add web search' })).toBeNull();
  });

  it('keeps Next off until a provider, a credential and a model are chosen', async () => {
    await setUp('owner');
    renderApp('/assistant');
    await screen.findByRole('heading', { name: 'Choose a model' }, WAIT);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['editor', 'viewer'] as const)('gives an %s no wizard', async (role) => {
    await setUp(role);
    renderApp('/assistant');
    expect(await screen.findByText('No model is set. An admin can set one in Settings', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Choose a model' })).toBeNull();
  });
});
