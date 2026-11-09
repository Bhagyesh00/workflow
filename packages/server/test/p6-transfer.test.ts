/**
 * P6-30 transfers (L9): PUT and GET preview for a workflow, a credential and a folder. A move needs
 * `:move` on the source and `:create` on the destination, drops every share, sets the project, shares
 * the chosen credentials, unpublishes and republishes when allowed (a refused republish leaves it
 * unpublished); a credential only moves to a project that reaches every vault its data names.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import {
  SAME_CREDENTIAL_DESTINATION,
  SAME_FOLDER_DESTINATION,
  SAME_WORKFLOW_DESTINATION,
} from '../src/services/transfer';
import {
  addToProject,
  chain,
  createTestServer,
  credentialIn,
  folderIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
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

const repos = () => server.ctx.repos;
const suffix = () => randomUUID().slice(0, 8);

async function setup() {
  const owner = await signup(server.app);
  const tenantId = owner.tenant.id;
  const home = await projectIn(server, tenantId, `Home ${suffix()}`);
  const away = await projectIn(server, tenantId, `Away ${suffix()}`);
  const third = await projectIn(server, tenantId, `Third ${suffix()}`);
  return { owner, tenantId, home, away, third };
}

const hook = () =>
  node('Hook', 'core.webhook', { path: `p6-transfer-${suffix()}`, httpMethod: 'GET' }, [0, 0], {
    webhookId: randomUUID(),
  });

/** a workflow with a webhook trigger (publishable); `credential` adds a node that uses it */
async function publishable(
  tenantId: string,
  projectId: string,
  credential?: { id: string; name: string },
  folderId?: string,
) {
  const nodes = [hook()];
  if (credential) {
    nodes.push(
      node('Use', 'test.useCredential', {}, [200, 0], {
        credentials: { testApi: { id: credential.id, name: credential.name } },
      }),
    );
  }
  const wf = await server.ctx.workflows.create(
    tenantId,
    {
      name: `Flow ${suffix()}`,
      nodes,
      connections: credential ? chain('Hook', 'Use') : {},
      settings: {},
      projectId,
      folderId: folderId ?? null,
    } as never,
    {},
  );
  await server.ctx.activeWorkflows.activate(tenantId, wf.id);
  return (await repos().workflows.get(tenantId, wf.id))!;
}

const transferWorkflow = (owner: Awaited<ReturnType<typeof setup>>['owner'], id: string, body: object) =>
  owner.client.put(`/rest/workflows/${id}/transfer`, body);

/** a true member: project:admin on `from` (move, share) and project:editor on each project of `into` (create, publish) */
async function mover(
  owner: Awaited<ReturnType<typeof setup>>['owner'],
  tenantId: string,
  from: { id: string },
  into: Array<{ id: string }>,
) {
  const member = await realMember(owner);
  await addToProject(server, tenantId, from.id, member.user.id, 'project:admin');
  for (const project of into)
    await addToProject(server, tenantId, project.id, member.user.id, 'project:editor');
  return member;
}

const previewOf = (
  client: Awaited<ReturnType<typeof setup>>['owner']['client'],
  kind: 'workflows' | 'credentials' | 'folders',
  id: string,
  destination: string,
) => client.get(`/rest/${kind}/${id}/transfer-preview?destinationProjectId=${destination}`);

/** the workspace policy "publishing in personal spaces" */
async function setPersonalPublishing(tenantId: string, on: boolean) {
  const tenant = await repos().tenants.get(tenantId);
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const policy = (settings.securityPolicy ?? {}) as Record<string, unknown>;
  await repos().tenants.updateSettings(tenantId, {
    ...settings,
    securityPolicy: { ...policy, personalSpacePublishing: on },
  });
}

describe('workflow transfer', () => {
  it('moves the workflow, drops every share and sets the folder in the destination', async () => {
    const { owner, tenantId, home, away, third } = await setup();
    const wf = await workflowIn(server, tenantId, home.id);
    await repos().shares.set(tenantId, 'workflow', wf.id, [third.id]);
    const folder = await folderIn(server, tenantId, away.id);

    const res = await transferWorkflow(owner, wf.id, {
      destinationProjectId: away.id,
      destinationParentFolderId: folder.id,
    });
    expect(res.statusCode).toBe(200);
    const row = await repos().workflows.get(tenantId, wf.id);
    expect(row?.projectId).toBe(away.id);
    expect(row?.folderId).toBe(folder.id);
    expect(await repos().shares.listForWorkflow(tenantId, wf.id)).toEqual([]);
  });

  it('refuses the same destination with n8n text, and a folder of another project with 404', async () => {
    const { owner, tenantId, home, away, third } = await setup();
    const wf = await workflowIn(server, tenantId, home.id);
    const same = await transferWorkflow(owner, wf.id, { destinationProjectId: home.id });
    expect(same.statusCode).toBe(400);
    expect(same.body).toContain(SAME_WORKFLOW_DESTINATION);
    const other = await folderIn(server, tenantId, third.id);
    const wrong = await transferWorkflow(owner, wf.id, {
      destinationProjectId: away.id,
      destinationParentFolderId: other.id,
    });
    expect(wrong.statusCode).toBe(404);
    expect((await repos().workflows.get(tenantId, wf.id))?.projectId).toBe(home.id);
  });

  it('needs workflow:create in the destination as well as workflow:move on the source', async () => {
    const { owner, tenantId, home, away } = await setup();
    const wf = await workflowIn(server, tenantId, home.id);
    const member = await realMember(owner);
    await addToProject(server, tenantId, home.id, member.user.id, 'project:admin');

    const refused = await transferWorkflow(member, wf.id, { destinationProjectId: away.id });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(MISSING_SCOPE_MESSAGE);
    expect((await repos().workflows.get(tenantId, wf.id))?.projectId).toBe(home.id);

    await addToProject(server, tenantId, away.id, member.user.id, 'project:editor');
    expect((await transferWorkflow(member, wf.id, { destinationProjectId: away.id })).statusCode).toBe(200);
    // a project editor on the source has no :move
    const back = await realMember(owner);
    await addToProject(server, tenantId, away.id, back.user.id, 'project:editor');
    await addToProject(server, tenantId, home.id, back.user.id, 'project:editor');
    expect((await transferWorkflow(back, wf.id, { destinationProjectId: home.id })).statusCode).toBe(403);
  });

  it('republishes when allowed, as previewed (a member: admin on the source, editor on the destination)', async () => {
    const { owner, tenantId, home, away } = await setup();
    const member = await mover(owner, tenantId, home, [away]);
    const wf = await publishable(tenantId, home.id);
    expect(wf.active).toBe(true);

    const preview = await member.client.data(previewOf(member.client, 'workflows', wf.id, away.id));
    expect(preview).toMatchObject({ restricted: [], checkFailed: false, unpublishReasons: [] });
    expect((await transferWorkflow(member, wf.id, { destinationProjectId: away.id })).statusCode).toBe(200);
    const row = await repos().workflows.get(tenantId, wf.id);
    expect(row?.projectId).toBe(away.id);
    expect(row?.active).toBe(true);
    expect(row?.publishedVersionId).toBe(wf.publishedVersionId);
    // the timeline shows the unpublish and the publish of the move
    const timeline = await repos().publishHistory.list(tenantId, wf.id, { skip: 0, take: 20 });
    expect(timeline.map((e) => e.event)).toEqual(expect.arrayContaining(['deactivated', 'activated']));
  });

  it('republishes the version that was published, not the draft (P6-30)', async () => {
    const { owner, tenantId, home, away } = await setup();
    const member = await mover(owner, tenantId, home, [away]);
    const credential = await credentialIn(server, tenantId, home.id);
    const wf = await publishable(tenantId, home.id);
    // a draft that uses a credential the destination cannot use; the published version does not
    const draft = await server.ctx.workflows.update(
      tenantId,
      wf.id,
      {
        versionId: wf.versionId,
        nodes: [
          ...(wf.nodes as never[]),
          node('Use', 'test.useCredential', {}, [200, 0], {
            credentials: { testApi: { id: credential.id, name: credential.name } },
          }),
        ],
        connections: chain('Hook', 'Use'),
      } as never,
      { userId: member.user.id },
    );
    expect(draft.versionId).not.toBe(wf.publishedVersionId);

    const preview = await member.client.data<{ unpublishReasons: unknown[] }>(
      previewOf(member.client, 'workflows', wf.id, away.id),
    );
    expect(preview.unpublishReasons).toEqual([]);
    expect((await transferWorkflow(member, wf.id, { destinationProjectId: away.id })).statusCode).toBe(200);
    const row = await repos().workflows.get(tenantId, wf.id);
    expect(row?.active).toBe(true);
    expect(row?.publishedVersionId).toBe(wf.publishedVersionId);
    expect(row?.versionId).toBe(draft.versionId);
  });

  it('does not publish a draft after a move when the published version is blocked (P6-30)', async () => {
    const { owner, tenantId, home, away } = await setup();
    const member = await mover(owner, tenantId, home, [away]);
    const credential = await credentialIn(server, tenantId, home.id);
    const wf = await publishable(tenantId, home.id, credential);
    // the draft drops the credential, so the draft alone could be published in the destination
    await server.ctx.workflows.update(
      tenantId,
      wf.id,
      { versionId: wf.versionId, nodes: [hook()], connections: {} } as never,
      { userId: member.user.id },
    );
    const preview = await member.client.data<{ unpublishReasons: Array<{ kind: string }> }>(
      previewOf(member.client, 'workflows', wf.id, away.id),
    );
    expect(preview.unpublishReasons.map((r) => r.kind)).toEqual(['credentialAccess']);
    expect((await transferWorkflow(member, wf.id, { destinationProjectId: away.id })).statusCode).toBe(200);
    expect((await repos().workflows.get(tenantId, wf.id))?.active).toBe(false);
  });

  it('a move into a personal space with publishing off stays unpublished, as previewed', async () => {
    const { owner, tenantId, home } = await setup();
    const member = await realMember(owner);
    await addToProject(server, tenantId, home.id, member.user.id, 'project:admin');
    const space = await repos().projects.ensurePersonal(tenantId, member.user);
    await setPersonalPublishing(tenantId, false);
    const wf = await publishable(tenantId, home.id);

    const preview = await member.client.data<{ unpublishReasons: Array<{ kind: string; scope?: string }> }>(
      previewOf(member.client, 'workflows', wf.id, space.id),
    );
    expect(preview.unpublishReasons).toMatchObject([{ kind: 'publishing', scope: 'workflow:publish' }]);
    expect((await transferWorkflow(member, wf.id, { destinationProjectId: space.id })).statusCode).toBe(200);
    const row = await repos().workflows.get(tenantId, wf.id);
    expect(row?.projectId).toBe(space.id);
    expect(row?.active).toBe(false);
  });

  it('a project viewer on the destination gets 403 on the preview and the move, and the workflow stays', async () => {
    const { owner, tenantId, home, away } = await setup();
    const member = await realMember(owner);
    await addToProject(server, tenantId, home.id, member.user.id, 'project:admin');
    await addToProject(server, tenantId, away.id, member.user.id, 'project:viewer');
    const wf = await publishable(tenantId, home.id);
    const preview = await previewOf(member.client, 'workflows', wf.id, away.id);
    expect(preview.statusCode).toBe(403);
    expect(preview.body).toContain(MISSING_SCOPE_MESSAGE);
    expect((await transferWorkflow(member, wf.id, { destinationProjectId: away.id })).statusCode).toBe(403);
    const row = await repos().workflows.get(tenantId, wf.id);
    expect(row?.projectId).toBe(home.id);
    expect(row?.active).toBe(true);
  });

  it('the previews of a workflow, a credential and a folder need :create on the destination (P6-30)', async () => {
    const { owner, tenantId, home, away } = await setup();
    const member = await realMember(owner);
    // admin on the source, no relation on the destination
    await addToProject(server, tenantId, home.id, member.user.id, 'project:admin');
    const wf = await publishable(tenantId, home.id);
    const credential = await credentialIn(server, tenantId, home.id);
    const folder = await folderIn(server, tenantId, home.id);
    for (const [kind, id] of [
      ['workflows', wf.id],
      ['credentials', credential.id],
      ['folders', folder.id],
    ] as const) {
      const res = await previewOf(member.client, kind, id, away.id);
      expect(res.statusCode, kind).toBe(403);
      expect(res.body, kind).toContain(MISSING_SCOPE_MESSAGE);
    }
  });

  it('a credential the destination cannot use leaves it unpublished, as previewed; sharing it keeps it published', async () => {
    const { owner, tenantId, home, away, third } = await setup();
    const member = await mover(owner, tenantId, home, [away, third]);
    const credential = await credentialIn(server, tenantId, home.id);
    const wf = await publishable(tenantId, home.id, credential);

    const preview = await member.client.data<{ unpublishReasons: Array<{ kind: string }> }>(
      previewOf(member.client, 'workflows', wf.id, away.id),
    );
    expect(preview.unpublishReasons.map((r) => r.kind)).toEqual(['credentialAccess']);
    expect((await transferWorkflow(member, wf.id, { destinationProjectId: away.id })).statusCode).toBe(200);
    const stopped = await repos().workflows.get(tenantId, wf.id);
    expect(stopped?.projectId).toBe(away.id);
    expect(stopped?.active).toBe(false);
    expect(await repos().webhooks.listForWorkflow(tenantId, wf.id)).toEqual([]);

    // the same move with the credential shared in
    const again = await publishable(tenantId, home.id, credential);
    const ok = await transferWorkflow(member, again.id, {
      destinationProjectId: third.id,
      shareCredentials: [credential.id],
    });
    expect(ok.statusCode).toBe(200);
    expect((await repos().workflows.get(tenantId, again.id))?.active).toBe(true);
    const shares = await repos().shares.listForCredential(tenantId, credential.id);
    expect(shares.map((s) => [s.projectId, s.role])).toEqual([[third.id, 'credential:user']]);
  });

  it('shareCredentials names a credential the member cannot share: 403, and nothing moves', async () => {
    const { owner, tenantId, home, away, third } = await setup();
    const member = await mover(owner, tenantId, home, [away]);
    // a project editor of `third` holds no credential:share there
    await addToProject(server, tenantId, third.id, member.user.id, 'project:editor');
    const foreign = await credentialIn(server, tenantId, third.id);
    const wf = await publishable(tenantId, home.id);
    const res = await transferWorkflow(member, wf.id, {
      destinationProjectId: away.id,
      shareCredentials: [foreign.id],
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(MISSING_SCOPE_MESSAGE);
    const row = await repos().workflows.get(tenantId, wf.id);
    expect(row?.projectId).toBe(home.id);
    expect(row?.active).toBe(true);
    expect(await repos().shares.listForCredential(tenantId, foreign.id)).toEqual([]);
  });
});

describe('credential transfer', () => {
  it('moves the credential and drops its shares', async () => {
    const { owner, tenantId, home, away, third } = await setup();
    const member = await mover(owner, tenantId, home, [away]);
    const credential = await credentialIn(server, tenantId, home.id);
    await repos().shares.set(tenantId, 'credential', credential.id, [third.id]);

    const res = await member.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: away.id,
    });
    expect(res.statusCode).toBe(200);
    expect((await repos().credentials.get(tenantId, credential.id))?.projectId).toBe(away.id);
    expect(await repos().shares.listForCredential(tenantId, credential.id)).toEqual([]);
    // the new owner project moves it back (admin there)
    await addToProject(server, tenantId, away.id, member.user.id, 'project:admin');
    await addToProject(server, tenantId, home.id, member.user.id, 'project:editor');
    const preview = await member.client.data(previewOf(member.client, 'credentials', credential.id, home.id));
    expect(preview).toMatchObject({ restricted: [], checkFailed: false });
  });

  it('the preview shows the vault refusal the move then gives (P6-30)', async () => {
    const { owner, tenantId, home, away } = await setup();
    const credential = await credentialIn(server, tenantId, home.id, {
      data: { apiKey: '={{ $secrets.vaultX.token }}' },
    });
    const preview = await owner.client.data<{ restricted: Array<Record<string, unknown>> }>(
      previewOf(owner.client, 'credentials', credential.id, away.id),
    );
    expect(preview.restricted).toMatchObject([
      {
        kind: 'secretAccess',
        message: 'The secret provider "vaultX" does not exist in this project',
        subject: credential.id,
        projectId: away.id,
      },
    ]);
  });

  it('refuses the owning project with n8n text, and needs credential:create in the destination', async () => {
    const { owner, tenantId, home, away } = await setup();
    const credential = await credentialIn(server, tenantId, home.id);
    const same = await owner.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: home.id,
    });
    expect(same.statusCode).toBe(400);
    expect(same.body).toContain(SAME_CREDENTIAL_DESTINATION);

    const member = await realMember(owner);
    await addToProject(server, tenantId, home.id, member.user.id, 'project:admin');
    const refused = await member.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: away.id,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(MISSING_SCOPE_MESSAGE);
  });

  it('is refused for a vault the destination lacks, and the credential stays', async () => {
    const { owner, tenantId, home, away } = await setup();
    const credential = await credentialIn(server, tenantId, home.id, {
      data: { apiKey: '={{ $secrets.vaultX.token }}' },
    });
    expect(credential.secretKeys).toEqual(['vaultX']);
    const res = await owner.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: away.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('The secret provider "vaultX" does not exist in this project');
    const row = await repos().credentials.get(tenantId, credential.id);
    expect(row?.projectId).toBe(home.id);
  });
});

describe('folder transfer', () => {
  it('moves the whole tree with its workflows, drops shares and republishes what is allowed', async () => {
    const { owner, tenantId, home, away, third } = await setup();
    const member = await mover(owner, tenantId, home, [away]);
    const top = await folderIn(server, tenantId, home.id, 'Top');
    const child = await folderIn(server, tenantId, home.id, 'Child', top.id);
    const plain = await workflowIn(server, tenantId, home.id, { folderId: child.id });
    const live = await publishable(tenantId, home.id, undefined, top.id);
    const credential = await credentialIn(server, tenantId, home.id);
    const blocked = await publishable(tenantId, home.id, credential, child.id);
    const outside = await workflowIn(server, tenantId, home.id);
    await repos().shares.set(tenantId, 'workflow', plain.id, [third.id]);
    const parent = await folderIn(server, tenantId, away.id, 'Parent');

    const preview = await member.client.data<{ workflowsToUnpublish: Array<{ id: string }> }>(
      previewOf(member.client, 'folders', top.id, away.id),
    );
    expect(preview.workflowsToUnpublish.map((w) => w.id)).toEqual([blocked.id]);

    const res = await member.client.put(`/rest/folders/${top.id}/transfer`, {
      destinationProjectId: away.id,
      destinationParentFolderId: parent.id,
    });
    expect(res.statusCode).toBe(200);
    expect((await repos().folders.get(tenantId, top.id))?.projectId).toBe(away.id);
    expect((await repos().folders.get(tenantId, top.id))?.parentFolderId).toBe(parent.id);
    expect((await repos().folders.get(tenantId, child.id))?.projectId).toBe(away.id);
    for (const id of [plain.id, live.id, blocked.id]) {
      expect((await repos().workflows.get(tenantId, id))?.projectId).toBe(away.id);
    }
    expect((await repos().workflows.get(tenantId, outside.id))?.projectId).toBe(home.id);
    expect(await repos().shares.listForWorkflow(tenantId, plain.id)).toEqual([]);
    expect((await repos().workflows.get(tenantId, live.id))?.active).toBe(true);
    expect((await repos().workflows.get(tenantId, blocked.id))?.active).toBe(false);
  });

  it('refuses the owning project, and a destination without folder:create', async () => {
    const { owner, tenantId, home, away } = await setup();
    const folder = await folderIn(server, tenantId, home.id);
    const same = await owner.client.put(`/rest/folders/${folder.id}/transfer`, {
      destinationProjectId: home.id,
    });
    expect(same.statusCode).toBe(400);
    expect(same.body).toContain(SAME_FOLDER_DESTINATION);

    const member = await realMember(owner);
    await addToProject(server, tenantId, home.id, member.user.id, 'project:admin');
    const refused = await member.client.put(`/rest/folders/${folder.id}/transfer`, {
      destinationProjectId: away.id,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(MISSING_SCOPE_MESSAGE);
    expect((await repos().folders.get(tenantId, folder.id))?.projectId).toBe(home.id);
  });
});
