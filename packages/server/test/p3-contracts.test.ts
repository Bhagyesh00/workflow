/**
 * Phase 3 contract step (C0a): migrations 0003-0011, schema fields, routes, access checks and the
 * real C0 code. Stub return values are never asserted (lanes fill those).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { migrationsFolder } from '../src/db/client';
import {
  chain,
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const pool = () => server.ctx.database.pool;

/** a member of `owner`'s workspace with the given role */
async function member(owner: Awaited<ReturnType<typeof signup>>, role: 'admin' | 'editor' | 'viewer') {
  return (await memberAs(owner, role)).client;
}

const api = (
  key: string | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: key ? { 'x-api-key': key } : {},
    payload: payload as object,
  });

const manual = () => ({
  nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'greeting', 'hi')],
  connections: chain('Start', 'Set'),
});

describe('P3 migrations', () => {
  it('applies 0003-0011 in journal order', () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
    expect(
      journal.entries.map((e: { idx: number; tag: string }) => `${e.idx}:${e.tag}`).slice(3, 12),
    ).toEqual([
      '3:0003_node_groups',
      '4:0004_folders_archive_favorites',
      '5:0005_execution_annotations',
      '6:0006_named_versions',
      '7:0007_folder_tags',
      '8:0008_publish_history',
      '9:0009_version_autosave',
      '10:0010_workflow_reviews',
      '11:0011_review_version_ids',
    ]);
  });

  it('creates the new tables with row-level security and the new columns', async () => {
    const tables = [
      'folders',
      'user_favorites',
      'annotation_tags',
      'execution_annotations',
      'execution_annotation_tags',
      'folder_tags',
      'workflow_publish_history',
      'workflow_review_requests',
      'workflow_review_reviewers',
      'workflow_review_authors',
      'workflow_review_activity',
      'workflow_review_comments',
    ];
    const { rows } = await pool().query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
      [tables],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await pool().query<{ tablename: string }>(
      `select tablename from pg_policies where policyname = 'tenant_isolation' and tablename = any($1)`,
      [tables],
    );
    expect(policies.rows).toHaveLength(tables.length);

    const columns = await pool().query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where (table_name, column_name) in (('workflows','node_groups'), ('workflows','folder_id'),
          ('workflows','is_archived'), ('workflows','published_version_id'), ('workflow_versions','node_groups'),
          ('workflow_versions','version_name'), ('workflow_versions','description'), ('workflow_versions','autosaved'),
          ('executions','workflow_version_id'))`,
    );
    expect(columns.rows).toHaveLength(9);
  });

  it('0006 backfills the published pointer of active workflows; setActive keeps it in step', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, manual());
    const idle = await createWorkflow(client, manual());
    // a row as it was before 0006: active without a pointer
    await pool().query('update workflows set active = true, published_version_id = null where id = $1', [
      wf.id,
    ]);
    const backfill = readFileSync(path.join(migrationsFolder, '0006_named_versions.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.startsWith('UPDATE'));
    expect(backfill).toBeDefined();
    await pool().query(backfill!);
    const after = await pool().query(
      'select id, published_version_id, version_id from workflows order by id',
    );
    const byId = Object.fromEntries(after.rows.map((r) => [r.id, r]));
    expect(byId[wf.id].published_version_id).toBe(byId[wf.id].version_id);
    expect(byId[idle.id].published_version_id).toBeNull();

    const off = await server.ctx.repos.workflows.setActive(tenant.id, wf.id, false);
    expect(off?.publishedVersionId).toBeNull();
    const on = await server.ctx.repos.workflows.setActive(tenant.id, wf.id, true);
    expect(on?.publishedVersionId).toBe(on?.versionId);
    const unpublished = await server.ctx.repos.workflows.setPublished(tenant.id, wf.id, null);
    expect(unpublished).toMatchObject({ active: false, publishedVersionId: null });
  });

  it('0011 keeps the review version ids when the version row is gone (no FK, as executions)', async () => {
    const fks = await pool().query<{ conname: string }>(
      `select conname from pg_constraint
        where contype = 'f' and conrelid = 'workflow_review_requests'::regclass
          and confrelid = 'workflow_versions'::regclass`,
    );
    expect(fks.rows).toEqual([]);

    const { tenant } = await signup(server.app);
    const pruned = '00000000-0000-4000-8000-0000000000aa';
    const baseline = '00000000-0000-4000-8000-0000000000bb';
    const { rows } = await pool().query(
      `insert into workflow_review_requests
         (tenant_id, workflow_version_id, approved_baseline_version_id, title, state, decision)
       values ($1, $2, $3, 'Pruned', 'closed', 'approved')
       returning workflow_version_id, approved_baseline_version_id`,
      [tenant.id, pruned, baseline],
    );
    expect(rows[0]).toEqual({ workflow_version_id: pruned, approved_baseline_version_id: baseline });
  });

  it('0010 inserts a review request without an approved baseline', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, manual());
    const { rows } = await pool().query(
      `insert into workflow_review_requests (tenant_id, workflow_id, workflow_version_id, title)
       values ($1, $2, $3, 'Check it') returning approved_baseline_version_id, state, decision`,
      [tenant.id, wf.id, wf.versionId],
    );
    expect(rows[0]).toEqual({ approved_baseline_version_id: null, state: 'open', decision: 'pending' });
    // one open request per workflow
    await expect(
      pool().query(
        `insert into workflow_review_requests (tenant_id, workflow_id, title) values ($1, $2, 'Again')`,
        [tenant.id, wf.id],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('P3 workflows API', () => {
  it('keeps nodeGroups through create, get, versions and restore', async () => {
    const { client } = await signup(server.app);
    const def = manual();
    const groups = [
      { id: 'g1', name: 'Group', nodeIds: [def.nodes[1].id], description: 'Sets the greeting' },
    ];
    const created = await client.data(
      client.post('/rest/workflows', { name: 'G', ...def, nodeGroups: groups }),
    );
    expect(created.nodeGroups).toEqual(groups);
    expect(created).toMatchObject({ folderId: null, isArchived: false, publishedVersionId: null });
    expect((await client.data(client.get(`/rest/workflows/${created.id}`))).nodeGroups).toEqual(groups);
    const version = await client.data(
      client.get(`/rest/workflows/${created.id}/versions/${created.versionId}`),
    );
    expect(version.nodeGroups).toEqual(groups);

    const cleared = await client.data(
      client.patch(`/rest/workflows/${created.id}`, { versionId: created.versionId, nodeGroups: [] }),
    );
    expect(cleared.nodeGroups).toEqual([]);
    const restored = await client.data(
      client.post(`/rest/workflows/${created.id}/versions/${created.versionId}/restore`),
    );
    expect(restored.nodeGroups).toEqual(groups);
  });

  it('rejects a group description over 145 characters', async () => {
    const { client } = await signup(server.app);
    const res = await client.post('/rest/workflows', {
      name: 'G',
      ...manual(),
      nodeGroups: [{ id: 'g1', name: 'Group', nodeIds: [], description: 'x'.repeat(146) }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores autosaved on the version and lists it', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, manual());
    await client.data(
      client.patch(`/rest/workflows/${wf.id}`, { versionId: wf.versionId, name: 'A', autosaved: true }),
    );
    const versions = (await client.get(`/rest/workflows/${wf.id}/versions`)).json().data;
    expect(versions.map((v: { autosaved: boolean }) => v.autosaved)).toEqual([true, false]);
    expect(versions[0]).toMatchObject({ versionName: null, description: null });
  });

  it('hides archived workflows unless archived=true or all', async () => {
    const { client, tenant } = await signup(server.app);
    const kept = await createWorkflow(client, { name: 'Kept', nodes: [] });
    const gone = await createWorkflow(client, { name: 'Gone', nodes: [] });
    await server.ctx.repos.workflows.setArchived(tenant.id, gone.id, true);
    const names = async (query: string) =>
      (await client.get(`/rest/workflows${query}`))
        .json()
        .data.map((w: { name: string }) => w.name)
        .sort();
    expect(await names('')).toEqual(['Kept']);
    expect(await names('?archived=true')).toEqual(['Gone']);
    expect(await names('?archived=all')).toEqual(['Gone', 'Kept']);
    const all = (await client.get('/rest/workflows?archived=all')).json().data;
    expect(all.find((w: { id: string }) => w.id === gone.id)).toMatchObject({
      isArchived: true,
      folderId: null,
      publishedVersionId: null,
    });
    expect(kept.id).toBeDefined();
    expect((await client.get('/rest/workflows?archived=maybe')).statusCode).toBe(400);
  });

  it('filters by folder (uuid or root)', async () => {
    const { client, tenant } = await signup(server.app);
    const a = await createWorkflow(client, { name: 'A', nodes: [] });
    await createWorkflow(client, { name: 'B', nodes: [] });
    const { rows } = await pool().query(
      `insert into folders (tenant_id, name, project_id) values ($1, 'F', (select id from projects where tenant_id = $1 and type = 'team' order by created_at, id limit 1)) returning id`,
      [tenant.id],
    );
    expect(await server.ctx.repos.workflows.setFolder(tenant.id, [a.id], rows[0].id)).toEqual([a.id]);
    const names = async (query: string) =>
      (await client.get(`/rest/workflows${query}`)).json().data.map((w: { name: string }) => w.name);
    expect(await names(`?folderId=${rows[0].id}`)).toEqual(['A']);
    expect(await names('?folderId=root')).toEqual(['B']);
    expect((await names('')).sort()).toEqual(['A', 'B']);
  });

  it('searches names, node types and tag names (command bar)', async () => {
    const { client } = await signup(server.app);
    await createWorkflow(client, { name: 'Invoice sync', nodes: [] });
    await createWorkflow(client, { name: 'Other', nodes: [node('Code', 'core.code')] });
    const tag = await client.data(client.post('/rest/tags', { name: 'billing' }));
    const tagged = await createWorkflow(client, { name: 'Tagged', nodes: [] });
    await client.data(
      client.patch(`/rest/workflows/${tagged.id}`, { versionId: tagged.versionId, tagIds: [tag.id] }),
    );
    const names = async (query: string) =>
      (await client.get(`/rest/workflows?${query}`))
        .json()
        .data.map((w: { name: string }) => w.name)
        .sort();
    expect(await names('search=invoice')).toEqual(['Invoice sync']);
    expect(await names('search=nothing&nodeTypes=core.code,core.set')).toEqual(['Other']);
    expect(await names('search=bill')).toEqual([]);
    expect(await names('search=bill&matchTags=true')).toEqual(['Tagged']);
    const tooMany = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
    expect((await client.get(`/rest/workflows?search=x&nodeTypes=${tooMany}`)).statusCode).toBe(400);
  });

  it('accepts dirtyNodeNames on a run and records the version that ran', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, manual());
    expect((await client.post(`/rest/workflows/${wf.id}/run`, { dirtyNodeNames: [1] })).statusCode).toBe(400);
    const { executionId } = await client.data(
      client.post(`/rest/workflows/${wf.id}/run`, { dirtyNodeNames: ['Set'] }),
    );
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const data = await server.ctx.repos.executions.getData(tenant.id, executionId);
    expect((data?.runOptions as { dirtyNodeNames?: string[] } | undefined)?.dirtyNodeNames).toEqual(['Set']);
    const summary = (await client.get(`/rest/executions?workflowId=${wf.id}`)).json().data[0];
    expect(summary).toMatchObject({ id: executionId, workflowVersionId: wf.versionId });
    expect(summary).toHaveProperty('annotation');
    const detail = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(detail.workflowVersionId).toBe(wf.versionId);
    const byVersion = (await client.get(`/rest/executions?workflowVersionId=${wf.versionId}`)).json().data;
    expect(byVersion.map((e: { id: string }) => e.id)).toEqual([executionId]);
    const other = '00000000-0000-4000-8000-000000000000';
    expect((await client.get(`/rest/executions?workflowVersionId=${other}`)).json().data).toEqual([]);
    expect((await client.get('/rest/executions?vote=sideways')).statusCode).toBe(400);
    expect((await client.get('/rest/executions?annotationTags=not-a-uuid')).statusCode).toBe(400);
  });

  it('diff against=published needs a published version', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, manual());
    const url = `/rest/workflows/${wf.id}/versions/${wf.versionId}/diff?against=published`;
    expect((await client.get(url)).statusCode).toBe(404);
    await server.ctx.repos.workflows.setPublished(tenant.id, wf.id, wf.versionId);
    expect((await client.data(client.get(url))).to).toBe('published');
  });

  it('checks roles and tenants on the new workflow routes', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const other = await signup(server.app);
    const wf = await createWorkflow(owner.client, manual());
    const id = wf.id;
    const writes: Array<[string, string, unknown]> = [
      ['POST', `/rest/workflows/${id}/archive`, {}],
      ['POST', `/rest/workflows/${id}/unarchive`, {}],
      ['POST', '/rest/workflows/move', { workflowIds: [id], folderId: null }],
      ['POST', '/rest/workflows/from-url', { url: 'https://example.com/w.json' }],
      ['POST', `/rest/workflows/${id}/activate`, {}],
      ['PATCH', `/rest/workflows/${id}/versions/${wf.versionId}`, { versionName: 'v1' }],
    ];
    for (const [method, url, body] of writes) {
      const res = await viewer.request(method as 'POST' | 'PATCH', url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const foreign: Array<[string, string, unknown]> = [
      ['POST', `/rest/workflows/${id}/archive`, {}],
      ['POST', `/rest/workflows/${id}/unarchive`, {}],
      ['POST', '/rest/workflows/move', { workflowIds: [id], folderId: null }],
      ['PATCH', `/rest/workflows/${id}/versions/${wf.versionId}`, { versionName: 'v1' }],
      ['GET', `/rest/workflows/${id}/publish-timeline`, undefined],
      ['GET', `/rest/workflows/${id}/versions/${wf.versionId}/diff?against=published`, undefined],
    ];
    for (const [method, url, body] of foreign) {
      const res = await other.client.request(method as 'GET' | 'POST' | 'PATCH', url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // the viewer reads the timeline of its own tenant
    expect((await viewer.get(`/rest/workflows/${id}/publish-timeline?take=100`)).statusCode).toBe(200);
    expect((await viewer.get(`/rest/workflows/${id}/publish-timeline?take=101`)).statusCode).toBe(400);
    // bodies are validated: from-url takes http(s) only, a version patch needs one field
    expect(
      (await owner.client.post('/rest/workflows/from-url', { url: 'file:///etc/passwd' })).statusCode,
    ).toBe(400);
    expect((await owner.client.patch(`/rest/workflows/${id}/versions/${wf.versionId}`, {})).statusCode).toBe(
      400,
    );
    expect(
      (await owner.client.post(`/rest/workflows/${id}/activate`, { versionName: 'x'.repeat(129) }))
        .statusCode,
    ).toBe(400);
  });

  it('archive before delete keeps the editor delete working', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, manual());
    await client.data(client.post(`/rest/workflows/${wf.id}/archive`));
    expect(await client.data(client.delete(`/rest/workflows/${wf.id}`))).toEqual({ ok: true });
    expect((await client.get(`/rest/workflows/${wf.id}`)).statusCode).toBe(404);
  });
});

describe('P3 executions API', () => {
  it('PATCH /executions/:id: viewer 403, other tenant 404, body checked', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const other = await signup(server.app);
    const wf = await createWorkflow(owner.client, manual());
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    expect((await viewer.patch(`/rest/executions/${executionId}`, { vote: 'up' })).statusCode).toBe(403);
    expect((await other.client.patch(`/rest/executions/${executionId}`, { vote: 'up' })).statusCode).toBe(
      404,
    );
    expect((await owner.client.patch(`/rest/executions/${executionId}`, {})).statusCode).toBe(400);
    expect((await owner.client.patch(`/rest/executions/${executionId}`, { vote: 'meh' })).statusCode).toBe(
      400,
    );
    expect((await owner.client.patch(`/rest/executions/${executionId}`, { vote: null })).statusCode).toBe(
      200,
    );
  });
});

describe('P3 public API', () => {
  async function keys() {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const ownerKey = (await owner.client.data(owner.client.post('/rest/api-keys', { name: 'o' })))
      .key as string;
    const viewerKey = (await viewer.data(viewer.post('/rest/api-keys', { name: 'v' }))).key as string;
    return { owner, ownerKey, viewerKey };
  }

  it('lists the folder routes and the new workflow fields in openapi.json', async () => {
    const doc = (await server.app.inject({ url: '/api/v1/openapi.json' })).json();
    expect(Object.keys(doc.paths['/folders']).sort()).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths['/folders/{folderId}']).sort()).toEqual(['delete', 'get', 'patch']);
    expect(doc.paths['/folders/{folderId}'].delete.parameters.map((p: { name: string }) => p.name)).toContain(
      'transferToFolderId',
    );
    expect(
      doc.paths['/folders'].get.responses[200].content['application/json'].schema.properties.data.items,
    ).toEqual({ $ref: '#/components/schemas/Folder' });
    expect(doc.components.schemas.Folder.properties.tags.items).toEqual({
      $ref: '#/components/schemas/TagRef',
    });
    // the published PATCH body caps tagIds as the handler's folderUpdateSchema does (50)
    const patchBody = doc.paths['/folders/{folderId}'].patch.requestBody.content['application/json'].schema;
    expect(patchBody.properties.tagIds.maxItems).toBe(50);
    expect(doc.paths['/workflows/{id}'].put.parameters.map((p: { name: string }) => p.name)).toContain(
      'publishIfActive',
    );
    expect(doc.paths['/workflows/{id}/archive'].post).toBeDefined();
    expect(doc.paths['/workflows/{id}/unarchive'].post).toBeDefined();
    expect(doc.components.schemas.Workflow.properties.nodeGroups).toBeDefined();
  });

  it('checks keys and roles on the folder and archive routes', async () => {
    const { ownerKey, viewerKey } = await keys();
    expect((await api(undefined, 'GET', '/folders')).statusCode).toBe(401);
    expect((await api(viewerKey, 'POST', '/folders', { name: 'F' })).statusCode).toBe(403);
    // GET /folders/:folderId is folder:read, as the list: a viewer passes the role check (L16 stub: 501)
    const folderId = '00000000-0000-4000-8000-000000000001';
    expect([200, 404, 501]).toContain((await api(viewerKey, 'GET', `/folders/${folderId}`)).statusCode);
    expect((await api(viewerKey, 'GET', '/folders')).statusCode).not.toBe(403);
    const wf = await api(ownerKey, 'POST', '/workflows', { name: 'W', nodes: [] });
    const id = wf.json().data.id;
    expect((await api(viewerKey, 'POST', `/workflows/${id}/archive`)).statusCode).toBe(403);
    expect((await api(viewerKey, 'POST', `/workflows/${id}/unarchive`)).statusCode).toBe(403);
    const other = await keys();
    expect((await api(other.ownerKey, 'POST', `/workflows/${id}/archive`)).statusCode).toBe(404);
    expect((await api(other.ownerKey, 'POST', `/workflows/${id}/unarchive`)).statusCode).toBe(404);
    expect((await api(other.ownerKey, 'POST', `/workflows/${id}/activate`, {})).statusCode).toBe(404);
    expect(
      (await api(ownerKey, 'PUT', `/workflows/${id}?publishIfActive=maybe`, { name: 'X' })).statusCode,
    ).toBe(400);
    expect(
      (await api(ownerKey, 'PUT', `/workflows/${id}?publishIfActive=false`, { name: 'X' })).statusCode,
    ).toBe(200);
    // the public API deletes without archiving first
    expect((await api(ownerKey, 'DELETE', `/workflows/${id}`)).json().data).toEqual({ ok: true });
  });
});

describe('P3 settings and config', () => {
  it('serves CSP media-src and frame-src for previews', async () => {
    const res = await server.app.inject({ url: '/rest/settings' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("media-src 'self' blob: data:");
    expect(csp).toContain("frame-src 'self' blob:");
  });

  it('workflowReviews: editor 403, admin 200; GET returns it with autosaveEnabled', async () => {
    const owner = await signup(server.app);
    const editor = await member(owner, 'editor');
    const admin = await member(owner, 'admin');
    expect((await editor.patch('/rest/settings', { workflowReviews: { enabled: true } })).statusCode).toBe(
      403,
    );
    const before = await owner.client.data(owner.client.get('/rest/settings'));
    expect(before).toMatchObject({ autosaveEnabled: true, workflowReviews: { enabled: false } });
    const patched = await admin.data(admin.patch('/rest/settings', { workflowReviews: { enabled: true } }));
    expect(patched).toMatchObject({ autosaveEnabled: true, workflowReviews: { enabled: true } });
    // other settings stay
    await admin.data(admin.patch('/rest/settings', { timezone: 'Europe/Berlin' }));
    const after = await owner.client.data(owner.client.get('/rest/settings'));
    expect(after).toMatchObject({ timezone: 'Europe/Berlin', workflowReviews: { enabled: true } });
    const audit = await pool().query(
      `select count(*)::int as n from audit_log where tenant_id = $1 and action = 'tenant.settings_updated'`,
      [owner.tenant.id],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('autosaveEnabled follows WORKFLOWS_AUTOSAVE_DISABLED', async () => {
    expect(loadConfig({ NODE_ENV: 'test' }).autosaveDisabled).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', WORKFLOWS_AUTOSAVE_DISABLED: 'true' }).autosaveDisabled).toBe(true);
    const off = await createTestServer(
      { WORKFLOWS_AUTOSAVE_DISABLED: 'true' },
      { startMain: false, reset: false },
    );
    try {
      const res = await off.app.inject({ url: '/rest/settings' });
      expect(res.json().data.autosaveEnabled).toBe(false);
    } finally {
      await off.close();
    }
  });

  it('reads the history compaction settings from the environment', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).historyCompaction).toEqual({
      optimizingMinimumAgeHours: 0.25,
      optimizingTimeWindowHours: 2,
      trimmingMinimumAgeDays: 6,
      trimmingTimeWindowDays: 2,
      batchSize: 100,
      batchDelayMs: 1000,
    });
    const config = loadConfig({
      NODE_ENV: 'test',
      WORKFLOW_HISTORY_OPTIMIZING_MINIMUM_AGE_HOURS: '0.5',
      WORKFLOW_HISTORY_OPTIMIZING_TIME_WINDOW_HOURS: '3',
      WORKFLOW_HISTORY_TRIMMING_MINIMUM_AGE_DAYS: '7',
      WORKFLOW_HISTORY_TRIMMING_TIME_WINDOW_DAYS: '1',
      WORKFLOW_HISTORY_COMPACTION_BATCH_SIZE: '10',
      WORKFLOW_HISTORY_COMPACTION_BATCH_DELAY_MS: '0',
    });
    expect(config.historyCompaction).toEqual({
      optimizingMinimumAgeHours: 0.5,
      optimizingTimeWindowHours: 3,
      trimmingMinimumAgeDays: 7,
      trimmingTimeWindowDays: 1,
      batchSize: 10,
      batchDelayMs: 0,
    });
  });

  it('wires the Phase 3 services and repositories', () => {
    const { ctx } = server;
    for (const name of [
      'folders',
      'favorites',
      'workflowArchive',
      'annotations',
      'workflowImportUrl',
      'publishHistory',
      'historyCompaction',
      'reviews',
    ] as const) {
      expect(ctx[name], name).toBeDefined();
    }
    for (const name of ['folders', 'favorites', 'annotations', 'publishHistory', 'reviews'] as const) {
      expect(ctx.repos[name], name).toBeDefined();
    }
  });
});
