/**
 * Phase 5 S4 C0f contracts: the demo's MCP node and credential types, `features.aiBuilder`, the MCP URL family
 * of the demo's webhook URLs, the AI and MCP route modules, the demo build stream, the new routes and settings
 * links, and an MCP Server Trigger on the canvas. The lanes fill the stubs (L2, L11) and the pages (L1, L11);
 * nothing here asserts a stub or a page's content.
 */
import { screen, waitFor, within } from '@testing-library/react';
import type { NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBuildStreamConnector, setBuildStreamConnector } from '../src/api/ai-stream';
import { settingsApi, workflowsApi } from '../src/api/endpoints';
import { aiBuilderFeatureOf } from '../src/api/queries';
import { demoCredentialTypes, demoNodeTypes } from '../src/demo/fixtures';
import { demoBuildStream, installDemo } from '../src/demo/install';
import { MockBackend } from '../src/demo/mock-backend';
import { DEMO_MCP_TRIGGER_TYPE, demoHookFamily, demoHookUrl } from '../src/demo/mock-triggers';
import { buildCatalog, filterCatalog } from '../src/lib/node-catalog';
import { deriveNodePorts } from '../src/lib/ports';
import { useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const MCP_CLIENT_TYPE = 'ai.mcpClient';

const describeOf = (name: string): NodeTypeDescription => demoNodeTypes.find((d) => d.name === name)!;
const credentialOf = (name: string) => demoCredentialTypes.find((c) => c.name === name)!;

const nodeOf = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  position: [number, number] = [0, 0],
): WorkflowNode => ({ id: name, name, type, typeVersion: 1, position, parameters });

const ERROR_TITLE = 'This page stopped working';
const NOT_FOUND_TITLE = 'This page does not exist';

describe('S4 demo node types', () => {
  const catalog = buildCatalog(demoNodeTypes);
  const names = (query: string, extra: Partial<Parameters<typeof filterCatalog>[1]> = {}) =>
    filterCatalog(catalog, { query, ...extra }).flatMap((s) => s.entries.map((e) => e.description.name));

  it('describes the MCP Server Trigger and the MCP Client with a lucide icon and two categories, AI first', () => {
    for (const name of [DEMO_MCP_TRIGGER_TYPE, MCP_CLIENT_TYPE]) {
      const description = describeOf(name);
      expect(description, name).toBeTruthy();
      expect(description.icon, name).toMatch(/^lucide:/);
      expect(description.categories, name).toHaveLength(2);
      expect(description.categories?.[0], name).toBe('AI');
    }
    const trigger = describeOf(DEMO_MCP_TRIGGER_TYPE);
    expect(trigger.group).toContain('trigger');
    expect(trigger.inputs).toEqual([{ type: 'ai_tool', displayName: 'Tools' }]);
    expect(trigger.outputs).toEqual([]);
    expect(trigger.webhooks?.map((w) => [w.name, w.httpMethod, w.nodeType, w.isFullPath])).toEqual([
      ['setup', 'GET', 'mcp', true],
      ['default', 'POST', 'mcp', true],
      ['sessionEnd', 'DELETE', 'mcp', true],
    ]);
    const authentication = trigger.properties.find((p) => p.name === 'authentication');
    expect(authentication?.default).toBe('none');
    expect(authentication?.options?.map((o) => ('value' in o ? o.value : undefined))).toEqual([
      'none',
      'n8nOAuth2',
      'bearerAuth',
      'headerAuth',
    ]);
    const client = describeOf(MCP_CLIENT_TYPE);
    expect([client.inputs, client.outputs]).toEqual([['main'], ['main']]);
    expect(client.usableAsTool).toBeFalsy();
  });

  it('lists them in the node picker', () => {
    expect(names('mcp')).toEqual(expect.arrayContaining([DEMO_MCP_TRIGGER_TYPE, MCP_CLIENT_TYPE]));
    const triggers = filterCatalog(catalog, { query: '', noTriggerYet: true })[0].entries.map(
      (e) => e.description.name,
    );
    expect(triggers).toContain(DEMO_MCP_TRIGGER_TYPE);
    const afterOutput = names('', { needsMainInput: true });
    expect(afterOutput).toContain(MCP_CLIENT_TYPE);
    expect(afterOutput).not.toContain(DEMO_MCP_TRIGGER_TYPE);
  });

  it('gives the MCP Server Trigger a Tools input, no output, and keeps it a trigger, not a sub-node', () => {
    const ports = deriveNodePorts(nodeOf('MCP', DEMO_MCP_TRIGGER_TYPE), describeOf(DEMO_MCP_TRIGGER_TYPE));
    expect(ports.inputs.map((p) => [p.id, p.label])).toEqual([['in:ai_tool:0', 'Tools']]);
    expect(ports.outputs).toEqual([]);
    expect(ports.isSubNode).toBe(false);
    expect(ports.isTrigger).toBe(true);
  });

  it('describes the two new credential types', () => {
    const headers = credentialOf('httpMultipleHeadersAuth');
    expect(headers.hasAuthenticate).toBe(true);
    const rows = headers.properties.find((p) => p.name === 'headers');
    expect(rows?.type).toBe('fixedCollection');
    const values = rows?.options?.find((o) => 'name' in o && o.name === 'values') as unknown as {
      values: Array<{ name: string; typeOptions?: { password?: boolean } }>;
    };
    expect(values.values.map((v) => v.name)).toEqual(['name', 'value']);
    expect(values.values[1].typeOptions?.password).toBe(true);

    const oauth = credentialOf('mcpOAuth2Api');
    expect(oauth.isOAuth2).toBe(true);
    expect(oauth.extends).toEqual(['oAuth2Api']);
    const field = (name: string) => oauth.properties.find((p) => p.name === name);
    expect(field('useDynamicClientRegistration')?.default).toBe(true);
    expect(field('resourceUrl')?.type).toBe('string');
    expect([field('grantType')?.type, field('grantType')?.default]).toEqual(['hidden', 'pkce']);
    expect(field('authentication')?.default).toBe('body');
    // the parent's fields come first, as GET /credential-types resolves them
    expect(oauth.properties[0].name).toBe('clientId');
  });
});

describe('S4 demo backend', () => {
  beforeEach(() => void signedIn());

  it('turns the AI builder on in features', async () => {
    const settings = await settingsApi.get();
    expect(settings.features.aiBuilder).toEqual({ enabled: true, setup: true });
    expect(aiBuilderFeatureOf(settings)).toEqual({ enabled: true, setup: true });
  });

  it('takes the AI builder feature from its options', async () => {
    const off = new MockBackend({ aiBuilder: { enabled: false, setup: false } });
    const { body } = await off.handle({ method: 'GET', path: '/settings' });
    expect((body as { data: { features: Record<string, unknown> } }).data.features.aiBuilder).toEqual({
      enabled: false,
      setup: false,
    });
  });

  it('builds the MCP URL family for an MCP Server Trigger', async () => {
    const wf = backend().seedWorkflow({
      name: 'Tools',
      nodes: [
        nodeOf('MCP Server Trigger', DEMO_MCP_TRIGGER_TYPE, { path: 'my-tools' }),
        nodeOf('Hook', 'core.webhook', { path: 'orders', httpMethod: 'POST' }, [0, 300]),
      ],
    });
    const slug = backend().tenants[0].slug;
    const urls = await workflowsApi.webhookUrls(wf.id);
    const mcp = urls.find((u) => u.nodeName === 'MCP Server Trigger')!;
    expect(mcp.method).toBe('POST');
    expect(new URL(mcp.productionUrl).pathname).toBe(`/mcp/${slug}/my-tools`);
    expect(new URL(mcp.testUrl).pathname).toBe(`/mcp-test/${slug}/my-tools`);
    const hook = urls.find((u) => u.nodeName === 'Hook')!;
    expect(new URL(hook.productionUrl).pathname).toBe(`/webhook/${slug}/orders`);
    expect(new URL(hook.testUrl).pathname).toBe(`/webhook-test/${slug}/orders`);

    const listen = await workflowsApi.listenTestWebhook(wf.id, 'MCP Server Trigger');
    expect(new URL(listen.testUrl).pathname).toBe(`/mcp-test/${slug}/my-tools`);
    expect(listen.formTestUrls).toEqual([]);
  });

  it('names the URL family of each trigger as the server does', () => {
    expect(demoHookFamily(DEMO_MCP_TRIGGER_TYPE)).toBe('mcp');
    expect(demoHookFamily('core.formTrigger')).toBe('form');
    expect(demoHookFamily('core.webhook')).toBe('webhook');
    expect(demoHookUrl('https://x.test', 'mcp', true, 'acme', 'p')).toBe('https://x.test/mcp-test/acme/p');
    expect(demoHookUrl('https://x.test', 'mcp', false, 'acme', 'p')).toBe('https://x.test/mcp/acme/p');
  });

  it.each([
    ['POST', '/ai/sessions'],
    ['POST', '/ai/build/truncate-messages'],
    ['POST', '/ai/build/clear-session'],
    ['POST', '/ai/build/accepted-version'],
    ['POST', '/ai/usage-settings'],
    ['GET', '/mcp/settings'],
    ['PATCH', '/mcp/settings'],
    ['GET', '/mcp/api-key'],
    ['POST', '/mcp/api-key/rotate'],
    ['GET', '/mcp/workflows'],
    ['PATCH', '/mcp/workflows/toggle-access'],
    ['GET', '/mcp/oauth/allowed-redirect-uris'],
    ['PATCH', '/mcp/oauth/allowed-redirect-uris'],
    ['GET', '/mcp/oauth-clients'],
    ['DELETE', '/mcp/oauth-clients/client-1'],
    ['GET', '/mcp/instance-stats'],
    ['GET', '/consent/details'],
    ['POST', '/consent/approve'],
  ])('registers %s %s', async (method, path) => {
    const { body } = await backend().handle({ method: method as 'GET', path, body: {} });
    const message = (body as { error?: { message?: string } }).error?.message ?? '';
    expect(message).not.toMatch(/^No route for/);
  });
});

describe('S4 demo install', () => {
  afterEach(() => setBuildStreamConnector(null));

  it('plays builder turns through the demo build stream', () => {
    setBuildStreamConnector(null);
    installDemo();
    expect(getBuildStreamConnector()).toBe(demoBuildStream);
  });
});

describe('S4 routes', () => {
  beforeEach(() => {
    signedIn();
    useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false });
  });

  it.each(['/settings/ai', '/settings/mcp', '/oauth/consent?flow=demo-flow'])(
    'resolves %s with no error boundary',
    async (path) => {
      const { router } = renderApp(path);
      await waitFor(() => expect(router.state.navigation.state).toBe('idle'));
      // the lazy page has loaded once the suspense loader is gone
      const loaders = () =>
        screen.queryAllByRole('status').filter((el) => /Loading/.test(el.textContent ?? ''));
      await waitFor(() => expect(loaders()).toEqual([]), { timeout: 20_000 });
      expect(router.state.errors).toBeNull();
      expect(screen.queryByText(ERROR_TITLE)).toBeNull();
      expect(screen.queryByText(NOT_FOUND_TITLE)).toBeNull();
    },
  );

  /** the settings nav's link labels, once /me has loaded (the account page shows the email) */
  async function settingsLinks(): Promise<string[]> {
    renderApp('/settings/account');
    const nav = await screen.findByRole('navigation', { name: 'Settings' }, { timeout: 20_000 });
    await screen.findAllByText('owner@example.com', undefined, { timeout: 20_000 });
    return within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim() ?? '');
  }

  it('shows the AI and MCP settings links to an owner', async () => {
    expect(await settingsLinks()).toEqual(expect.arrayContaining(['AI', 'MCP']));
  });

  it.each(['editor', 'viewer'] as const)('shows the MCP link but not the AI link to an %s', async (role) => {
    backend().memberships[0].role = role;
    const links = await settingsLinks();
    expect(links).toContain('MCP');
    expect(links).not.toContain('AI');
  });

  it('draws an MCP Server Trigger with a tool and no output', async () => {
    const wf = backend().seedWorkflow({
      name: 'MCP tools',
      nodes: [
        { ...nodeOf('MCP Server Trigger', DEMO_MCP_TRIGGER_TYPE, { path: 'tools' }), id: 'mcp' },
        { ...nodeOf('Calculator', 'ai.toolCalculator', {}, [0, 240]), id: 'calc' },
      ],
      connections: {
        Calculator: { ai_tool: [[{ node: 'MCP Server Trigger', type: 'ai_tool', index: 0 }]] },
      },
    });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    await waitFor(() => expect(document.querySelector('[data-id="mcp"]')).toBeTruthy());
    const trigger = document.querySelector<HTMLElement>('[data-id="mcp"]')!;
    expect(within(trigger).getAllByText('MCP Server Trigger').length).toBeGreaterThan(0);
    expect(trigger.querySelector('[data-handleid="in:ai_tool:0"]')).toBeTruthy();
    expect(trigger.querySelector('[data-handleid^="out:"]')).toBeNull();
    expect(document.querySelector('[data-id="calc"] [data-handleid="out:ai_tool:0"]')).toBeTruthy();
    expect(screen.queryByText(ERROR_TITLE)).toBeNull();
  });
});
