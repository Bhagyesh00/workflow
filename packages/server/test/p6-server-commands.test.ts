/**
 * P6-78 (L11): the workflow server commands, `export:nodes` and `audit`. Every tenant-data command needs
 * `--tenant <slug>`; a workflow exports from one workspace and imports into another with its sub-workflow
 * reference rewritten; a node type a policy blocks refuses that file with its violations and a non-zero exit;
 * another workspace's id never shows in the output. Output goes through a fake `CommandIo`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCommand } from '../src/commands/audit';
import type { CommandIo } from '../src/commands/command-io';
import { exportCredentialsCommand } from '../src/commands/credentials-export';
import { importCredentialsCommand } from '../src/commands/credentials-import';
import { executeCommand } from '../src/commands/execute';
import { executeBatchCommand } from '../src/commands/execute-batch';
import { exportNodesCommand } from '../src/commands/nodes-export';
import { exportWorkflowCommand } from '../src/commands/workflow-export';
import { importWorkflowCommand } from '../src/commands/workflow-import';
import { listWorkflowCommand } from '../src/commands/workflow-list';
import { publishWorkflowCommand, unpublishWorkflowCommand } from '../src/commands/workflow-publish';
import {
  createTestServer,
  flushRedis,
  node,
  policyDeny,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;
let dir: string;
beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  dir = await mkdtemp(path.join(tmpdir(), 'p6-commands-'));
});
afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

let ipCounter = 0;
const nextIp = () => `10.78.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

interface FakeIo {
  io: CommandIo;
  stdout: () => string;
  stderr: () => string;
  files: Map<string, string>;
  writes: Array<{ path: string; mode?: number }>;
}

/** an io that keeps files in memory (seeded from `files`) and records what is printed and the mode of each write */
function fakeIo(files: Record<string, string> = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const store = new Map(Object.entries(files));
  const writes: FakeIo['writes'] = [];
  return {
    io: {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
      readFile: async (file) => {
        const data = store.get(file);
        if (data === undefined) throw new Error(`No such file: ${file}`);
        return data;
      },
      writeFile: async (file, data, options) => {
        store.set(file, data);
        writes.push({ path: file, mode: options.mode });
      },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    files: store,
    writes,
  };
}

/** a workspace with only its owner's personal project; `team` also makes one team project */
async function workspace(team = false) {
  const s = await signup(server.app, { remoteAddress: nextIp(), projects: team ? 'team' : 'real' });
  const personal = await server.ctx.repos.projects.getPersonal(s.tenant.id, s.user.id);
  return {
    ...s,
    slug: s.tenant.slug,
    tenantId: s.tenant.id,
    personalId: personal!.id,
    teamId: s.client.defaultProjectId,
  };
}

interface Row {
  id: string;
  name: string;
  nodes: any[];
  settings: Record<string, any>;
  project_id: string;
  active: boolean;
}
const rowsOf = async (tenantId: string) =>
  (
    await server.ctx.database.pool.query(
      'select id, name, nodes, settings, project_id, active from workflows where tenant_id = $1 order by name',
      [tenantId],
    )
  ).rows as Row[];

/** a workflow made through the REST route, so it has its first version row (publish needs it) */
async function savedWorkflow(
  a: Awaited<ReturnType<typeof workspace>>,
  name: string,
  nodes: unknown[] = [node('S', 'core.manualTrigger')],
) {
  return a.client.data<{ id: string; versionId: string }>(
    a.client.post('/rest/workflows', { name, nodes, connections: {}, settings: {} }),
  );
}

const subWorkflowNode = (name: string, id: string) =>
  node(name, 'core.executeWorkflow', {
    source: 'database',
    workflowId: { __rl: true, mode: 'id', value: id },
  });
const webhookNode = () =>
  node('Hook', 'core.webhook', { httpMethod: 'POST', path: `p-${randomUUID()}` }, [0, 0], {
    webhookId: randomUUID(),
  });

describe('P6-78 tenant option', () => {
  it('refuses every tenant command without --tenant, and an unknown slug', async () => {
    const commands = [
      exportWorkflowCommand,
      importWorkflowCommand,
      listWorkflowCommand,
      publishWorkflowCommand,
      unpublishWorkflowCommand,
      exportCredentialsCommand,
      importCredentialsCommand,
      executeCommand,
      executeBatchCommand,
      auditCommand,
    ];
    for (const command of commands) {
      const f = fakeIo();
      expect(await command(server.ctx, [], f.io)).toBe(2);
      expect(f.stderr()).toContain('--tenant');
    }
    const f = fakeIo();
    expect(await listWorkflowCommand(server.ctx, ['--tenant', `nope-${randomUUID()}`], f.io)).toBe(1);
    expect(f.stderr()).toContain('No workspace has the slug');
  });
});

describe('P6-78 export:workflow and import:workflow', () => {
  it('exports from one workspace and imports into another with the sub-workflow reference rewritten', async () => {
    const a = await workspace();
    const b = await workspace();
    const child = await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Child',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    const parent = await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Parent',
      nodes: [node('Start', 'core.manualTrigger'), subWorkflowNode('Call', child.id)],
      settings: { errorWorkflow: child.id },
    });

    const exported = fakeIo();
    expect(
      await exportWorkflowCommand(
        server.ctx,
        ['--tenant', a.slug, '--all', '--output', '/x/all.json'],
        exported.io,
      ),
    ).toBe(0);
    const text = exported.files.get('/x/all.json') ?? '';
    const file = JSON.parse(text) as Array<{ id: string; name: string }>;
    expect(file.map((w) => w.name).sort()).toEqual(['Child', 'Parent']);
    expect(text).not.toContain(a.tenantId);

    const imported = fakeIo({ '/x/all.json': text });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', b.slug, '--input', '/x/all.json'], imported.io),
    ).toBe(0);
    const printed = imported.stdout() + imported.stderr();
    // another workspace's id never shows in the output
    expect(printed).not.toContain(child.id);
    expect(printed).not.toContain(parent.id);

    const inB = await rowsOf(b.tenantId);
    expect(inB.map((w) => w.name)).toEqual(['Child', 'Parent']);
    const newChild = inB.find((w) => w.name === 'Child')!;
    const newParent = inB.find((w) => w.name === 'Parent')!;
    expect(newChild.id).not.toBe(child.id);
    expect(newParent.id).not.toBe(parent.id);
    // B owner's personal project; the reference points at B's copy of the child
    expect(newParent.project_id).toBe(b.personalId);
    const call = newParent.nodes.find((n) => n.name === 'Call');
    expect(call.parameters.workflowId.value).toBe(newChild.id);
    expect(JSON.stringify(newParent.nodes)).not.toContain(child.id);
    expect(newParent.settings.errorWorkflow).toBe(newChild.id);
    // A is unchanged
    expect((await rowsOf(a.tenantId)).map((w) => w.id).sort()).toEqual([child.id, parent.id].sort());
  });

  it('keeps the id of a workflow that is already in the workspace and updates it', async () => {
    const a = await workspace();
    const wf = await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Keep',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    const exported = fakeIo();
    await exportWorkflowCommand(
      server.ctx,
      ['--tenant', a.slug, '--id', wf.id, '--output', '/o.json'],
      exported.io,
    );
    const data = JSON.parse(exported.files.get('/o.json') ?? '[]');
    expect(Array.isArray(data)).toBe(true);
    data[0].name = 'Kept and renamed';
    const imported = fakeIo({ '/o.json': JSON.stringify(data) });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', a.slug, '--input', '/o.json'], imported.io),
    ).toBe(0);
    const after = await rowsOf(a.tenantId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(wf.id);
    expect(after[0].name).toBe('Kept and renamed');
  });

  it('keeps a free id, and a second import of the same file updates it instead of adding a row', async () => {
    const b = await workspace();
    const id = randomUUID();
    const file = (name: string) =>
      JSON.stringify([{ id, name, nodes: [node('Start', 'core.manualTrigger')], connections: {} }]);
    const first = fakeIo({ '/f.json': file('Fresh') });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', b.slug, '--input', '/f.json'], first.io),
    ).toBe(0);
    expect((await rowsOf(b.tenantId)).map((w) => w.id)).toEqual([id]);
    expect(first.stdout()).toContain(id);
    const again = fakeIo({ '/f.json': file('Fresh again') });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', b.slug, '--input', '/f.json'], again.io),
    ).toBe(0);
    const rows = await rowsOf(b.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, name: 'Fresh again' });
  });

  it('gives a new id to an id another workspace holds and never touches that row', async () => {
    const a = await workspace();
    const b = await workspace();
    const wf = await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Theirs',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    const file = JSON.stringify([
      { id: wf.id, name: 'Mine', nodes: [node('Start', 'core.manualTrigger')], connections: {} },
    ]);
    const f = fakeIo({ '/t.json': file });
    expect(await importWorkflowCommand(server.ctx, ['--tenant', b.slug, '--input', '/t.json'], f.io)).toBe(0);
    const inB = await rowsOf(b.tenantId);
    expect(inB).toHaveLength(1);
    expect(inB[0].id).not.toBe(wf.id);
    const inA = await rowsOf(a.tenantId);
    expect(inA).toHaveLength(1);
    expect(inA[0]).toMatchObject({ id: wf.id, name: 'Theirs' });
  });

  it('with --projectId refuses a workflow of this workspace that sits in another project', async () => {
    const a = await workspace(true);
    const wf = await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Personal',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    const file = JSON.stringify([
      { id: wf.id, name: 'Renamed', nodes: [node('Start', 'core.manualTrigger')], connections: {} },
    ]);
    const refused = fakeIo({ '/p.json': file });
    expect(
      await importWorkflowCommand(
        server.ctx,
        ['--tenant', a.slug, '--input', '/p.json', '--projectId', a.teamId as string],
        refused.io,
      ),
    ).toBe(1);
    expect(refused.stderr()).toContain('another project');
    expect((await rowsOf(a.tenantId))[0]).toMatchObject({
      id: wf.id,
      name: 'Personal',
      project_id: a.personalId,
    });
    // without --projectId, or with its own project, the workflow is updated in place
    const ok = fakeIo({ '/p.json': file });
    expect(
      await importWorkflowCommand(
        server.ctx,
        ['--tenant', a.slug, '--input', '/p.json', '--projectId', a.personalId],
        ok.io,
      ),
    ).toBe(0);
    expect((await rowsOf(a.tenantId))[0].name).toBe('Renamed');
  });

  it('the reference rewrite keeps what the first save added (MCP availability of an auto exposing workspace)', async () => {
    const a = await workspace();
    const b = await workspace();
    await b.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true, autoExposeNewWorkflows: true });
    const child = await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Child',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Parent',
      nodes: [node('Start', 'core.manualTrigger'), subWorkflowNode('Call', child.id)],
      settings: { errorWorkflow: child.id },
    });
    const exported = fakeIo();
    await exportWorkflowCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--output', '/r.json'],
      exported.io,
    );
    const imported = fakeIo({ '/r.json': exported.files.get('/r.json') ?? '' });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', b.slug, '--input', '/r.json'], imported.io),
    ).toBe(0);
    const inB = await rowsOf(b.tenantId);
    const newChild = inB.find((w) => w.name === 'Child')!;
    const newParent = inB.find((w) => w.name === 'Parent')!;
    // the reference was rewritten (a second save of the parent) and both stay available in MCP
    expect(newParent.settings.errorWorkflow).toBe(newChild.id);
    expect(newParent.settings.availableInMCP).toBe(true);
    expect(newChild.settings.availableInMCP).toBe(true);
  });

  it('writes one file per workflow with --separate and reads a folder back', async () => {
    const a = await workspace();
    const b = await workspace();
    for (const name of ['One', 'Two']) {
      await workflowIn(server, a.tenantId, a.personalId, { name, nodes: [node('S', 'core.manualTrigger')] });
    }
    const out = path.join(dir, `sep-${randomUUID().slice(0, 8)}`);
    const base = fakeIo();
    // files go to the disk here, so the folder can be read back
    const diskIo: CommandIo = {
      ...base.io,
      writeFile: (file, data) => writeFile(file, data, 'utf8'),
      readFile: (file) => readFile(file, 'utf8'),
    };
    expect(
      await exportWorkflowCommand(
        server.ctx,
        ['--tenant', a.slug, '--all', '--separate', '--output', out],
        diskIo,
      ),
    ).toBe(0);
    const names = (await readdir(out)).sort();
    expect(names).toHaveLength(2);
    expect(names.every((n) => n.endsWith('.json'))).toBe(true);
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', b.slug, '--separate', '--input', out], diskIo),
    ).toBe(0);
    expect((await rowsOf(b.tenantId)).map((w) => w.name)).toEqual(['One', 'Two']);
    // --separate with no folder is a bad call
    const f = fakeIo();
    expect(await exportWorkflowCommand(server.ctx, ['--tenant', a.slug, '--all', '--separate'], f.io)).toBe(
      2,
    );
  });

  it('prints to stdout, pretty on request, and refuses a missing or unknown workflow', async () => {
    const a = await workspace();
    const wf = await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Out',
      nodes: [node('S', 'core.manualTrigger')],
    });
    const plain = fakeIo();
    expect(await exportWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id], plain.io)).toBe(0);
    expect(plain.stdout().trim().split('\n')).toHaveLength(1);
    const pretty = fakeIo();
    expect(
      await exportWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id, '--pretty'], pretty.io),
    ).toBe(0);
    expect(pretty.stdout().split('\n').length).toBeGreaterThan(5);
    const missing = fakeIo();
    expect(
      await exportWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', randomUUID()], missing.io),
    ).toBe(1);
    expect(missing.stderr()).toContain('not found');
    const neither = fakeIo();
    expect(await exportWorkflowCommand(server.ctx, ['--tenant', a.slug], neither.io)).toBe(2);
  });

  it("does not export another workspace's workflow", async () => {
    const a = await workspace();
    const b = await workspace();
    const wf = await workflowIn(server, b.tenantId, b.personalId, { name: 'Theirs' });
    const f = fakeIo();
    expect(await exportWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id], f.io)).toBe(1);
    expect(f.stdout()).toBe('');
  });

  it('exports a version with --version and the published ones with --published', async () => {
    const a = await workspace();
    const wf = await savedWorkflow(a, 'Versioned');
    const none = fakeIo();
    expect(
      await exportWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', wf.id, '--published'], none.io),
    ).toBe(1);
    const version = fakeIo();
    expect(
      await exportWorkflowCommand(
        server.ctx,
        ['--tenant', a.slug, '--id', wf.id, '--version', wf.versionId],
        version.io,
      ),
    ).toBe(0);
    expect(JSON.parse(version.stdout())[0].name).toBe('Versioned');
    const bad = fakeIo();
    expect(
      await exportWorkflowCommand(
        server.ctx,
        ['--tenant', a.slug, '--id', wf.id, '--version', randomUUID()],
        bad.io,
      ),
    ).toBe(1);
    const both = fakeIo();
    expect(
      await exportWorkflowCommand(
        server.ctx,
        ['--tenant', a.slug, '--id', wf.id, '--version', wf.versionId, '--published'],
        both.io,
      ),
    ).toBe(2);
    const live = await savedWorkflow(a, 'Live', [webhookNode()]);
    expect(await publishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', live.id], fakeIo().io)).toBe(
      0,
    );
    const exported = fakeIo();
    expect(
      await exportWorkflowCommand(server.ctx, ['--tenant', a.slug, '--all', '--published'], exported.io),
    ).toBe(0);
    expect(JSON.parse(exported.stdout()).map((w: { name: string }) => w.name)).toEqual(['Live']);
  });

  it('refuses a file whose node type is blocked, with its violations and a non-zero exit', async () => {
    const a = await workspace();
    const b = await workspace();
    await workflowIn(server, a.tenantId, a.personalId, { name: 'Bad', nodes: [node('Pass', 'core.noOp')] });
    await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Good',
      nodes: [node('S', 'core.manualTrigger')],
    });
    await policyDeny(server, b.tenantId, 'node', 'core.noOp');
    const exported = fakeIo();
    await exportWorkflowCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--output', '/e.json'],
      exported.io,
    );
    const imported = fakeIo({ '/e.json': exported.files.get('/e.json') ?? '' });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', b.slug, '--input', '/e.json'], imported.io),
    ).not.toBe(0);
    expect(imported.stderr()).toContain('Bad');
    expect(imported.stderr()).toContain('core.noOp');
    expect(imported.stderr()).toContain('blocked');
    // only the file with the blocked type is refused
    expect((await rowsOf(b.tenantId)).map((w) => w.name)).toEqual(['Good']);
  });

  it('refuses a --projectId of another workspace and imports nothing; uses a project of its own', async () => {
    const a = await workspace();
    const b = await workspace(true);
    await workflowIn(server, a.tenantId, a.personalId, {
      name: 'Move',
      nodes: [node('S', 'core.manualTrigger')],
    });
    const exported = fakeIo();
    await exportWorkflowCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--output', '/m.json'],
      exported.io,
    );
    const seed = { '/m.json': exported.files.get('/m.json') ?? '' };
    const refused = fakeIo(seed);
    expect(
      await importWorkflowCommand(
        server.ctx,
        ['--tenant', b.slug, '--input', '/m.json', '--projectId', a.personalId],
        refused.io,
      ),
    ).toBe(1);
    expect(await rowsOf(b.tenantId)).toHaveLength(0);
    const ok = fakeIo(seed);
    expect(
      await importWorkflowCommand(
        server.ctx,
        ['--tenant', b.slug, '--input', '/m.json', '--projectId', b.teamId as string],
        ok.io,
      ),
    ).toBe(0);
    expect((await rowsOf(b.tenantId))[0].project_id).toBe(b.teamId);
  });

  it('refuses a file that is not a workflow and one that is not JSON', async () => {
    const a = await workspace();
    const notJson = fakeIo({ '/n.json': 'not json' });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', a.slug, '--input', '/n.json'], notJson.io),
    ).toBe(1);
    const noName = fakeIo({ '/w.json': JSON.stringify([{ nodes: [], connections: {} }]) });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', a.slug, '--input', '/w.json'], noName.io),
    ).toBe(1);
    expect(await rowsOf(a.tenantId)).toHaveLength(0);
  });
});

describe('P6-78 list:workflow, publish:workflow, unpublish:workflow', () => {
  it('lists id|name lines, only ids, and filters by --active', async () => {
    const a = await workspace();
    const plain = await savedWorkflow(a, 'Plain');
    const live = await savedWorkflow(a, 'Live', [webhookNode()]);
    expect(await publishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', live.id], fakeIo().io)).toBe(
      0,
    );

    const all = fakeIo();
    expect(await listWorkflowCommand(server.ctx, ['--tenant', a.slug], all.io)).toBe(0);
    expect(all.stdout().trim().split('\n').sort()).toEqual([`${live.id}|Live`, `${plain.id}|Plain`].sort());
    const ids = fakeIo();
    await listWorkflowCommand(server.ctx, ['--tenant', a.slug, '--onlyId'], ids.io);
    expect(ids.stdout().trim().split('\n').sort()).toEqual([live.id, plain.id].sort());
    const active = fakeIo();
    await listWorkflowCommand(server.ctx, ['--tenant', a.slug, '--active=true'], active.io);
    expect(active.stdout().trim()).toBe(`${live.id}|Live`);
    const inactive = fakeIo();
    await listWorkflowCommand(server.ctx, ['--tenant', a.slug, '--active=false'], inactive.io);
    expect(inactive.stdout().trim()).toBe(`${plain.id}|Plain`);
  });

  it('publishes and unpublishes one workflow or all, and refuses an unknown id', async () => {
    const a = await workspace();
    const b = await workspace();
    const makeVia = (w: Awaited<ReturnType<typeof workspace>>, name: string) =>
      savedWorkflow(w, name, [webhookNode()]);
    const one = await makeVia(a, 'One');
    const two = await makeVia(a, 'Two');
    const other = await makeVia(b, 'Other');

    expect(await publishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', one.id], fakeIo().io)).toBe(
      0,
    );
    expect((await rowsOf(a.tenantId)).map((w) => w.active)).toEqual([true, false]);
    expect(await publishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--all'], fakeIo().io)).toBe(0);
    expect((await rowsOf(a.tenantId)).every((w) => w.active)).toBe(true);
    const audit = await server.ctx.database.pool.query(
      "select action from audit_log where tenant_id = $1 and action = 'workflow.activated'",
      [a.tenantId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);

    expect(
      await unpublishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', two.id], fakeIo().io),
    ).toBe(0);
    expect((await rowsOf(a.tenantId)).map((w) => w.active)).toEqual([true, false]);
    expect(await unpublishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--all'], fakeIo().io)).toBe(0);
    expect((await rowsOf(a.tenantId)).some((w) => w.active)).toBe(false);

    // another workspace's workflow, an unknown id, and neither --id nor --all, or both
    expect(
      await publishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', other.id], fakeIo().io),
    ).toBe(1);
    expect((await rowsOf(b.tenantId))[0].active).toBe(false);
    expect(
      await publishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', randomUUID()], fakeIo().io),
    ).toBe(1);
    expect(await publishWorkflowCommand(server.ctx, ['--tenant', a.slug], fakeIo().io)).toBe(2);
    expect(
      await unpublishWorkflowCommand(server.ctx, ['--tenant', a.slug, '--id', one.id, '--all'], fakeIo().io),
    ).toBe(2);
  });
});

describe('P6-78 export:nodes and audit', () => {
  it('writes the node types to --output, or prints them, with no tenant', async () => {
    const f = fakeIo();
    expect(await exportNodesCommand(server.ctx, ['--output', '/nodes.json'], f.io)).toBe(0);
    const types = JSON.parse(f.files.get('/nodes.json') ?? '[]') as Array<{ name: string }>;
    expect(types.some((t) => t.name === 'core.set')).toBe(true);
    const printed = fakeIo();
    expect(await exportNodesCommand(server.ctx, [], printed.io)).toBe(0);
    expect(JSON.parse(printed.stdout()).length).toBe(types.length);
    expect(await exportNodesCommand(server.ctx, ['--bogus'], fakeIo().io)).toBe(2);
  });

  it('runs the security audit for the workspace with --categories and --days-abandoned-workflow', async () => {
    const a = await workspace();
    const f = fakeIo();
    expect(
      await auditCommand(
        server.ctx,
        ['--tenant', a.slug, '--categories', 'nodes,instance', '--days-abandoned-workflow', '7'],
        f.io,
      ),
    ).toBe(0);
    const report = JSON.parse(f.stdout());
    expect(typeof report).toBe('object');
    expect(Object.keys(report).every((k) => /Risk Report$/.test(k))).toBe(true);
    const bad = fakeIo();
    expect(await auditCommand(server.ctx, ['--tenant', a.slug, '--categories', 'bogus'], bad.io)).toBe(1);
    expect(bad.stderr()).toContain('Unknown audit category');
    expect(
      await auditCommand(server.ctx, ['--tenant', a.slug, '--days-abandoned-workflow', 'x'], fakeIo().io),
    ).toBe(2);
  });
});
