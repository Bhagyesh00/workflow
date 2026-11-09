/**
 * P6-23 (L3): data tables belong to one project. A true `member` (invited as `member`, given a project role
 * through `addToProject`) holds what its project gives it: `scopes` on a table, 403 with n8n's text on another
 * project's table, lists narrowed to the caller's projects. A node reaches only its project's tables, by id and
 * by name. Names are unique per project, not per workspace.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  dataTableIn,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

/** an owner, a member and two team projects; the member is `role` in `alpha` and nothing in `beta` */
async function setup(role = 'project:editor') {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await dataTableIn(server, owner.tenant.id, alpha.id, 'In alpha');
  const inBeta = await dataTableIn(server, owner.tenant.id, beta.id, 'In beta');
  return { owner, member, alpha, beta, inAlpha, inBeta };
}

describe('GET /data-tables/:id and lists', () => {
  it('a project editor gets dataTable:update in scopes, the project id and the home project', async () => {
    const { member, alpha, inAlpha } = await setup();
    const res = await member.client.get(`/rest/data-tables/${inAlpha.id}`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.scopes).toContain('dataTable:update');
    expect(data.scopes).toContain('dataTable:read');
    expect(data.projectId).toBe(alpha.id);
    expect(data.homeProject).toMatchObject({ id: alpha.id, name: 'Alpha', type: 'team' });
  });

  it('a project viewer reads but holds no write scope and cannot change the table', async () => {
    const { member, inAlpha } = await setup('project:viewer');
    const data = await member.client.data(member.client.get(`/rest/data-tables/${inAlpha.id}`));
    expect(data.scopes).toContain('dataTable:read');
    expect(data.scopes).not.toContain('dataTable:update');
    expect(data.scopes).not.toContain('dataTable:delete');
    expect((await member.client.patch(`/rest/data-tables/${inAlpha.id}`, { name: 'x' })).statusCode).toBe(
      403,
    );
    expect((await member.client.delete(`/rest/data-tables/${inAlpha.id}`)).statusCode).toBe(403);
    expect(
      (await member.client.post(`/rest/data-tables/${inAlpha.id}/columns`, { name: 'c', type: 'string' }))
        .statusCode,
    ).toBe(403);
  });

  it('answers 403 with n8n text on another project table, for reads and writes', async () => {
    const { member, inBeta } = await setup();
    const id = inBeta.id;
    for (const res of [
      await member.client.get(`/rest/data-tables/${id}`),
      await member.client.patch(`/rest/data-tables/${id}`, { name: 'x' }),
      await member.client.delete(`/rest/data-tables/${id}`),
      await member.client.get(`/rest/data-tables/${id}/columns`),
      await member.client.get(`/rest/data-tables/${id}/rows`),
      await member.client.get(`/rest/data-tables/${id}/dependencies`),
      await member.client.get(`/rest/data-tables/${id}/download-csv`),
      await member.client.post(`/rest/data-tables/${id}/insert`, { data: [] }),
      await member.client.post(`/rest/data-tables/${id}/import-csv`, { csv: 'a\n1' }),
      await member.client.delete(`/rest/data-tables/${id}/rows/clear`),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
  });

  it('another workspace table is 404', async () => {
    const { member } = await setup();
    const other = await signup(server.app);
    const project = (await server.ctx.repos.projects.oldestTeam(other.tenant.id))!.id;
    const foreign = await dataTableIn(server, other.tenant.id, project, 'Foreign');
    expect((await member.client.get(`/rest/data-tables/${foreign.id}`)).statusCode).toBe(404);
    expect((await member.client.get(`/rest/data-tables/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('the list holds only the caller projects; projectId narrows it, includeScopes adds scopes', async () => {
    const { member, owner, alpha, beta } = await setup();
    const names = async (client: typeof member.client, query = '') =>
      (await client.data<{ data: Array<{ name: string }> }>(client.get(`/rest/data-tables${query}`))).data
        .map((row) => row.name)
        .sort();
    expect(await names(member.client)).toEqual(['In alpha']);
    expect(await names(owner.client)).toEqual(['In alpha', 'In beta']);
    expect(await names(owner.client, `?projectId=${beta.id}`)).toEqual(['In beta']);
    const withScopes = await member.client.data<{ data: Array<{ scopes: string[]; projectId: string }> }>(
      member.client.get(`/rest/data-tables?projectId=${alpha.id}&includeScopes=true`),
    );
    expect(withScopes.data).toHaveLength(1);
    expect(withScopes.data[0].projectId).toBe(alpha.id);
    expect(withScopes.data[0].scopes).toContain('dataTable:update');
    const forbidden = await member.client.get(`/rest/data-tables?projectId=${beta.id}`);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.message).toBe(FORBIDDEN);
    // the project filter also travels inside `filter`, as n8n sends it
    const inFilter = await member.client.get(
      `/rest/data-tables?filter=${encodeURIComponent(JSON.stringify({ projectId: beta.id }))}`,
    );
    expect(inFilter.statusCode).toBe(403);
  });

  it('a removed member loses the table on the next call', async () => {
    const { member, owner, alpha, inAlpha } = await setup();
    expect((await member.client.get(`/rest/data-tables/${inAlpha.id}`)).statusCode).toBe(200);
    await server.ctx.repos.projects.relations.remove(owner.tenant.id, alpha.id, member.user.id);
    expect((await member.client.get(`/rest/data-tables/${inAlpha.id}`)).statusCode).toBe(403);
  });
});

describe('create, names and CSV preview', () => {
  it('creates in the named project, and only where the caller holds dataTable:create', async () => {
    const { member, alpha, beta } = await setup();
    const made = await member.client.post('/rest/data-tables', {
      name: 'Made',
      projectId: alpha.id,
      columns: [],
    });
    expect(made.statusCode).toBe(200);
    expect(made.json().data.projectId).toBe(alpha.id);
    expect(made.json().data.scopes).toContain('dataTable:update');
    const denied = await member.client.post('/rest/data-tables', {
      name: 'Nope',
      projectId: beta.id,
      columns: [],
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(FORBIDDEN);
  });

  it('allows the same name in two projects and refuses it twice in one', async () => {
    const { owner, alpha, beta } = await setup();
    const body = (projectId: string) => ({ name: 'Orders', projectId, columns: [] });
    expect((await owner.client.post('/rest/data-tables', body(alpha.id))).statusCode).toBe(200);
    expect((await owner.client.post('/rest/data-tables', body(beta.id))).statusCode).toBe(200);
    const again = await owner.client.post('/rest/data-tables', body(alpha.id));
    expect(again.statusCode).toBe(409);
    // a rename onto a name the project already has is refused too
    const other = await dataTableIn(server, owner.tenant.id, alpha.id, 'Other');
    expect((await owner.client.patch(`/rest/data-tables/${other.id}`, { name: 'Orders' })).statusCode).toBe(
      409,
    );
  });

  it('a true member with no projectId creates in its personal project (Overview), and previews a CSV', async () => {
    const { member } = await setup();
    const made = await member.client.post('/rest/data-tables', { name: 'Mine', columns: [] });
    expect(made.statusCode).toBe(200);
    const personal = await server.ctx.repos.projects.getPersonal(member.tenant.id, member.user.id);
    expect(made.json().data.projectId).toBe(personal!.id);
    const preview = await member.client.post('/rest/data-tables/csv/preview', { csv: 'a,b\n1,2' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.rowCount).toBe(1);
  });

  it('csv/preview takes a body projectId and checks create there', async () => {
    const { member, alpha, beta } = await setup();
    const ok = await member.client.post('/rest/data-tables/csv/preview', {
      csv: 'a,b\n1,2',
      projectId: alpha.id,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.rowCount).toBe(1);
    const denied = await member.client.post('/rest/data-tables/csv/preview', {
      csv: 'a,b\n1,2',
      projectId: beta.id,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(FORBIDDEN);
  });
});

describe('limits and dependencies', () => {
  it('limits stays the workspace total, but names only the tables the caller can list', async () => {
    const { member, owner, inAlpha, inBeta } = await setup();
    const seen = async (client: typeof member.client) =>
      client.data<{ dataTables: Record<string, unknown>; totalBytes: number }>(
        client.get('/rest/data-tables/limits'),
      );
    const asOwner = await seen(owner.client);
    expect(Object.keys(asOwner.dataTables).sort()).toEqual([inAlpha.id, inBeta.id].sort());
    const asMember = await seen(member.client);
    expect(Object.keys(asMember.dataTables)).toEqual([inAlpha.id]);
    expect(asMember.totalBytes).toBe(asOwner.totalBytes);
  });

  it('dependencies names only workflows of the table project the caller can list', async () => {
    const { member, owner, alpha, beta, inAlpha } = await setup();
    const node = (id: string) => [
      {
        id: 'n1',
        name: 'Table',
        type: 'core.dataTable',
        typeVersion: 1,
        position: [0, 0] as [number, number],
        parameters: { dataTableId: { mode: 'id', value: id } },
      },
    ];
    await workflowIn(server, owner.tenant.id, alpha.id, { name: 'Visible', nodes: node(inAlpha.id) });
    // a node of another project never reaches the table, so it is no dependent (the owner sees all projects)
    await workflowIn(server, owner.tenant.id, beta.id, { name: 'Other project', nodes: node(inAlpha.id) });
    const names = async (client: typeof member.client) =>
      (await client.data<Array<{ name: string }>>(client.get(`/rest/data-tables/${inAlpha.id}/dependencies`)))
        .map((row) => row.name)
        .sort();
    expect(await names(owner.client)).toEqual(['Visible']);
    expect(await names(member.client)).toEqual(['Visible']);
  });

  it('a name reference counts only in its own project, where names are unique', async () => {
    const { owner, alpha, beta } = await setup();
    const inA = await dataTableIn(server, owner.tenant.id, alpha.id, 'orders');
    const inB = await dataTableIn(server, owner.tenant.id, beta.id, 'orders');
    const byName = [
      {
        id: 'n1',
        name: 'Table',
        type: 'core.dataTable',
        typeVersion: 1,
        position: [0, 0] as [number, number],
        parameters: { dataTableId: { mode: 'name', value: 'orders' } },
      },
    ];
    await workflowIn(server, owner.tenant.id, beta.id, { name: 'Reads B', nodes: byName });
    const names = async (id: string) =>
      (
        await owner.client.data<Array<{ name: string }>>(
          owner.client.get(`/rest/data-tables/${id}/dependencies`),
        )
      ).map((row) => row.name);
    expect(await names(inA.id)).toEqual([]);
    expect(await names(inB.id)).toEqual(['Reads B']);
  });
});

describe('forProject: what a node reaches', () => {
  it('a node reaches only its project tables, by id and by name', async () => {
    const { owner, alpha, beta, inAlpha, inBeta } = await setup();
    const access = server.ctx.dataTables.forProject(owner.tenant.id, alpha.id);
    expect((await access.getTable({ id: inAlpha.id }))?.name).toBe('In alpha');
    expect((await access.getTable({ name: 'In alpha' }))?.id).toBe(inAlpha.id);
    expect(await access.getTable({ id: inBeta.id })).toBeNull();
    expect(await access.getTable({ name: 'In beta' })).toBeNull();
    expect((await access.listTables()).data.map((t) => t.name)).toEqual(['In alpha']);
    // every operation by id refuses the other project's table
    await expect(access.getRows(inBeta.id)).rejects.toThrow(/could not be found/i);
    await expect(access.listColumns(inBeta.id)).rejects.toThrow(/could not be found/i);
    await expect(access.insertRows(inBeta.id, [{}], 'count')).rejects.toThrow(/could not be found/i);
    await expect(access.clearTable(inBeta.id)).rejects.toThrow(/could not be found/i);
    await expect(access.renameTable(inBeta.id, 'x')).rejects.toThrow(/could not be found/i);
    await expect(access.deleteTable(inBeta.id)).rejects.toThrow(/could not be found/i);
    await expect(access.rowsExist(inBeta.id, { type: 'and', filters: [] })).rejects.toThrow(
      /could not be found/i,
    );
    expect(await server.ctx.repos.dataTables.get(owner.tenant.id, inBeta.id)).toBeDefined();
    const inOther = server.ctx.dataTables.forProject(owner.tenant.id, beta.id);
    expect((await inOther.getTable({ name: 'In beta' }))?.id).toBe(inBeta.id);
  });

  it('a node creates in its project, and the same name lives in two projects', async () => {
    const { owner, alpha, beta } = await setup();
    const made = await server.ctx.dataTables
      .forProject(owner.tenant.id, alpha.id)
      .createTable({ name: 'Shared name', columns: [{ name: 'a', type: 'string' }] });
    const copy = await server.ctx.dataTables
      .forProject(owner.tenant.id, beta.id)
      .createTable({ name: 'Shared name', columns: [] });
    expect(made.id).not.toBe(copy.id);
    expect((await server.ctx.repos.dataTables.get(owner.tenant.id, made.id))?.projectId).toBe(alpha.id);
    expect((await server.ctx.repos.dataTables.get(owner.tenant.id, copy.id))?.projectId).toBe(beta.id);
    // reuseExisting finds the one of its own project
    const again = await server.ctx.dataTables
      .forProject(owner.tenant.id, beta.id)
      .createTable({ name: 'Shared name', columns: [], reuseExisting: true });
    expect(again.id).toBe(copy.id);
  });
});
