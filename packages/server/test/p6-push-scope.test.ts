/**
 * P6-25 (L5): GET /rest/push filters every event by the workflow on its envelope. A member receives the live
 * events of the workflows it can read only; an event that names no workflow (a run with no workflow) reaches
 * owner and admin only, except `workflowReviewChanged`; the access cache of a stream ends at the ping, so a
 * lost project relation stops the events within one ping; a failed lookup sends nothing.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRow } from '../src/db/schema';
import { PING_INTERVAL_MS } from '../src/routes/push';
import {
  addToProject,
  chain,
  createTestServer,
  memberAs,
  node,
  projectIn,
  realMember,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  workflowIn,
} from './helpers';

let server: TestServer;
let baseUrl: string;

beforeAll(async () => {
  server = await createTestServer();
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface SseEvent {
  event: string;
  data: any;
}

const streams: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of streams.splice(0)) await close();
});

/** open GET /rest/push and collect its events */
async function openPush(cookie: string) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/rest/push`, { headers: { cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : null });
          index = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
  })();
  const close = async () => {
    controller.abort();
    await pump;
  };
  streams.push(close);
  await waitFor(async () => events.some((e) => e.event === 'connected'), { message: 'SSE connection' });
  return { events, close };
}

type Stream = Awaited<ReturnType<typeof openPush>>;

let marks = 0;
/**
 * Sends a per-tenant `workflowReviewChanged` and waits until every stream has it. Events reach a stream in
 * order, so an event sent before the mark that is not there by then was left out.
 */
async function settle(tenantId: string, ...list: Stream[]) {
  const mark = `mark-${++marks}`;
  server.ctx.push.send(tenantId, 'workflowReviewChanged', { workflowId: '', requestId: mark });
  for (const stream of list) {
    await waitFor(async () => stream.events.some((e) => e.data?.requestId === mark), {
      message: `the mark ${mark}`,
    });
  }
}

const started = (stream: Stream, executionId: string) =>
  stream.events.some((e) => e.event === 'executionStarted' && e.data?.executionId === executionId);

/** an execution event as the run path sends it, `workflowId` on the envelope */
function sendRunEvent(tenantId: string, executionId: string, workflowId?: string) {
  server.ctx.push.send(
    tenantId,
    'executionStarted',
    { executionId, workflowId: workflowId ?? null, mode: 'manual' },
    workflowId ? { workflowId } : {},
  );
}

async function setup(role = 'project:viewer') {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id, { name: 'In alpha' });
  const inBeta = await workflowIn(server, owner.tenant.id, beta.id, { name: 'In beta' });
  return { owner, member, alpha, beta, inAlpha, inBeta, tenantId: owner.tenant.id };
}

describe('push filter', () => {
  it('a member gets no live events of a workflow it cannot read', async () => {
    const { owner, member, inAlpha, inBeta, tenantId } = await setup();
    const own = await openPush(owner.client.cookie!);
    const mine = await openPush(member.client.cookie!);
    sendRunEvent(tenantId, 'beta-run', inBeta.id);
    sendRunEvent(tenantId, 'alpha-run', inAlpha.id);
    await settle(tenantId, own, mine);
    expect(started(mine, 'alpha-run')).toBe(true);
    expect(started(mine, 'beta-run')).toBe(false);
    expect(started(own, 'alpha-run')).toBe(true);
    expect(started(own, 'beta-run')).toBe(true);
  });

  it('a real run of another project sends the member nothing', async () => {
    const { owner, member, alpha, beta, tenantId } = await setup();
    const definition = (name: string) => ({
      name,
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'x', 'y')],
      connections: chain('Start', 'Set'),
    });
    const run = async (row: WorkflowRow) => {
      const result = await server.ctx.executions.start({
        tenantId,
        workflow: {
          id: row.id,
          name: row.name,
          nodes: row.nodes as never,
          connections: row.connections as never,
        },
        workflowId: row.id,
        mode: 'manual',
        wait: true,
      });
      await result.finished;
      return result.executionId;
    };
    const mine = await openPush(member.client.cookie!);
    const own = await openPush(owner.client.cookie!);
    const hidden = await run(await workflowIn(server, tenantId, beta.id, definition('Hidden')));
    const visible = await run(await workflowIn(server, tenantId, alpha.id, definition('Visible')));
    await settle(tenantId, mine, own);
    const about = (stream: Stream, id: string) => stream.events.filter((e) => e.data?.executionId === id);
    expect(about(mine, hidden)).toEqual([]);
    expect(about(mine, visible).map((e) => e.event)).toEqual(
      expect.arrayContaining([
        'executionStarted',
        'nodeExecuteBefore',
        'nodeExecuteAfter',
        'executionFinished',
      ]),
    );
    expect(about(own, hidden).map((e) => e.event)).toContain('executionFinished');
  });

  it('an event with no workflowId reaches owner and admin only; workflowReviewChanged reaches everyone', async () => {
    const { owner, member, tenantId } = await setup('project:admin');
    const admin = await memberAs(owner, 'admin');
    const own = await openPush(owner.client.cookie!);
    const adm = await openPush(admin.client.cookie!);
    const mine = await openPush(member.client.cookie!);
    sendRunEvent(tenantId, 'orphan-run');
    await settle(tenantId, own, adm, mine);
    expect(started(own, 'orphan-run')).toBe(true);
    expect(started(adm, 'orphan-run')).toBe(true);
    expect(started(mine, 'orphan-run')).toBe(false);
    // the mark itself is a workflowReviewChanged the member received
    expect(mine.events.some((e) => e.event === 'workflowReviewChanged')).toBe(true);
  });

  it('an event of a workflow that is gone is owner and admin only', async () => {
    const { owner, member, inAlpha, tenantId } = await setup();
    const own = await openPush(owner.client.cookie!);
    const mine = await openPush(member.client.cookie!);
    await server.ctx.repos.workflows.delete(tenantId, inAlpha.id);
    sendRunEvent(tenantId, 'gone-run', inAlpha.id);
    await settle(tenantId, own, mine);
    expect(started(own, 'gone-run')).toBe(true);
    expect(started(mine, 'gone-run')).toBe(false);
  });

  it('a lost project relation stops the events within one ping', async () => {
    const { member, alpha, inAlpha, tenantId } = await setup();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const mine = await openPush(member.client.cookie!);
    sendRunEvent(tenantId, 'before', inAlpha.id);
    await settle(tenantId, mine);
    expect(started(mine, 'before')).toBe(true);

    await server.ctx.repos.projects.relations.remove(tenantId, alpha.id, member.user.id);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    await waitFor(async () => mine.events.some((e) => e.event === 'ping'), { message: 'a ping' });
    sendRunEvent(tenantId, 'after', inAlpha.id);
    await settle(tenantId, mine);
    expect(started(mine, 'after')).toBe(false);
  });

  it('a new project relation opens the events at the next ping', async () => {
    const { member, beta, inBeta, tenantId } = await setup();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const mine = await openPush(member.client.cookie!);
    sendRunEvent(tenantId, 'closed', inBeta.id);
    await settle(tenantId, mine);
    expect(started(mine, 'closed')).toBe(false);
    await addToProject(server, tenantId, beta.id, member.user.id, 'project:viewer');
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    await waitFor(async () => mine.events.some((e) => e.event === 'ping'), { message: 'a ping' });
    sendRunEvent(tenantId, 'open', inBeta.id);
    await settle(tenantId, mine);
    expect(started(mine, 'open')).toBe(true);
  });

  it('fails closed when the access lookup fails', async () => {
    const { member, inAlpha, tenantId } = await setup();
    const mine = await openPush(member.client.cookie!);
    vi.spyOn(server.ctx.access, 'scopesFor').mockRejectedValue(new Error('database down'));
    sendRunEvent(tenantId, 'unknown', inAlpha.id);
    await settle(tenantId, mine);
    expect(started(mine, 'unknown')).toBe(false);
  });
});
