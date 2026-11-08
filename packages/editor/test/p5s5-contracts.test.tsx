/**
 * Phase 5 S5 C0g contracts: the demo's `features.assistant`, the `braveSearchApi` credential type, the five
 * Assistant route modules, the demo Assistant stream, the Assistant routes and the Assistant links by role.
 * The lanes fill the stubs (L2, L3, L7, L8, L9) and the pages (L2, L8); nothing here asserts a stub or a page's
 * content (L8 runs this file after L2 filled `AssistantPage`, and may not edit it).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAssistantStreamConnector, setAssistantStreamConnector } from '../src/api/assistant-stream';
import { settingsApi } from '../src/api/endpoints';
import { assistantFeatureOf, queryKeys } from '../src/api/queries';
import type { AssistantFeature, Role } from '../src/api/types';
import { demoCredentialTypes } from '../src/demo/fixtures';
import { installDemo } from '../src/demo/install';
import { demoAssistantStream, registerAssistantRoutes } from '../src/demo/mock-assistant';
import { registerAssistantConfirmRoutes } from '../src/demo/mock-assistant-confirm';
import { registerAssistantDraftRoutes } from '../src/demo/mock-assistant-drafts';
import { registerAssistantMcpRoutes } from '../src/demo/mock-assistant-mcp';
import { registerAssistantSettingsRoutes } from '../src/demo/mock-assistant-settings';
import { MockBackend } from '../src/demo/mock-backend';
import { useAssistantStore } from '../src/stores/assistant-store';
import { useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const ERROR_TITLE = 'This page stopped working';

afterEach(() => {
  useAssistantStore.getState().reset();
  setAssistantStreamConnector(null);
});

describe('S5 demo backend', () => {
  beforeEach(() => void signedIn());

  it('turns the Assistant on with a model in features', async () => {
    const settings = await settingsApi.get();
    expect(settings.features.assistant).toEqual({ enabled: true, modelSet: true });
    expect(assistantFeatureOf(settings)).toEqual({ enabled: true, modelSet: true });
    // S4's feature stays beside it
    expect(settings.features.aiBuilder).toEqual({ enabled: true, setup: true });
  });

  it('takes the Assistant feature from its options and holds no credential id', async () => {
    const off = new MockBackend({ assistant: { enabled: true, modelSet: false } });
    const { body } = await off.handle({ method: 'GET', path: '/settings' });
    const assistant = (body as { data: { features: Record<string, unknown> } }).data.features.assistant;
    expect(assistant).toEqual({ enabled: true, modelSet: false });
    expect(Object.keys(assistant as object).sort()).toEqual(['enabled', 'modelSet']);
  });

  it('registers the five Assistant route modules and the demo stream factory', () => {
    for (const register of [
      registerAssistantRoutes,
      registerAssistantConfirmRoutes,
      registerAssistantDraftRoutes,
      registerAssistantSettingsRoutes,
      registerAssistantMcpRoutes,
    ]) {
      expect(typeof register).toBe('function');
      expect(register.length).toBe(1);
    }
    expect(typeof demoAssistantStream(backend())).toBe('function');
  });

  it('describes the Brave Search credential type with a secret key and a test request', () => {
    const brave = demoCredentialTypes.find((c) => c.name === 'braveSearchApi');
    expect(brave?.displayName).toBe('Brave Search API');
    expect(brave?.properties.map((p) => [p.name, p.type, p.typeOptions?.password])).toEqual([
      ['apiKey', 'string', true],
    ]);
    expect(new URL(brave?.test?.request.url ?? '').host).toBe('api.search.brave.com');
    expect([brave?.isOAuth2, brave?.isOAuth1]).toEqual([false, false]);
  });
});

describe('S5 demo install', () => {
  it('plays Assistant turns through the demo stream connector', () => {
    setAssistantStreamConnector(null);
    installDemo();
    expect(typeof getAssistantStreamConnector()).toBe('function');
  });
});

describe('S5 routes', () => {
  beforeEach(() => {
    signedIn();
    useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false });
  });

  it.each([
    ['/assistant', 'assistant'],
    ['/assistant/thread-1', 'assistant/:threadId'],
    ['/settings/assistant', 'assistant'],
  ])('resolves %s with no error boundary', async (path, routePath) => {
    const { router } = renderApp(path);
    await waitFor(() => expect(router.state.navigation.state).toBe('idle'));
    // the lazy page has loaded once the suspense loader is gone
    const loaders = () =>
      screen.queryAllByRole('status').filter((el) => /Loading/.test(el.textContent ?? ''));
    await waitFor(() => expect(loaders()).toEqual([]), { timeout: 20_000 });
    expect(router.state.errors).toBeNull();
    expect(screen.queryByText(ERROR_TITLE)).toBeNull();
    // the route itself matched (not the not-found page)
    expect(router.state.matches.at(-1)?.route.path).toBe(routePath);
  });

  /** the main nav once /me and /settings have loaded */
  async function mainNav(role: Role, feature: AssistantFeature) {
    backend().memberships[0].role = role;
    backend().options.assistant = feature;
    const { queryClient } = renderApp('/workflows');
    await waitFor(
      () => {
        expect(queryClient.getQueryData(queryKeys.me)).toBeTruthy();
        expect(queryClient.getQueryData(queryKeys.settings)).toBeTruthy();
      },
      { timeout: 20_000 },
    );
    const nav = await screen.findByRole('navigation', { name: 'Main' }, { timeout: 20_000 });
    await within(nav).findByRole('link', { name: 'Workflows' });
    return { nav, queryClient };
  }

  it.each(['owner', 'admin'] as const)('shows the Assistant link to an %s with no model', async (role) => {
    const { nav } = await mainNav(role, { enabled: true, modelSet: false });
    expect(await within(nav).findByRole('link', { name: 'Assistant' })).toBeTruthy();
  });

  it.each(['editor', 'viewer'] as const)(
    'hides the Assistant link from an %s until a model is set',
    async (role) => {
      const { nav, queryClient } = await mainNav(role, { enabled: true, modelSet: false });
      expect(within(nav).queryByRole('link', { name: 'Assistant' })).toBeNull();
      backend().options.assistant = { enabled: true, modelSet: true };
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      expect(await within(nav).findByRole('link', { name: 'Assistant' })).toBeTruthy();
    },
  );

  it('hides the Assistant link from everyone while the Assistant is off', async () => {
    const { nav } = await mainNav('owner', { enabled: false, modelSet: true });
    expect(within(nav).queryByRole('link', { name: 'Assistant' })).toBeNull();
  });

  /** the settings nav's link labels, once /me has loaded (the account page shows the email) */
  async function settingsLinks(): Promise<string[]> {
    renderApp('/settings/account');
    const nav = await screen.findByRole('navigation', { name: 'Settings' }, { timeout: 20_000 });
    await screen.findAllByText('owner@example.com', undefined, { timeout: 20_000 });
    return within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim() ?? '');
  }

  it.each(['owner', 'admin'] as const)('shows the Assistant settings link to an %s', async (role) => {
    backend().memberships[0].role = role;
    expect(await settingsLinks()).toContain('Assistant');
  });

  it.each(['editor', 'viewer'] as const)('hides the Assistant settings link from an %s', async (role) => {
    backend().memberships[0].role = role;
    const links = await settingsLinks();
    expect(links).toContain('MCP');
    expect(links).not.toContain('Assistant');
  });
});
