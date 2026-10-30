import { HttpClient } from '@workflow/core';
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromStoredMessage, toStoredMessage } from '../src/nodes/memory/memory.nodes';
import { connect, node, PG_CREDENTIALS, REDIS_CREDENTIALS, run, scriptModel, services } from './harness';

const suffix = `${process.pid}_${Date.now()}`;

async function converse(
  memory: WorkflowNode,
  creds: Record<string, DataObject>,
  input: string,
  answer: string,
  tenantId = 't1',
  sessionId = 's1',
) {
  const requests = scriptModel('Model', [answer]);
  const r = await run(
    [node('Chat', 'ai.chatTrigger'), node('Agent', 'ai.agent'), node('Model', 'test.fakeChatModel'), memory],
    connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], [memory.name, 'Agent', 'ai_memory']),
    {
      triggerItems: [{ json: { sessionId, chatInput: input } }],
      services: services({ creds, tenantId, http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) }),
    },
  );
  expect(r.status, JSON.stringify(r.error)).toBe('success');
  return { r, history: requests[0].messages.slice(1, -1).map((m) => [m.role, m.content]) };
}

describe('Postgres chat memory', () => {
  const table = `ai_chat_test_${suffix}`;
  const client = new pg.Client({ ...PG_CREDENTIALS });
  const creds = { postgres: PG_CREDENTIALS };
  const memory = node(
    'Memory',
    'ai.memoryPostgresChat',
    { tableName: table, contextWindowLength: 2 },
    {
      credentials: { postgres: { id: 'pg', name: 'pg' } },
    },
  );

  beforeAll(() => client.connect());
  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS "${table}"`);
    await client.end();
  });

  it('creates the table and persists history across executions', async () => {
    expect((await converse(memory, creds, 'I like green', 'Noted.')).history).toEqual([]);
    const second = await converse(memory, creds, 'And blue', 'Nice.');
    expect(second.history).toEqual([
      ['user', 'I like green'],
      ['assistant', 'Noted.'],
    ]);
    // the window keeps the last 2 exchanges
    await converse(memory, creds, 'And red', 'Ok.');
    const fourth = await converse(memory, creds, 'Which colours?', 'Green, blue, red.');
    expect(fourth.history.map((m) => m[1])).toEqual(['And blue', 'Nice.', 'And red', 'Ok.']);

    const rows = await client.query(`SELECT tenant_id, session_id, message FROM "${table}" ORDER BY id`);
    expect(rows.rowCount).toBe(8);
    expect(rows.rows[0]).toEqual({
      tenant_id: 't1',
      session_id: 's1',
      message: { role: 'user', content: 'I like green' },
    });
    // AI logs record loads and saves
    expect(fourth.r.runData.Memory.length).toBeGreaterThanOrEqual(2);
  });

  it('scopes history by tenant and session', async () => {
    expect((await converse(memory, creds, 'hello', 'hi', 't2')).history).toEqual([]);
    expect((await converse(memory, creds, 'hello', 'hi', 't1', 'other')).history).toEqual([]);
  });

  it('checks the host against the SSRF policy', async () => {
    scriptModel('Model', ['x']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent'),
        node('Model', 'test.fakeChatModel'),
        memory,
      ],
      connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Memory', 'Agent', 'ai_memory']),
      {
        triggerItems: [{ json: { sessionId: 's', chatInput: 'x' } }],
        services: services({ creds, http: new HttpClient() }),
      },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/blocked/);
  });

  it('rejects unsafe table names', async () => {
    const bad = node(
      'Memory',
      'ai.memoryPostgresChat',
      { tableName: 'x; DROP TABLE y' },
      { credentials: { postgres: { id: 'pg', name: 'pg' } } },
    );
    scriptModel('Model', ['x']);
    const r = await run(
      [node('Chat', 'ai.chatTrigger'), node('Agent', 'ai.agent'), node('Model', 'test.fakeChatModel'), bad],
      connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Memory', 'Agent', 'ai_memory']),
      { triggerItems: [{ json: { sessionId: 's', chatInput: 'x' } }], services: services({ creds }) },
    );
    expect(r.error?.message).toContain('Invalid table name');
  });
});

describe('Redis chat memory', () => {
  const redis = new Redis({ host: '127.0.0.1', port: 6379, db: 2, lazyConnect: true });
  const creds = { redis: REDIS_CREDENTIALS };
  const session = `redis-session-${suffix}`;
  const memory = node(
    'Memory',
    'ai.memoryRedisChat',
    { sessionTTL: 600, contextWindowLength: 5 },
    {
      credentials: { redis: { id: 'r', name: 'r' } },
    },
  );

  beforeAll(() => redis.connect());
  afterAll(async () => {
    const keys = await redis.keys(`wf:ai:chat:*:${session}`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('stores history per tenant and session with a TTL in db 2', async () => {
    await converse(memory, creds, 'Remember 42', 'Remembered.', 't1', session);
    const second = await converse(memory, creds, 'What number?', '42', 't1', session);
    expect(second.history).toEqual([
      ['user', 'Remember 42'],
      ['assistant', 'Remembered.'],
    ]);
    const key = `wf:ai:chat:t1:${session}`;
    expect(await redis.llen(key)).toBe(4);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(500);
    expect(JSON.parse((await redis.lindex(key, 0))!)).toEqual({ role: 'user', content: 'Remember 42' });

    const otherTenant = await converse(memory, creds, 'What number?', '?', 't9', session);
    expect(otherTenant.history).toEqual([]);
  });
});

describe('stored message format', () => {
  it('keeps role and text only, ignoring malformed entries', () => {
    expect(
      toStoredMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ],
      }),
    ).toEqual({ role: 'user', content: 'hi' });
    expect(fromStoredMessage('{"role":"assistant","content":"x"}')).toEqual({
      role: 'assistant',
      content: 'x',
    });
    expect(fromStoredMessage('{"role":"tool","content":"x"}')).toBeUndefined();
    expect(fromStoredMessage('not json')).toBeUndefined();
  });
});
