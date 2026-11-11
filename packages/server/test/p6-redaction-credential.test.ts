/**
 * P6-53 (L8), the credential rule: a viewer who cannot use a credential a run touched sees the run redacted
 * and cannot reveal it, whatever the policy and whatever scopes or owner rights they hold. The credentials are
 * the workflow snapshot's node credentials and the ones sub-workflows report (the child row may be gone); a run
 * that used a private credential is revealed only to its own user.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  credentialIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

const CANARY = 'canary-credential-value';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

let address = 0;
const fresh = () => {
  address += 1;
  return signup(server.app, { remoteAddress: `10.55.${Math.floor(address / 250)}.${(address % 250) + 1}` });
};

/**
 * Two team projects: T (the run's workflow) and P (the credential). `limited` is project admin of T only (it
 * holds execution:reveal there); `both` is project admin of T and editor of P (it may use the credential).
 */
async function scene() {
  const owner = await fresh();
  const team = await teamProjectOf(server, owner.tenant.id);
  const other = await projectIn(server, owner.tenant.id, 'Credentials home');
  const limited = await realMember(owner);
  await addToProject(server, owner.tenant.id, team, limited.user.id, 'project:admin');
  const both = await realMember(owner);
  await addToProject(server, owner.tenant.id, team, both.user.id, 'project:admin');
  await addToProject(server, owner.tenant.id, other.id, both.user.id, 'project:editor');
  const credential = await credentialIn(server, owner.tenant.id, other.id, { data: { apiKey: 'k' } });
  return { owner, team, other, limited, both, credential };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** a finished run stored as the engine leaves it: snapshot nodes, state with one cleared-able item */
async function storedRun(
  s: Scene,
  input: {
    nodes?: unknown[];
    policy?: { production: boolean; manual: boolean };
    metadata?: Record<string, unknown>;
    privateRun?: { userId: string };
  },
) {
  const nodes = input.nodes ?? [];
  const workflow = await workflowIn(server, s.owner.tenant.id, s.team, { nodes: nodes as never });
  const id = randomUUID();
  await server.ctx.repos.executions.create(
    s.owner.tenant.id,
    {
      id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      mode: 'manual',
      status: 'error',
      errorMessage: CANARY,
      usedPrivateCredentials: input.privateRun !== undefined,
    },
    {
      workflowData: { nodes },
      runOptions: {
        ...(input.policy ? { redaction: input.policy } : {}),
        ...(input.privateRun ? { userId: input.privateRun.userId } : {}),
      },
    },
  );
  await server.ctx.repos.executions.saveState(s.owner.tenant.id, id, {
    startData: {},
    resultData: {
      runData: {
        Use: [
          {
            startTime: 1,
            executionTime: 1,
            executionStatus: 'success',
            source: [],
            data: { main: [[{ json: { secret: CANARY } }]] },
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        ],
      },
    },
    executionData: {
      nodeExecutionStack: [],
      waitingExecution: {},
      waitingExecutionSource: {},
      contextData: {},
    },
  });
  return id;
}

const useNode = (credentialId: string) =>
  node('Use', 'test.useCredential', {}, [200, 0], {
    credentials: { testApi: { id: credentialId, name: 'x' } },
  });

const read = (who: { client: Scene['owner']['client'] }, id: string, query = '') =>
  who.client.get(`/rest/executions/${id}${query}`);

const items = (body: any) => body.data.state.resultData.runData.Use[0].data.main[0];

describe('a credential the viewer cannot use', () => {
  it('redacts the run with no policy and refuses reveal, with the scope and as owner', async () => {
    const s = await scene();
    const id = await storedRun(s, { nodes: [useNode(s.credential.id)] });
    for (const viewer of [s.limited, s.owner]) {
      const res = await read(viewer, id);
      expect(res.statusCode).toBe(200);
      const body = res.json().data;
      expect(body.redactionInfo).toEqual({ isRedacted: true, reason: 'credential_access', canReveal: false });
      expect(body.errorMessage).toBe('');
      expect(items(res.json())).toEqual([]);
      const reveal = await read(viewer, id, '?redactExecutionData=false');
      expect(reveal.statusCode).toBe(403);
      expect(reveal.json().error.code).toBe('EXECUTION_REVEAL_FORBIDDEN');
      expect(reveal.body).not.toContain(CANARY);
    }
  });

  it('shows the run to a viewer who can use the credential', async () => {
    const s = await scene();
    const id = await storedRun(s, { nodes: [useNode(s.credential.id)] });
    const res = await read(s.both, id);
    expect(res.json().data.redactionInfo).toBeUndefined();
    expect(items(res.json())[0].json.secret).toBe(CANARY);
    expect(res.json().data.errorMessage).toBe(CANARY);
  });

  it('a policy and the credential rule together: the viewer who can use it may reveal, the other may not', async () => {
    const s = await scene();
    const id = await storedRun(s, {
      nodes: [useNode(s.credential.id)],
      policy: { production: true, manual: true },
    });
    expect((await read(s.both, id)).json().data.redactionInfo).toMatchObject({
      reason: 'workflow_redaction_policy',
      canReveal: true,
    });
    expect(items((await read(s.both, id, '?redactExecutionData=false')).json())[0].json.secret).toBe(CANARY);
    expect((await read(s.limited, id)).json().data.redactionInfo).toMatchObject({ canReveal: false });
    expect((await read(s.limited, id, '?redactExecutionData=false')).statusCode).toBe(403);
  });

  it("counts a sub-workflow's credential from task metadata, with the child row pruned", async () => {
    const s = await scene();
    const id = await storedRun(s, {
      nodes: [node('Use', 'core.noOp', {}, [200, 0])],
      metadata: { usedCredentialIds: [s.credential.id], subExecution: { executionId: randomUUID() } },
    });
    expect((await read(s.limited, id)).json().data.redactionInfo).toMatchObject({
      isRedacted: true,
      reason: 'credential_access',
      canReveal: false,
    });
    expect((await read(s.both, id)).json().data.redactionInfo).toBeUndefined();
  });

  it('blanks the error text in the list for the viewer who cannot use it only', async () => {
    const s = await scene();
    const id = await storedRun(s, { nodes: [useNode(s.credential.id)] });
    const rowOf = async (who: { client: Scene['owner']['client'] }) => {
      const res = await who.client.get('/rest/executions?limit=50');
      const data = res.json().data as any;
      return (Array.isArray(data) ? data : (data.results ?? data.data)).find((r: any) => r.id === id);
    };
    expect((await rowOf(s.limited)).errorMessage).toBe('');
    expect((await rowOf(s.both)).errorMessage).toBe(CANARY);
  });

  it('ignores a credential that no longer exists', async () => {
    const s = await scene();
    const id = await storedRun(s, { nodes: [useNode(randomUUID())] });
    expect((await read(s.limited, id)).json().data.redactionInfo).toBeUndefined();
  });

  it('a credential shared into the run project is usable by its members', async () => {
    const s = await scene();
    const own = await credentialIn(server, s.owner.tenant.id, s.team, { data: { apiKey: 'k' } });
    const id = await storedRun(s, { nodes: [useNode(own.id)] });
    expect((await read(s.limited, id)).json().data.redactionInfo).toBeUndefined();
  });
});

describe('a private credential', () => {
  it("is revealed to the run's own user only, in the detail and the list", async () => {
    const s = await scene();
    const id = await storedRun(s, { nodes: [], privateRun: { userId: s.both.user.id } });
    const mine = await read(s.both, id);
    expect(mine.json().data.redactionInfo).toBeUndefined();
    expect(items(mine.json())[0].json.secret).toBe(CANARY);
    for (const viewer of [s.limited, s.owner]) {
      const res = await read(viewer, id);
      expect(res.json().data.redactionInfo).toEqual({
        isRedacted: true,
        reason: 'credential_access',
        canReveal: false,
      });
      expect((await read(viewer, id, '?redactExecutionData=false')).statusCode).toBe(403);
      const list = (await viewer.client.get('/rest/executions?limit=50')).json().data as any;
      const row = (Array.isArray(list) ? list : (list.results ?? list.data)).find((r: any) => r.id === id);
      expect(row.errorMessage).toBe('');
    }
  });
});
