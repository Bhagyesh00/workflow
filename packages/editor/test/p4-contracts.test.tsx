/**
 * Phase 4 C0f contracts: routes, nav, settings link, endpoint URLs and bodies, the demo's new routes
 * and call sites. Stubs other lanes fill are mocked here; their return values are never asserted.
 */
import { act, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeTypeDescription, TaskData, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiRequest, setTransport } from '../src/api/client';
import { apiKeysApi, dataTablesApi, formAuthApi, secretsApi, workflowsApi } from '../src/api/endpoints';
import { queryKeys } from '../src/api/queries';
import { completeExpression } from '../src/components/code/completions';
import { NodeDetailsView } from '../src/components/ndv/NodeDetailsView';
import { demoCredentialTypes, demoNodeTypes } from '../src/demo/fixtures';
import { listenForTestEvent } from '../src/features/editor/editor-actions';
import { maybeOpenFormPopup, openTestForm } from '../src/features/editor/form-popup';
import { applyCodeDefaults } from '../src/lib/code-defaults';
import { useRunStore } from '../src/stores/run-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import viteConfig from '../vite.config';
import { backend, signedIn } from './backend';
import { renderApp, renderParameters, withProviders } from './utils';

// vitest sets BASE_URL to '/', which vite.config.ts reads as the server's origin
vi.hoisted(() => {
  process.env.BASE_URL = 'http://localhost:5678';
});

vi.mock('../src/pages/DataTablesPage', () => ({ DataTablesPage: () => <p>data tables list stub</p> }));
vi.mock('../src/pages/DataTableDetailPage', () => ({
  DataTableDetailPage: () => <p>data table detail stub</p>,
}));
vi.mock('../src/pages/SecretsSettingsPage', () => ({ SecretsSettingsPage: () => <p>secrets page stub</p> }));
vi.mock('../src/pages/auth/FormSignInPage', () => ({ FormSignInPage: () => <p>form sign-in stub</p> }));
vi.mock('../src/components/data-tables/StorageBanner', () => ({
  DataTableStorageBanner: () => <p>storage banner stub</p>,
}));
vi.mock('../src/components/data-tables/NodeStorageCallout', () => ({
  NodeStorageCallout: () => <p>storage callout stub</p>,
}));
vi.mock('../src/components/settings/ApiKeyScopesField', () => ({
  ApiKeyScopesField: ({ value, onChange }: { value: string[]; onChange(next: string[]): void }) => (
    <button type="button" onClick={() => onChange(['workflow:read'])}>
      pick a scope ({value.length})
    </button>
  ),
}));
vi.mock('../src/features/editor/form-popup', () => ({
  openTestForm: vi.fn(),
  maybeOpenFormPopup: vi.fn(),
}));
vi.mock('../src/lib/code-defaults', () => ({
  applyCodeDefaults: vi.fn((_type: string, _prev: unknown, next: unknown) => next),
}));
vi.mock('../src/demo/mock-data-tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/demo/mock-data-tables')>()),
  dataTableName: vi.fn(),
  searchDataTables: vi.fn(),
  simulateDataTableNode: vi.fn(),
}));

// the first panel or lazy page of a busy run takes a while
configure({ asyncUtilTimeout: 20_000 });

const describeOf = (name: string): NodeTypeDescription => demoNodeTypes.find((d) => d.name === name)!;

const nodeOf = (name: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
});

beforeEach(() => {
  vi.clearAllMocks();
  useRunStore.getState().reset();
});

describe('routes and navigation', () => {
  beforeEach(() => void signedIn());

  it('renders the data table pages inside the shell with nav link and storage banner', async () => {
    const { unmount } = renderApp('/data-tables');
    expect(await screen.findByText('data tables list stub')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Data tables' }).getAttribute('href')).toBe('/home/data-tables');
    expect(screen.getByText('storage banner stub')).toBeTruthy();
    unmount();

    renderApp('/data-tables/t1');
    expect(await screen.findByText('data table detail stub')).toBeTruthy();
  });

  it('renders the secrets page below settings', async () => {
    renderApp('/settings/external-secrets');
    expect(await screen.findByText('secrets page stub')).toBeTruthy();
  });

  it('renders /form-auth outside the shell and signed out', async () => {
    backend().session = null;
    renderApp('/form-auth');
    expect(await screen.findByText('form sign-in stub')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Data tables' })).toBeNull();
    expect(screen.queryByText('storage banner stub')).toBeNull();
  });

  it.each([
    ['owner', true],
    ['admin', true],
    ['editor', false],
    ['viewer', false],
  ] as const)('settings link "External secrets" for a %s: %s', async (role, shown) => {
    backend().setDemoRole(role);
    renderApp('/settings/account');
    await screen.findByRole('link', { name: 'API keys' });
    if (shown) {
      const link = await screen.findByRole('link', { name: 'External secrets' });
      expect(link.getAttribute('href')).toBe('/settings/external-secrets');
    } else {
      // the role has loaded once the account page shows it
      await screen.findAllByText(role);
      expect(screen.queryByRole('link', { name: 'External secrets' })).toBeNull();
    }
  });

  it('the API key form renders the scopes field and sends the picked scopes', async () => {
    renderApp('/settings/api-keys');
    await userEvent.type(await screen.findByLabelText('New key name'), 'CI');
    await userEvent.click(screen.getByRole('button', { name: 'pick a scope (0)' }));
    expect(screen.getByRole('button', { name: 'pick a scope (1)' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByText('Copy your new key');
    const post = backend().requests.find((r) => r.method === 'POST' && r.path === '/api-keys');
    expect(post?.body).toEqual({ name: 'CI', scopes: ['workflow:read'] });
    // a saved form starts over with no scopes
    expect(screen.getByRole('button', { name: 'pick a scope (0)', hidden: true })).toBeTruthy();
  });
});

describe('endpoints', () => {
  function record() {
    const requests: ApiRequest[] = [];
    setTransport(async (request) => {
      requests.push(request);
      return { status: 200, body: { data: null } };
    });
    return requests;
  }
  const last = (requests: ApiRequest[]) => {
    const { method, path, query, body } = requests[requests.length - 1];
    return { method, path, query, body };
  };

  it('dataTablesApi: tables', async () => {
    const r = record();
    await dataTablesApi.list({
      name: 'lead',
      sortBy: { column: 'name', direction: 'asc' },
      skip: 10,
      take: 10,
    });
    expect(last(r)).toEqual({
      method: 'GET',
      path: '/data-tables',
      query: { skip: 10, take: 10, filter: '{"name":"lead"}', sortBy: 'name:asc' },
      body: undefined,
    });
    await dataTablesApi.list();
    expect(last(r).query).toEqual({
      skip: undefined,
      take: undefined,
      filter: undefined,
      sortBy: undefined,
    });
    await dataTablesApi.limits();
    expect(last(r)).toMatchObject({ method: 'GET', path: '/data-tables/limits' });
    await dataTablesApi.get('t/1');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/data-tables/t%2F1' });
    const body = { name: 'Leads', columns: [{ name: 'email', type: 'string' as const }] };
    await dataTablesApi.create(body);
    expect(last(r)).toMatchObject({ method: 'POST', path: '/data-tables', body });
    await dataTablesApi.rename('t1', 'Old leads');
    expect(last(r)).toMatchObject({ method: 'PATCH', path: '/data-tables/t1', body: { name: 'Old leads' } });
    await dataTablesApi.remove('t1');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/data-tables/t1' });
    await dataTablesApi.dependencies('t1');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/data-tables/t1/dependencies' });
  });

  it('dataTablesApi: columns', async () => {
    const r = record();
    await dataTablesApi.columns('t1');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/data-tables/t1/columns' });
    await dataTablesApi.addColumn('t1', { name: 'age', type: 'number', index: 2 });
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/data-tables/t1/columns',
      body: { name: 'age', type: 'number', index: 2 },
    });
    await dataTablesApi.removeColumn('t1', 'c1');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/data-tables/t1/columns/c1' });
    await dataTablesApi.moveColumn('t1', 'c1', 3);
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/data-tables/t1/columns/c1/move',
      body: { targetIndex: 3 },
    });
    await dataTablesApi.renameColumn('t1', 'c1', 'years');
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/data-tables/t1/columns/c1/rename',
      body: { name: 'years' },
    });
  });

  it('dataTablesApi: rows and CSV', async () => {
    const r = record();
    const filter = {
      type: 'and' as const,
      filters: [{ columnName: 'age', condition: 'gt' as const, value: 3 }],
    };
    await dataTablesApi.rows('t1', {
      filter,
      skip: 20,
      take: 50,
      sortBy: { column: 'age', direction: 'desc' },
      search: 'x',
    });
    expect(last(r)).toEqual({
      method: 'GET',
      path: '/data-tables/t1/rows',
      query: { skip: 20, take: 50, filter: JSON.stringify(filter), sortBy: 'age:desc', search: 'x' },
      body: undefined,
    });
    await dataTablesApi.insertRows('t1', [{ age: 3 }], 'all');
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/data-tables/t1/insert',
      body: { data: [{ age: 3 }], returnType: 'all' },
    });
    await dataTablesApi.upsertRow('t1', { filter, data: { age: 4 } }, { dryRun: true, returnData: true });
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/data-tables/t1/upsert',
      body: { filter, data: { age: 4 }, dryRun: true, returnData: true },
    });
    await dataTablesApi.updateRows('t1', { filter, data: { age: 5 } });
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/data-tables/t1/rows',
      body: { filter, data: { age: 5 } },
    });
    await dataTablesApi.deleteRows('t1', filter, { dryRun: true, returnData: true });
    expect(last(r)).toMatchObject({
      method: 'DELETE',
      path: '/data-tables/t1/rows',
      query: { filter: JSON.stringify(filter), dryRun: true, returnData: true },
    });
    await dataTablesApi.clearRows('t1');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/data-tables/t1/rows/clear' });
    await dataTablesApi.downloadCsv('t1', false);
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/data-tables/t1/download-csv',
      query: { includeSystemColumns: false },
    });
    await dataTablesApi.csvPreview('a,b\n1,2', true);
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/data-tables/csv/preview',
      body: { csv: 'a,b\n1,2', hasHeaders: true },
    });
    await dataTablesApi.importCsv('t1', 'a,b\n1,2');
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/data-tables/t1/import-csv',
      body: { csv: 'a,b\n1,2' },
    });
  });

  it('a page of tables or rows keeps its count', async () => {
    const page = { count: 12, data: [{ id: 1 }] };
    setTransport(async () => ({ status: 200, body: { data: page } }));
    expect(await dataTablesApi.list()).toEqual(page);
    expect(await dataTablesApi.rows('t1')).toEqual(page);
  });

  it('secretsApi', async () => {
    const r = record();
    await secretsApi.types();
    expect(last(r)).toMatchObject({ method: 'GET', path: '/secret-providers/types' });
    await secretsApi.type('vault');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/secret-providers/types/vault' });
    await secretsApi.completions();
    expect(last(r)).toMatchObject({ method: 'GET', path: '/secret-providers/completions/secrets' });
    await secretsApi.connections();
    expect(last(r)).toMatchObject({ method: 'GET', path: '/secret-providers/connections' });
    await secretsApi.connection('prod');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/secret-providers/connections/prod' });
    const create = { providerKey: 'prod', type: 'vault', settings: { url: 'https://vault.test' } };
    await secretsApi.createConnection(create);
    expect(last(r)).toMatchObject({ method: 'POST', path: '/secret-providers/connections', body: create });
    await secretsApi.updateConnection('prod', { isEnabled: true });
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/secret-providers/connections/prod',
      body: { isEnabled: true },
    });
    await secretsApi.removeConnection('prod');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/secret-providers/connections/prod' });
    await secretsApi.testConnection('prod');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/secret-providers/connections/prod/test' });
    await secretsApi.reloadConnection('prod');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/secret-providers/connections/prod/reload' });
  });

  it('form auth, trigger listen and API key scopes', async () => {
    const r = record();
    await formAuthApi.issueCode('/form/acme/signup');
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/form-auth/code',
      body: { returnTo: '/form/acme/signup' },
    });
    await workflowsApi.listenTestTrigger('w1', 'Redis');
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/workflows/w1/listen-test-trigger',
      body: { nodeName: 'Redis' },
    });
    await workflowsApi.stopTestTrigger('w1');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/workflows/w1/listen-test-trigger' });
    await apiKeysApi.create('CI', ['workflow:read']);
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/api-keys',
      body: { name: 'CI', scopes: ['workflow:read'] },
    });
    await apiKeysApi.create('All');
    expect(last(r).body).toEqual({ name: 'All', scopes: [] });
  });

  it('query keys', () => {
    expect(queryKeys.dataTables({ skip: 10 })).toEqual(['data-tables', { skip: 10 }]);
    expect(queryKeys.dataTable('t1')).toEqual(['data-table', 't1']);
    expect(queryKeys.dataTableRows('t1', { skip: 10 })).toEqual(['data-table', 't1', 'rows', { skip: 10 }]);
    expect(queryKeys.dataTableColumns('t1')).toEqual(['data-table', 't1', 'columns']);
    expect(queryKeys.dataTableLimits).toEqual(['data-tables-limits']);
    expect(queryKeys.secretProviderTypes).toEqual(['secret-providers', 'types']);
    expect(queryKeys.secretConnections).toEqual(['secret-providers', 'connections']);
    expect(queryKeys.secretConnection('prod')).toEqual(['secret-providers', 'connections', 'prod']);
    expect(queryKeys.secretCompletions).toEqual(['secret-providers', 'completions']);
  });
});

/**
 * test/setup.ts loads the mock backend before this file's vi.mock calls apply, so the shared instance
 * has the real mock-data-tables. A fresh module graph has the mocked one.
 */
async function backendWithMockedTables() {
  vi.resetModules();
  const { MockBackend } = await import('../src/demo/mock-backend');
  const tables = await import('../src/demo/mock-data-tables');
  const demo = new MockBackend();
  demo.createAccount({ email: 'o@example.com', password: 'secret-pass-1', name: 'O', workspaceName: 'S' });
  demo.signIn('o@example.com');
  return { demo, tables: vi.mocked(tables) };
}

describe('demo backend', () => {
  beforeEach(() => void signedIn());

  it.each([
    ['GET', '/data-tables'],
    ['GET', '/data-tables/limits'],
    ['POST', '/data-tables'],
    ['POST', '/data-tables/csv/preview'],
    ['GET', '/data-tables/t1'],
    ['PATCH', '/data-tables/t1'],
    ['DELETE', '/data-tables/t1'],
    ['GET', '/data-tables/t1/dependencies'],
    ['GET', '/data-tables/t1/columns'],
    ['POST', '/data-tables/t1/columns'],
    ['DELETE', '/data-tables/t1/columns/c1'],
    ['PATCH', '/data-tables/t1/columns/c1/move'],
    ['PATCH', '/data-tables/t1/columns/c1/rename'],
    ['GET', '/data-tables/t1/rows'],
    ['POST', '/data-tables/t1/insert'],
    ['POST', '/data-tables/t1/upsert'],
    ['PATCH', '/data-tables/t1/rows'],
    ['DELETE', '/data-tables/t1/rows'],
    ['DELETE', '/data-tables/t1/rows/clear'],
    ['GET', '/data-tables/t1/download-csv'],
    ['POST', '/data-tables/t1/import-csv'],
    ['GET', '/secret-providers/types'],
    ['GET', '/secret-providers/types/vault'],
    ['GET', '/secret-providers/completions/secrets'],
    ['GET', '/secret-providers/connections'],
    ['POST', '/secret-providers/connections'],
    ['GET', '/secret-providers/connections/prod'],
    ['PATCH', '/secret-providers/connections/prod'],
    ['DELETE', '/secret-providers/connections/prod'],
    ['POST', '/secret-providers/connections/prod/test'],
    ['POST', '/secret-providers/connections/prod/reload'],
    ['POST', '/workflows/w1/listen-test-trigger'],
    ['DELETE', '/workflows/w1/listen-test-trigger'],
    ['POST', '/form-auth/code'],
  ] as const)('answers %s %s', async (method, path) => {
    const { body } = await backend().handle({ method, path });
    expect(JSON.stringify(body)).not.toContain('No route for');
  });

  it('api keys keep their scopes', async () => {
    await apiKeysApi.create('Scoped', ['workflow:read', 'tag:list']);
    await apiKeysApi.create('Full');
    const keys = await apiKeysApi.list();
    expect(keys.map((k) => [k.name, k.scopes])).toEqual([
      ['Scoped', ['workflow:read', 'tag:list']],
      ['Full', []],
    ]);
  });

  it('favorites accept a data table, named by the mock', async () => {
    const { demo, tables } = await backendWithMockedTables();
    tables.dataTableName.mockReturnValue('Leads');
    const add = (resourceType: string, resourceId: string) =>
      demo.handle({ method: 'POST', path: '/favorites', body: { resourceType, resourceId } });
    expect((await add('dataTable', 't1')).body).toMatchObject({
      data: { resourceType: 'dataTable', resourceId: 't1', name: 'Leads' },
    });
    expect(tables.dataTableName).toHaveBeenCalledWith('t1');
    const list = () => demo.handle({ method: 'GET', path: '/favorites' });
    expect((await list()).body).toMatchObject({ data: [{ resourceType: 'dataTable', name: 'Leads' }] });
    // a removed table leaves the list
    tables.dataTableName.mockReturnValue(undefined);
    expect((await list()).body).toEqual({ data: [] });
    expect((await add('dataTable', 'gone')).status).toBe(404);
    expect((await add('other', 'x')).status).toBe(400);
  });

  it("the Data Table locator's list goes to the mock, every other list stays as it was", async () => {
    const { demo, tables } = await backendWithMockedTables();
    tables.searchDataTables.mockReturnValue({ results: [{ name: 'Leads', value: 't1' }] });
    const search = (method: string, filter?: string) =>
      demo.handle({
        method: 'POST',
        path: '/node-types/options',
        body: {
          kind: 'listSearch',
          method,
          filter,
          projectId: demo.defaultProjectFor(demo.auth().tenant.id).id,
        },
      });
    expect((await search('tableSearch', 'lea')).body).toEqual({
      data: { results: [{ name: 'Leads', value: 't1' }] },
    });
    expect(tables.searchDataTables).toHaveBeenCalledWith('lea');
    const other = (await search('searchContacts')).body as { data: { results: unknown[] } };
    expect(other.data.results.length).toBeGreaterThan(0);
    expect(tables.searchDataTables).toHaveBeenCalledTimes(1);
  });

  it('a form trigger gets form test URLs on listen and webhook URLs; a webhook none', async () => {
    const wf = backend().seedWorkflow({
      name: 'Forms',
      nodes: [
        nodeOf('Form', 'core.formTrigger', { path: 'signup' }),
        nodeOf('Hook', 'core.webhook', { path: 'hook' }),
      ],
      connections: {},
    });
    const form = await workflowsApi.listenTestWebhook(wf.id, 'Form');
    expect(form.formTestUrls).toHaveLength(1);
    expect(form.formTestUrls[0]).toMatch(/\/form-test\/[^/]+\/signup$/);
    expect(form.testUrl).toBe(form.formTestUrls[0]);
    const hook = await workflowsApi.listenTestWebhook(wf.id, 'Hook');
    expect(hook.formTestUrls).toEqual([]);
    expect(hook.testUrl).toMatch(/\/webhook-test\/[^/]+\/hook$/);

    const urls = await workflowsApi.webhookUrls(wf.id);
    const formUrls = urls.filter((u) => u.nodeName === 'Form');
    expect(formUrls).toHaveLength(1);
    expect(formUrls[0].method).toBe('GET');
    expect(formUrls[0].testUrl).toMatch(/\/form-test\/[^/]+\/signup$/);
    expect(formUrls[0].productionUrl).toMatch(/\/form\/[^/]+\/signup$/);
  });

  it('the simulator hands a Data Table node to the mock', async () => {
    const { demo, tables } = await backendWithMockedTables();
    tables.simulateDataTableNode.mockReturnValue([[{ json: { written: true } }]]);
    const wf = demo.seedWorkflow({
      name: 'Writes',
      nodes: [
        nodeOf('Start', 'core.manualTrigger'),
        nodeOf('Table', 'core.dataTable', { operation: 'insert' }),
      ],
      connections: { Start: { main: [[{ node: 'Table', type: 'main', index: 0 }]] } },
    });
    await demo.handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitFor(() => expect(tables.simulateDataTableNode).toHaveBeenCalledTimes(1));
    const [node, items] = tables.simulateDataTableNode.mock.calls[0];
    expect(node.name).toBe('Table');
    expect(items).toHaveLength(1);
  });

  it('fixtures: Code language and Python field, form nodes, Data Table, Redis Trigger', () => {
    const code = describeOf('core.code');
    const language = code.properties.find((p) => p.name === 'language');
    expect(language?.default).toBe('javaScript');
    expect(language?.options?.map((o) => ('value' in o ? o.value : undefined))).toEqual([
      'javaScript',
      'pythonNative',
    ]);
    const python = code.properties.find((p) => p.name === 'pythonCode');
    expect(python?.typeOptions?.editorLanguage).toBe('python');
    expect(python?.displayOptions?.show?.language).toEqual(['pythonNative', 'python']);
    expect(code.properties.find((p) => p.name === 'jsCode')?.displayOptions?.show?.language).toEqual([
      'javaScript',
    ]);

    expect(describeOf('core.formTrigger').group).toEqual(['trigger']);
    expect(describeOf('core.formTrigger').webhooks?.map((w) => [w.name, w.httpMethod, w.nodeType])).toEqual([
      ['setup', 'GET', 'form'],
      ['default', 'POST', 'form'],
    ]);
    expect(describeOf('core.form').inputs).toEqual(['main']);

    const table = describeOf('core.dataTable');
    const locator = table.properties.find((p) => p.name === 'dataTableId');
    const listMode = locator?.modes?.find((m) => m.type === 'list');
    expect(listMode?.typeOptions?.searchListMethod).toBe('tableSearch');
    expect(listMode?.typeOptions?.allowNewResource?.url).toBe('/data-tables');

    const redis = describeOf('app.redisTrigger');
    expect(redis.group).toEqual(['trigger']);
    expect(redis.webhooks ?? []).toEqual([]);
    expect(redis.credentials?.[0].name).toBe('redis');
    expect(demoCredentialTypes.some((c) => c.name === 'redis')).toBe(true);
  });
});

describe('call sites', () => {
  beforeEach(() => void signedIn());

  const taskData: TaskData = { startTime: 1, executionTime: 1, executionStatus: 'success', source: [] };

  it('nodeExecuteAfter calls maybeOpenFormPopup, once and only for a run it follows', () => {
    const receive = useRunStore.getState().receive;
    useRunStore.getState().beginRun('w1');
    receive(
      { type: 'executionStarted', data: { executionId: 'e1', workflowId: 'w1', mode: 'manual' } },
      'w1',
    );
    useRunStore.getState().adopt('e1');
    receive(
      { type: 'nodeExecuteAfter', data: { executionId: 'e1', nodeName: 'Form', runIndex: 0, taskData } },
      'w1',
    );
    expect(maybeOpenFormPopup).toHaveBeenCalledTimes(1);
    expect(maybeOpenFormPopup).toHaveBeenCalledWith(taskData);

    receive(
      { type: 'nodeExecuteAfter', data: { executionId: 'other', nodeName: 'Form', runIndex: 0, taskData } },
      'w1',
    );
    expect(maybeOpenFormPopup).toHaveBeenCalledTimes(1);
  });

  it('events buffered before the run is adopted count, once', () => {
    const after = {
      type: 'nodeExecuteAfter' as const,
      data: { executionId: 'e2', nodeName: 'Form', runIndex: 0, taskData },
    };
    useRunStore.getState().beginListening('w1', { nodeName: 'Form', testUrl: 'u', expiresAt: 'x' });
    useRunStore.getState().receive(after, 'w1');
    expect(maybeOpenFormPopup).not.toHaveBeenCalled();
    useRunStore.getState().adopt('e2');
    expect(maybeOpenFormPopup).toHaveBeenCalledTimes(1);

    vi.mocked(maybeOpenFormPopup).mockClear();
    useRunStore.getState().reset();
    useRunStore.getState().beginListening('w1', { nodeName: 'Form', testUrl: 'u', expiresAt: 'x' });
    useRunStore.getState().receive(after, 'w1');
    useRunStore
      .getState()
      .receive({ type: 'testWebhookReceived', data: { workflowId: 'w1', executionId: 'e2' } }, 'w1');
    expect(maybeOpenFormPopup).toHaveBeenCalledTimes(1);
  });

  describe('listenForTestEvent', () => {
    const deps = { navigate: vi.fn(), descriptions: { get: () => undefined } };

    it('opens the first form test URL for a form trigger', async () => {
      const wf = backend().seedWorkflow({
        name: 'Forms',
        nodes: [nodeOf('Form', 'core.formTrigger', { path: 'signup' })],
        connections: {},
      });
      useWorkflowStore.getState().load(await workflowsApi.get(wf.id));
      await listenForTestEvent(deps, 'Form');
      expect(openTestForm).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openTestForm).mock.calls[0][0]).toMatch(/\/form-test\/[^/]+\/signup$/);
    });

    it('opens nothing for a webhook', async () => {
      const wf = backend().seedWorkflow({
        name: 'Hooks',
        nodes: [nodeOf('Hook', 'core.webhook', { path: 'hook' })],
        connections: {},
      });
      useWorkflowStore.getState().load(await workflowsApi.get(wf.id));
      await listenForTestEvent(deps, 'Hook');
      expect(openTestForm).not.toHaveBeenCalled();
    });
  });

  describe('NodeDetailsView', () => {
    async function open(node: WorkflowNode) {
      const wf = backend().seedWorkflow({ name: 'Panel', nodes: [node], connections: {} });
      act(() => useWorkflowStore.getState().load({ ...wf }));
      withProviders(<NodeDetailsView nodeName={node.name} readOnly={false} onClose={() => undefined} />);
      await screen.findByText(node.name === 'Form' ? 'This node starts the workflow' : 'Settings');
      return wf;
    }

    it('offers the test form of a listening form trigger and opens it', async () => {
      const wf = await open(nodeOf('Form', 'core.formTrigger', { path: 'signup' }));
      expect(screen.queryByRole('button', { name: 'Open test form' })).toBeNull();
      const url = 'http://localhost/form-test/acme/signup';
      act(() =>
        useRunStore
          .getState()
          .beginListening(wf.id, { nodeName: 'Form', testUrl: url, expiresAt: '2030-01-01T00:00:00Z' }),
      );
      await userEvent.click(await screen.findByRole('button', { name: 'Open test form' }));
      expect(openTestForm).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openTestForm).mock.calls[0][0]).toBe(url);
    });

    it('renders the storage callout only for a Data Table node', async () => {
      await open(nodeOf('Table', 'core.dataTable'));
      expect(screen.getByText('storage callout stub')).toBeTruthy();
    });

    it('renders no storage callout for other nodes', async () => {
      await open(nodeOf('Code', 'core.code'));
      expect(screen.queryByText('storage callout stub')).toBeNull();
    });
  });

  it('ParameterForm passes a change through applyCodeDefaults and writes what it adds', async () => {
    vi.mocked(applyCodeDefaults).mockImplementation((_type, _prev, next) =>
      next.language === 'pythonNative' ? { ...next, pythonCode: 'swapped' } : next,
    );
    const code = describeOf('core.code');
    const { node } = renderParameters(code, { parameters: { language: 'javaScript', jsCode: 'x' } });
    // the select's values are option indexes
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: '1' } });
    expect(applyCodeDefaults).toHaveBeenCalledWith(
      'core.code',
      { language: 'javaScript', jsCode: 'x' },
      { language: 'pythonNative', jsCode: 'x' },
    );
    await waitFor(() =>
      expect(node.current.parameters).toEqual({
        language: 'pythonNative',
        jsCode: 'x',
        pythonCode: 'swapped',
      }),
    );
  });

  it('CodeInput maps python and keeps JavaScript', () => {
    const code = describeOf('core.code');
    const python = renderParameters(code, { parameters: { language: 'pythonNative' } });
    expect(screen.getByTestId('code-editor-python')).toBeTruthy();
    python.unmount();
    renderParameters(code, { parameters: { language: 'javaScript' } });
    expect(screen.getByTestId('code-editor-javascript')).toBeTruthy();
  });

  it('completions offer $execution.resumeFormUrl', () => {
    const result = completeExpression('$execution.resumeF', {
      inputFields: () => [],
      nodeNames: [],
      nodeFields: () => [],
      variables: [],
    })!;
    expect(result.options.map((o) => o.label)).toEqual(['resumeFormUrl']);
  });
});

describe('dev proxy', () => {
  const proxy = (viteConfig as (env: { mode: string; command: 'serve' }) => { server: { proxy: object } })({
    mode: 'development',
    command: 'serve',
  }).server.proxy;
  const proxied = (path: string) =>
    Object.keys(proxy).some((key) =>
      key.startsWith('^') ? new RegExp(key).test(path) : path.startsWith(key),
    );

  it('sends form URLs to the server and leaves the SPA route /form-auth alone', () => {
    expect(Object.keys(proxy)).toEqual(
      expect.arrayContaining(['^/form/', '^/form-test/', '^/form-waiting/']),
    );
    expect(proxied('/form/acme/signup')).toBe(true);
    expect(proxied('/form-test/acme/signup')).toBe(true);
    expect(proxied('/form-waiting/e1')).toBe(true);
    expect(proxied('/form-auth')).toBe(false);
    expect(proxied('/form-auth?redirect=x')).toBe(false);
    expect(proxied('/webhook/acme/x')).toBe(true);
  });
});
