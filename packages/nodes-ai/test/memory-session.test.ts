/**
 * P5-47 Session parity: the session id source (input, Chat Trigger, custom key), the scope per memory
 * node, the error texts, and the SSH tunnel for the Postgres connection.
 */
import net from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, Item, WorkflowNode } from '@workflow/workflow';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SshServer, startSshServer } from '../../nodes-base/test/ssh-server';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import {
  connect,
  modelRequests,
  node,
  PG_CREDENTIALS,
  reply,
  run,
  scriptModel,
  services,
  testNodes,
  toolCalls,
} from './harness';

// every tunnel the code under test opens, so a test can check that it was closed
const tunnels: Array<{ port: number }> = [];
vi.mock('@workflow/nodes-base/utils/ssh-tunnel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@workflow/nodes-base/utils/ssh-tunnel')>();
  return {
    ...original,
    openSshTunnel: async (...args: Parameters<typeof original.openSshTunnel>) => {
      const tunnel = await original.openSshTunnel(...args);
      tunnels.push({ port: tunnel.port });
      return tunnel;
    },
  };
});

const suffix = `${process.pid}_${Date.now()}`;
const table = `ai_session_${suffix}`;
const pgClient = new pg.Client({ ...PG_CREDENTIALS });
const pgCreds = { postgres: PG_CREDENTIALS };

const pgMemory = (name: string, parameters: DataObject = {}, tableName = table): WorkflowNode =>
  node(
    name,
    'ai.memoryPostgresChat',
    { tableName, contextWindowLength: 5, ...parameters },
    { credentials: { postgres: { id: 'pg', name: 'pg' } } },
  );

const chatItem = (sessionId: unknown, chatInput = 'hi') => [{ json: { sessionId, chatInput } }];

async function sessions(tableName = table): Promise<string[]> {
  const rows = await pgClient.query(`SELECT DISTINCT session_id FROM "${tableName}" ORDER BY session_id`);
  return rows.rows.map((r) => r.session_id as string);
}

beforeAll(() => pgClient.connect());
afterAll(async () => {
  await pgClient.query(`DROP TABLE IF EXISTS "${table}"`);
  await pgClient.end();
});
beforeEach(() => {
  clearBufferMemory();
  modelRequests.clear();
  tunnels.length = 0;
});

/** Chat -> Agent with one memory node, run once */
async function converse(
  memory: WorkflowNode,
  items: Item[] = chatItem('s1'),
  opts: { chatName?: string } = {},
) {
  const chat = opts.chatName ?? 'Chat';
  const requests = scriptModel('Model', ['ok']);
  const r = await run(
    [node(chat, 'ai.chatTrigger'), node('Agent', 'ai.agent'), node('Model', 'test.fakeChatModel'), memory],
    connect([chat, 'Agent'], ['Model', 'Agent', 'ai_languageModel'], [memory.name, 'Agent', 'ai_memory']),
    { triggerItems: items, services: services({ creds: pgCreds }) },
  );
  return { r, requests };
}

describe('session id source and scope', () => {
  it('two memory nodes on one session keep separate history', async () => {
    const a = scriptModel('ModelA', ['a1', 'a2']);
    const b = scriptModel('ModelB', ['b1', 'b2']);
    const nodes = [
      node('Chat', 'ai.chatTrigger'),
      node('AgentA', 'ai.agent'),
      node('ModelA', 'test.fakeChatModel'),
      pgMemory('MemA'),
      node('AgentB', 'ai.agent', { promptType: 'define', text: 'second question' }),
      node('ModelB', 'test.fakeChatModel'),
      pgMemory('MemB'),
    ];
    const links = connect(
      ['Chat', 'AgentA'],
      ['AgentA', 'AgentB'],
      ['ModelA', 'AgentA', 'ai_languageModel'],
      ['MemA', 'AgentA', 'ai_memory'],
      ['ModelB', 'AgentB', 'ai_languageModel'],
      ['MemB', 'AgentB', 'ai_memory'],
    );
    const options = {
      triggerItems: chatItem('shared', 'first question'),
      services: services({ creds: pgCreds }),
    };
    const first = await run(nodes, links, options);
    expect(first.status, JSON.stringify(first.error)).toBe('success');
    const second = await run(nodes, links, options);
    expect(second.status).toBe('success');
    const history = (requests: typeof a) =>
      requests[1].messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.content]);
    // each agent sees only its own earlier exchange, not the other's
    expect(history(a)).toEqual([
      ['user', 'first question'],
      ['assistant', 'a1'],
      ['user', 'first question'],
    ]);
    expect(history(b)).toEqual([
      ['user', 'second question'],
      ['assistant', 'b1'],
      ['user', 'second question'],
    ]);
    expect(await sessions()).toEqual(['shared__MemA', 'shared__MemB']);
  });

  it('scopes with the node name cleaned to letters, digits, underscore and dash', async () => {
    const t = `${table}_name`;
    const { r } = await converse(pgMemory('My memory.1 (x)', {}, t), chatItem('s1'));
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(await sessions(t)).toEqual(['s1__My_memory_1__x_']);
    await pgClient.query(`DROP TABLE "${t}"`);
  });

  it('uses a custom key as typed, with no node scope', async () => {
    const t = `${table}_custom`;
    const fixed = await converse(
      pgMemory('Memory', { sessionIdType: 'customKey', sessionKey: 'fixed-key' }, t),
      chatItem('ignored'),
    );
    expect(fixed.r.status, JSON.stringify(fixed.r.error)).toBe('success');
    const mapped = await converse(
      pgMemory('Memory', { sessionIdType: 'customKey', sessionKey: '={{ $json.sessionId }}-x' }, t),
      chatItem('mapped'),
    );
    expect(mapped.r.status).toBe('success');
    expect(await sessions(t)).toEqual(['fixed-key', 'mapped-x']);
    await pgClient.query(`DROP TABLE "${t}"`);
  });

  it('accepts a number and a boolean session id', async () => {
    const t = `${table}_types`;
    expect((await converse(pgMemory('Memory', {}, t), chatItem(42))).r.status).toBe('success');
    expect((await converse(pgMemory('Memory', {}, t), chatItem(true))).r.status).toBe('success');
    expect(await sessions(t)).toEqual(['42__Memory', 'true__Memory']);
    await pgClient.query(`DROP TABLE "${t}"`);
  });

  it('falls back to the Chat Trigger when the input item has no sessionId', async () => {
    const t = `${table}_fallback`;
    scriptModel('ModelA', ['a']);
    scriptModel('ModelB', ['b']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('AgentA', 'ai.agent'),
        node('ModelA', 'test.fakeChatModel'),
        node('AgentB', 'ai.agent', { promptType: 'define', text: 'q' }),
        node('ModelB', 'test.fakeChatModel'),
        pgMemory('Memory', {}, t),
      ],
      connect(
        ['Chat', 'AgentA'],
        ['AgentA', 'AgentB'],
        ['ModelA', 'AgentA', 'ai_languageModel'],
        ['ModelB', 'AgentB', 'ai_languageModel'],
        ['Memory', 'AgentB', 'ai_memory'],
      ),
      { triggerItems: chatItem('from-trigger'), services: services({ creds: pgCreds }) },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    // AgentA's output has no sessionId, so the id came from the trigger's item
    expect(await sessions(t)).toEqual(['from-trigger__Memory']);
    await pgClient.query(`DROP TABLE "${t}"`);
  });

  it('a node name with a quote and braces stays data in the trigger lookup', async () => {
    const t = `${table}_quote`;
    const chat = 'Chat "}} \\ \' $x';
    scriptModel('ModelA', ['a']);
    scriptModel('ModelB', ['b']);
    const r = await run(
      [
        node(chat, 'ai.chatTrigger'),
        node('AgentA', 'ai.agent'),
        node('ModelA', 'test.fakeChatModel'),
        node('AgentB', 'ai.agent', { promptType: 'define', text: 'q' }),
        node('ModelB', 'test.fakeChatModel'),
        pgMemory('Memory', {}, t),
      ],
      connect(
        [chat, 'AgentA'],
        ['AgentA', 'AgentB'],
        ['ModelA', 'AgentA', 'ai_languageModel'],
        ['ModelB', 'AgentB', 'ai_languageModel'],
        ['Memory', 'AgentB', 'ai_memory'],
      ),
      { triggerItems: chatItem('odd-name'), services: services({ creds: pgCreds }) },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(await sessions(t)).toEqual(['odd-name__Memory']);
    await pgClient.query(`DROP TABLE "${t}"`);
  });

  it('a memory under an Agent Tool under an Agent gets the outer chat session id', async () => {
    const t = `${table}_tool`;
    const types = (await import('@workflow/core')).NodeTypes;
    const { withToolVariants } = await import('@workflow/workflow');
    const { nodes: aiNodes } = await import('../src');
    const nodeTypes = new types(withToolVariants([...aiNodes, ...testNodes]));
    scriptModel('Outer', [toolCalls(['Researcher', { input: 'q' }, 'c1']), reply('done')]);
    scriptModel('Inner', ['inner answer']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent'),
        node('Outer', 'test.fakeChatModel'),
        node('Researcher', 'ai.agentTool', {
          toolDescription: 'Researches a topic',
          text: "={{ $fromAI('input', 'The prompt') }}",
        }),
        node('Inner', 'test.fakeChatModel'),
        pgMemory('Memory', {}, t),
      ],
      connect(
        ['Chat', 'Agent'],
        ['Outer', 'Agent', 'ai_languageModel'],
        ['Researcher', 'Agent', 'ai_tool'],
        ['Inner', 'Researcher', 'ai_languageModel'],
        ['Memory', 'Researcher', 'ai_memory'],
      ),
      { triggerItems: chatItem('outer-chat'), services: services({ creds: pgCreds, nodeTypes }), nodeTypes },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(await sessions(t)).toEqual(['outer-chat__Memory']);
    await pgClient.query(`DROP TABLE "${t}"`);
  });
});

describe('session errors', () => {
  const start = (extra: DataObject = {}) => pgMemory('Memory', extra);

  it('No session ID found: no sessionId and no Chat Trigger', async () => {
    const { r } = await converse(start(), [{ json: { chatInput: 'hi' } }]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('No session ID found');
  });

  it('No session ID found: a Chat Trigger ancestor with no run data', async () => {
    scriptModel('Model', ['ok']);
    const r = await run(
      [
        node('Start', 'test.trigger'),
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'q' }),
        node('Model', 'test.fakeChatModel'),
        start(),
      ],
      connect(
        ['Start', 'Agent'],
        ['Chat', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Memory', 'Agent', 'ai_memory'],
      ),
      { triggerItems: [{ json: { x: 1 } }], services: services({ creds: pgCreds }) },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('No session ID found');
  });

  it('Key parameter is empty', async () => {
    const { r } = await converse(start({ sessionIdType: 'customKey', sessionKey: '   ' }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('Key parameter is empty');
  });

  it('Invalid session ID: an object from the input or from a custom key', async () => {
    const fromInput = await converse(start(), chatItem({ $ne: null }));
    expect(fromInput.r.status).toBe('error');
    expect(fromInput.r.error?.message).toContain('Invalid session ID');
    const custom = await converse(
      start({ sessionIdType: 'customKey', sessionKey: '={{ $json.sessionId }}' }),
      chatItem({ $ne: null }),
    );
    expect(custom.r.status).toBe('error');
    expect(custom.r.error?.message).toContain('Invalid session ID');
  });

  it('keeps the 512 character cap', async () => {
    const { r } = await converse(start(), chatItem('x'.repeat(520)));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('longer than 512 characters');
  });
});

describe('Postgres memory through an SSH tunnel', () => {
  let ssh: SshServer;
  beforeAll(async () => {
    ssh = await startSshServer({ password: 'tunnel-pass' });
  });
  afterAll(() => ssh.close());

  const tunnelled = (overrides: DataObject = {}) => ({
    postgres: {
      ...PG_CREDENTIALS,
      // the database host as the SSH server sees it; the SSH server only forwards to 127.0.0.1
      host: '127.0.0.1',
      sshTunnel: true,
      sshAuthenticateWith: 'password',
      sshHost: '127.0.0.1',
      sshPort: ssh.port,
      sshUser: 'tester',
      sshPassword: 'tunnel-pass',
      ...overrides,
    },
  });

  it('connects through the tunnel, resolves only the SSH host, and closes the tunnel', async () => {
    const t = `${table}_ssh`;
    const http = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });
    const resolve = vi.spyOn(http, 'resolveAllowedHost');
    const forwardsBefore = ssh.forwards.length;
    scriptModel('Model', ['ok']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent'),
        node('Model', 'test.fakeChatModel'),
        pgMemory('Memory', {}, t),
      ],
      connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Memory', 'Agent', 'ai_memory']),
      { triggerItems: chatItem('tunnelled'), services: services({ creds: tunnelled(), http }) },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(await sessions(t)).toEqual(['tunnelled__Memory']);
    // the database was reached through the SSH server
    expect(ssh.forwards.length).toBeGreaterThan(forwardsBefore);
    expect(ssh.forwards.at(-1)).toBe('127.0.0.1:5432');
    // one address check, for the SSH host (the harness allows 127.0.0.1, so the call count is the proof)
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('127.0.0.1');
    // the tunnel's listener is gone after the run
    expect(tunnels).toHaveLength(1);
    const refused = await new Promise<string>((resolveCode) => {
      const socket = net.connect({ host: '127.0.0.1', port: tunnels[0].port });
      socket.once('connect', () => {
        socket.destroy();
        resolveCode('connected');
      });
      socket.once('error', (e: NodeJS.ErrnoException) => resolveCode(e.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');
    await pgClient.query(`DROP TABLE "${t}"`);
  });

  it('refuses a blocked SSH host', async () => {
    scriptModel('Model', ['ok']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent'),
        node('Model', 'test.fakeChatModel'),
        pgMemory('Memory', {}, `${table}_blocked`),
      ],
      connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Memory', 'Agent', 'ai_memory']),
      {
        triggerItems: chatItem('blocked'),
        // no allowed addresses: loopback is refused
        services: services({ creds: tunnelled(), http: new HttpClient() }),
      },
    );
    expect(r.status).toBe('error');
    expect(tunnels).toHaveLength(0);
  });
});
