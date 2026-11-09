/**
 * P5-04 secrets: a seeded credential secret appears in no output of the tenant MCP server. The loop runs
 * every tool of `tools minus MCP_BUILDER_TOOLS` (L9 has its own loop) against a workspace whose workflows,
 * executions, data tables and folders reference the credential; a tool missing from the argument table
 * fails the test, so a new tool cannot skip the check.
 */
import { randomUUID } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpToolTable } from '../src/services/mcp/server';
import { MCP_BUILDER_TOOLS } from '../src/services/mcp/tools/builder';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import {
  chain,
  node,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

const SECRET = `s3cret-${randomUUID()}`;

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true' });
});
afterAll(async () => {
  await server?.close();
});

let rpcId = 0;
async function rpc(url: string, key: string, method: string, params?: DataObject) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, text: await res.text() };
}

describe('secrets', () => {
  it('a seeded credential secret is absent from every tool output and the tool list', async () => {
    const client = new TestClient(server.app, server.url);
    const id = randomUUID().slice(0, 8);
    const signup = await client.post('/rest/auth/signup', {
      email: `mcp-secrets-${id}@example.com`,
      password: 'Passw0rd!',
      name: `Secrets ${id}`,
      workspaceName: `Secrets ${id}`,
    });
    const { user, tenant } = signup.json().data as {
      user: { id: string };
      tenant: { id: string; slug: string };
    };
    const url = `${server.url}/mcp-server/${tenant.slug}/http`;
    const key = (await server.ctx.auth.createApiKey(tenant.id, user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE))
      .key;

    const credential = await client.data<{ id: string }>(
      client.post('/rest/credentials', {
        name: 'Seeded',
        type: 'httpHeaderAuth',
        data: { name: 'X-Api-Key', value: SECRET },
      }),
    );
    const row = await server.ctx.repos.credentials.get(tenant.id, credential.id);
    const resolved = await server.ctx.credentials.readResolved(row!);
    expect(resolved.value).toBe(SECRET);

    const folder = await client.data<{ id: string }>(client.post('/rest/folders', { name: 'Folder' }));
    await client.data(client.post('/rest/tags', { name: 'tagged' }));
    const workflow = await client.data<{ id: string; versionId: string }>(
      client.post('/rest/workflows', {
        name: 'Seeded workflow',
        nodes: [
          node('Webhook', 'core.webhook', { path: `s-${id}`, httpMethod: 'POST' }, [0, 0], {
            webhookId: randomUUID(),
          }),
          setNode('Set', 'greeting', 'hello'),
          node('Call', 'core.httpRequest', { url: 'http://127.0.0.1:9/never' }, [400, 0], {
            credentials: { httpHeaderAuth: { id: credential.id, name: 'Seeded' } },
          }),
        ],
        connections: chain('Webhook', 'Set', 'Call'),
        settings: { availableInMCP: true },
        folderId: folder.id,
      }),
    );
    await client.data(client.post(`/rest/workflows/${workflow.id}/activate`));
    const table = await server.ctx.dataTables.create(tenant.id, {
      name: 'seeded',
      columns: [{ name: 'item', type: 'string' }],
      projectId: (await server.ctx.repos.projects.getPersonal(tenant.id, user.id))!.id,
    });
    const column = table.columns[0];
    await server.ctx.dataTables.rows.insert(tenant.id, table.id, [{ item: 'pen' }], 'count');
    const run = await server.ctx.workflows.run(
      (await server.ctx.repos.tenants.get(tenant.id))!,
      workflow.id,
      { pinData: { Call: [{ json: { ok: true } }] } },
      { userId: user.id },
    );
    await waitForExecution(server.ctx, tenant.id, run.executionId);
    const versions = await server.ctx.workflows.listVersions(tenant.id, workflow.id, 5);
    const versionId = versions.data[0].versionId;

    const ARGS: Record<string, DataObject> = {
      search_workflows: {},
      get_workflow_details: { workflowId: workflow.id },
      get_workflow_history: { workflowId: workflow.id },
      get_workflow_version: { workflowId: workflow.id, versionId },
      get_workflow_versions_diff: { workflowId: workflow.id, versionId, compareTo: 'current' },
      publish_workflow: { workflowId: workflow.id },
      unpublish_workflow: { workflowId: workflow.id },
      get_workflow_execution: { workflowId: workflow.id, executionId: run.executionId, includeData: true },
      search_workflow_executions: { workflowId: workflow.id },
      execute_workflow: { workflowId: workflow.id, executionMode: 'manual' },
      test_workflow: { workflowId: workflow.id, pinData: { Call: [{ ok: true }] } },
      prepare_workflow_pin_data: { workflowId: workflow.id },
      list_credentials: {},
      list_workflow_tags: {},
      search_data_tables: {},
      get_data_table_rows: { dataTableId: table.id },
      create_data_table: { name: `t${id}`, columns: [] },
      rename_data_table: { dataTableId: table.id, name: 'seeded2' },
      add_data_table_column: { dataTableId: table.id, name: 'extra', type: 'string' },
      rename_data_table_column: { dataTableId: table.id, columnId: column.id, name: 'thing' },
      delete_data_table_column: { dataTableId: table.id, columnId: randomUUID() },
      add_data_table_rows: { dataTableId: table.id, rows: [{ thing: 'cup' }] },
      search_folders: {},
      search_projects: {},
      create_folder: { name: 'Another' },
      update_folder: { folderId: folder.id, name: 'Renamed' },
      move_workflows_to_folder: { workflowIds: [workflow.id], folderId: null },
    };

    const listed = await rpc(url, key, 'tools/list');
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain(SECRET);

    const builder = new Set(MCP_BUILDER_TOOLS);
    const tools = mcpToolTable().filter((tool) => !builder.has(tool));
    expect(tools.length).toBe(Object.keys(ARGS).length);
    let answered = 0;
    for (const tool of tools) {
      const args = ARGS[tool.name];
      expect(args, `no arguments for ${tool.name}`).toBeDefined();
      for (const input of [args, {}]) {
        const res = await rpc(url, key, 'tools/call', { name: tool.name, arguments: input });
        expect(res.text, tool.name).not.toContain(SECRET);
        expect(res.text, tool.name).not.toContain('X-Api-Key');
        if (input === args && res.status === 200 && !JSON.parse(res.text).result?.isError) answered++;
      }
    }
    // the loop really exercised the tools (only the made-up column id is refused)
    expect(answered).toBe(tools.length - 1);

    // the credential is listed by id, name and type only
    const creds = await rpc(url, key, 'tools/call', { name: 'list_credentials', arguments: {} });
    expect(JSON.parse(creds.text).result.structuredContent.data).toEqual([
      { id: credential.id, name: 'Seeded', type: 'httpHeaderAuth' },
    ]);
  });
});
