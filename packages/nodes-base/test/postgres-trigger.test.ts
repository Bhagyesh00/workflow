/** P4-09 Postgres Trigger: row events, Advanced channel, clean-up, manual mode, lost connection, pinning. */

import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { createTriggerContext, HttpClient } from '@workflow/core';
import { type DataObject, ExpressionEvaluator, type TriggerResponse, Workflow } from '@workflow/workflow';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { node, nodeTypes, testServices } from './harness';
import { localHttp } from './servers';
import { startSshServer } from './ssh-server';

const URL = 'postgres://postgres:postgres@127.0.0.1:5432/nodes_test';
const creds = {
  postgres: { host: '127.0.0.1', port: 5432, database: 'nodes_test', user: 'postgres', password: 'postgres' },
};
const rand = () => randomBytes(4).toString('hex');
const schema = `tt_${rand()}`;
const rl = (value: string) => ({ __rl: true, mode: 'name', value });

let admin: pg.Client;
const closers: Array<() => Promise<void> | void> = [];

interface Started {
  response: TriggerResponse;
  emitted: DataObject[];
  errors: Error[];
  nodeId: string;
}

const typeOf = () => nodes.find((n) => n.description.name === 'app.postgresTrigger')!;

function build(
  parameters: DataObject,
  mode: 'activate' | 'manual',
  nodeId: string,
  credentials = creds,
  http: HttpClient = localHttp(),
) {
  const wfNode = node('Postgres Trigger', 'app.postgresTrigger', parameters, [0, 0], {
    id: nodeId,
    credentials: { postgres: { id: 'postgres', name: 'postgres' } },
  });
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: [wfNode], connections: {}, staticData: {} },
    nodeTypes,
  );
  const emitted: DataObject[] = [];
  const errors: Error[] = [];
  const abort = new AbortController();
  const ctx = createTriggerContext(
    {
      workflow,
      node: wfNode,
      services: testServices(credentials, { mode: mode === 'manual' ? 'manual' : 'trigger', http }),
      evaluator: new ExpressionEvaluator(),
      signal: abort.signal,
    },
    {
      activationMode: mode,
      emit: (data) => void emitted.push(...(data[0] ?? []).map((i) => i.json)),
      emitError: (error) => void errors.push(error),
    },
  );
  return { ctx, emitted, errors, abort };
}

async function start(
  parameters: DataObject,
  mode: 'activate' | 'manual' = 'activate',
  nodeId = `n${rand()}`,
): Promise<Started> {
  const { ctx, emitted, errors } = build(parameters, mode, nodeId);
  const response = (await typeOf().trigger!(ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { response, emitted, errors, nodeId };
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const fnCount = async (like: string) =>
  Number(
    (
      await admin.query(
        `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE $2`,
        [schema, like],
      )
    ).rows[0].count,
  );
const triggerCount = async (like: string) =>
  Number(
    (
      await admin.query(
        `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgname LIKE $2`,
        [schema, like],
      )
    ).rows[0].count,
  );

const rowParams = (event: string, extra: DataObject = {}): DataObject => ({
  triggerMode: 'createTrigger',
  schema: rl(schema),
  tableName: rl('people'),
  firesOn: event,
  additionalFields: extra,
});

beforeAll(async () => {
  admin = new pg.Client(URL);
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
});

beforeEach(async () => {
  await admin.query(`DROP TABLE IF EXISTS "${schema}".people`);
  await admin.query(`CREATE TABLE "${schema}".people (id serial PRIMARY KEY, name text, meta jsonb)`);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
});

afterAll(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

describe('Table Row Change Events', () => {
  it('emits the notification of an INSERT with the row as the payload', async () => {
    const t = await start(rowParams('INSERT'));
    await admin.query(`INSERT INTO "${schema}".people (name, meta) VALUES ('Ada', '{"a":1}')`);
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted[0]).toMatchObject({
      channel: `n8n_channel_${t.nodeId}`,
      name: 'notification',
      payload: { id: 1, name: 'Ada', meta: { a: 1 } },
    });
    expect(typeof t.emitted[0].processId).toBe('number');
    expect(typeof t.emitted[0].length).toBe('number');
  });

  it('emits the new row of an UPDATE and not an INSERT', async () => {
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('Ada')`);
    const t = await start(rowParams('UPDATE'));
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('Bob')`);
    await admin.query(`UPDATE "${schema}".people SET name = 'Ada L' WHERE name = 'Ada'`);
    await waitFor(() => t.emitted.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0].payload).toMatchObject({ name: 'Ada L' });
  });

  it('emits the old row of a DELETE', async () => {
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('Ada')`);
    const t = await start(rowParams('DELETE'));
    await admin.query(`DELETE FROM "${schema}".people`);
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted[0].payload).toMatchObject({ id: 1, name: 'Ada' });
  });

  it('closeFunction drops the function and the trigger and stops the events', async () => {
    const t = await start(rowParams('INSERT'));
    expect(await fnCount(`n8n_trigger_function_${t.nodeId}`)).toBe(1);
    expect(await triggerCount(`n8n_trigger_${t.nodeId}`)).toBe(1);
    await t.response.closeFunction!();
    expect(await fnCount(`n8n_trigger_function_${t.nodeId}`)).toBe(0);
    expect(await triggerCount(`n8n_trigger_${t.nodeId}`)).toBe(0);
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('late')`);
    await new Promise((r) => setTimeout(r, 150));
    expect(t.emitted).toHaveLength(0);
    await t.response.closeFunction!();
  });

  it('uses custom names, drops a trailing () and uses them to clean up', async () => {
    const names = `c${rand()}`;
    const t = await start(
      rowParams('INSERT', {
        functionName: `fn_${names}()`,
        triggerName: `tg_${names}`,
        channelName: `ch_${names}`,
      }),
    );
    expect(await fnCount(`fn_${names}`)).toBe(1);
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('x')`);
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted[0].channel).toBe(`ch_${names}`);
    await t.response.closeFunction!();
    expect(await fnCount(`fn_${names}`)).toBe(0);
    expect(await triggerCount(`tg_${names}`)).toBe(0);
  });

  it('fails on a custom name that exists, without Replace if Exists, and leaves nothing new behind', async () => {
    const names = `r${rand()}`;
    const extra = { functionName: `fn_${names}`, triggerName: `tg_${names}` };
    const first = await start(rowParams('INSERT', extra));
    await expect(start(rowParams('INSERT', extra))).rejects.toThrow(/already exists/);
    expect(await fnCount(`fn_${names}`)).toBe(1);
    expect(await triggerCount(`tg_${names}`)).toBe(1);
    await first.response.closeFunction!();
  });

  it('replaces the function and trigger of a custom name with Replace if Exists', async () => {
    const names = `p${rand()}`;
    const extra = { functionName: `fn_${names}`, triggerName: `tg_${names}`, channelName: `ch_${names}` };
    const first = await start(rowParams('INSERT', extra));
    const second = await start(rowParams('INSERT', { ...extra, replaceIfExists: true }));
    expect(await fnCount(`fn_${names}`)).toBe(1);
    expect(await triggerCount(`tg_${names}`)).toBe(1);
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('y')`);
    await waitFor(() => second.emitted.length >= 1);
    await second.response.closeFunction!();
    await first.response.closeFunction!();
  });

  it('restarts with the default names without a conflict', async () => {
    const id = `d${rand()}`;
    const a = await start(rowParams('INSERT'), 'activate', id);
    // a crash leaves the objects behind: a second start with the same node replaces them
    const b = await start(rowParams('INSERT'), 'activate', id);
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('z')`);
    await waitFor(() => b.emitted.length >= 1);
    await b.response.closeFunction!();
    await a.response.closeFunction!();
  });

  it('refuses a name with a quote, a space or a leading digit, before connecting', async () => {
    await expect(start(rowParams('INSERT', { functionName: 'bad name' }))).rejects.toThrow(
      'Function Name must start with a letter or underscore and contain only letters, digits, and underscores',
    );
    await expect(start(rowParams('INSERT', { triggerName: '1abc' }))).rejects.toThrow(
      'Trigger Name must start with a letter or underscore and contain only letters, digits, and underscores',
    );
    await expect(start(rowParams('INSERT', { channelName: 'a"; DROP TABLE x;--' }))).rejects.toThrow(
      'Channel Name must start with a letter or underscore and contain only letters, digits, and underscores',
    );
  });

  it('quotes a schema and table name that need it', async () => {
    await admin.query(`CREATE TABLE "${schema}"."we ird""t" (id int, v text)`);
    const t = await start({ ...rowParams('INSERT'), tableName: rl('we ird"t') });
    await admin.query(`INSERT INTO "${schema}"."we ird""t" VALUES (1, 'q')`);
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted[0].payload).toMatchObject({ id: 1, v: 'q' });
  });
});

describe('Advanced', () => {
  it('lower-cases the channel and emits notifications from another connection', async () => {
    const channel = `adv_${rand()}`;
    const t = await start({ triggerMode: 'listenTrigger', channelName: channel.toUpperCase() });
    await admin.query('SELECT pg_notify($1, $2)', [channel, '{"hello":"world"}']);
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted[0]).toMatchObject({ channel, name: 'notification', payload: { hello: 'world' } });
    expect(await fnCount('n8n_trigger_function_%')).toBe(0);
  });

  it('keeps a payload that is not JSON as text and an empty channel is refused', async () => {
    const channel = `adv_${rand()}`;
    const t = await start({ triggerMode: 'listenTrigger', channelName: channel });
    await admin.query('SELECT pg_notify($1, $2)', [channel, 'plain text']);
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted[0].payload).toBe('plain text');
    await expect(start({ triggerMode: 'listenTrigger', channelName: ' ' })).rejects.toThrow(
      'Channel Name is required',
    );
  });

  it('close stops the listening', async () => {
    const channel = `adv_${rand()}`;
    const t = await start({ triggerMode: 'listenTrigger', channelName: channel });
    await t.response.closeFunction!();
    await admin.query('SELECT pg_notify($1, $2)', [channel, '1']);
    await new Promise((r) => setTimeout(r, 150));
    expect(t.emitted).toHaveLength(0);
    expect(t.errors).toHaveLength(0);
  });
});

describe('manual mode', () => {
  it('starts one run with the first notification and uses the _manual names', async () => {
    const t = await start(rowParams('INSERT'), 'manual');
    expect(await fnCount(`n8n_trigger_function_${t.nodeId}_manual`)).toBe(1);
    const waiting = t.response.manualTriggerFunction!();
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('m')`);
    await waiting;
    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0].channel).toBe(`n8n_channel_${t.nodeId}_manual`);
    await t.response.closeFunction!();
    expect(await fnCount(`n8n_trigger_function_${t.nodeId}_manual`)).toBe(0);
  });

  it('keeps a notification that came before the wait began', async () => {
    const channel = `adv_${rand()}`;
    const t = await start({ triggerMode: 'listenTrigger', channelName: channel }, 'manual');
    await admin.query('SELECT pg_notify($1, $2)', [channel, '"early"']);
    await new Promise((r) => setTimeout(r, 150));
    await t.response.manualTriggerFunction!();
    expect(t.emitted[0].payload).toBe('early');
  });

  it('gives up after 60 s, cleans up and reports the error', async () => {
    const t = await start(rowParams('INSERT'), 'manual');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const waiting = t.response.manualTriggerFunction!();
    const outcome = expect(waiting).rejects.toThrow('within 60 seconds');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await fnCount(`n8n_trigger_function_${t.nodeId}_manual`)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await outcome;
    expect(await fnCount(`n8n_trigger_function_${t.nodeId}_manual`)).toBe(0);
    expect(t.emitted).toHaveLength(0);
  });
});

describe('connection', () => {
  it('reports a lost connection once through emitError', async () => {
    const channel = `adv_${rand()}`;
    const t = await start({ triggerMode: 'listenTrigger', channelName: channel });
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'nodes_test' AND pid <> pg_backend_pid() AND query LIKE 'LISTEN%${channel}%'`,
    );
    await waitFor(() => t.errors.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].message).toContain('connection of the trigger was lost');
    await t.response.closeFunction!();
    expect(t.errors).toHaveLength(1);
  });

  it('does not report an error for its own close', async () => {
    const t = await start({ triggerMode: 'listenTrigger', channelName: `adv_${rand()}` });
    await t.response.closeFunction!();
    await new Promise((r) => setTimeout(r, 150));
    expect(t.errors).toHaveLength(0);
  });

  it('refuses a private or metadata address for the database host', async () => {
    for (const host of ['10.0.0.5', '169.254.169.254']) {
      const { ctx } = build(
        { triggerMode: 'listenTrigger', channelName: 'x' },
        'activate',
        'pin',
        { postgres: { ...creds.postgres, host } },
        new HttpClient(),
      );
      await expect(typeOf().trigger!(ctx)).rejects.toThrow();
    }
  });

  it('connects only to the address the check passed (DNS rebind)', async () => {
    const REBIND = 'rebind.test';
    const realLookup = dns.lookup;
    const realPromisesLookup = dns.promises.lookup;
    vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) =>
      host === REBIND
        ? Promise.resolve([{ address: '93.184.215.14', family: 4 }])
        : (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) => {
      if (host !== REBIND) return (realLookup as (...args: unknown[]) => unknown)(host, ...rest);
      const callback = rest[rest.length - 1] as (...args: unknown[]) => void;
      callback(null, '127.0.0.1', 4);
    }) as never);
    const { ctx } = build({ triggerMode: 'listenTrigger', channelName: 'x' }, 'activate', 'pin', {
      postgres: { ...creds.postgres, host: REBIND },
    });
    // the check saw the public address; the socket never asks DNS again, so it cannot reach loopback
    await expect(
      Promise.race([
        typeOf().trigger!(ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('blocked')), 4000)),
      ]),
    ).rejects.toBeDefined();
    expect(lookup.mock.calls.some(([host]) => host === REBIND)).toBe(false);
  });
});

describe('clean-up', () => {
  it('refuses a name of more than 63 characters, because pg_notify would fail every write', async () => {
    const long = 'c'.repeat(64);
    await expect(start(rowParams('INSERT', { channelName: long }))).rejects.toThrow(
      'Channel Name must be 63 characters or fewer',
    );
    await expect(start({ triggerMode: 'listenTrigger', channelName: long })).rejects.toThrow(
      'Channel Name must be 63 characters or fewer',
    );
    await expect(start(rowParams('INSERT', { functionName: 'f'.repeat(70) }))).rejects.toThrow(
      'Function Name must be 63 characters or fewer',
    );
    // 63 is the largest that works
    const ok = await start(rowParams('INSERT', { channelName: 'd'.repeat(63) }));
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('long')`);
    await waitFor(() => ok.emitted.length === 1);
    await ok.response.closeFunction!();
  });

  it('default names from a long node ID fit in 63 characters and the test names stay apart', async () => {
    const id = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
    const real = await start(rowParams('INSERT'), 'activate', id);
    const test = await start(rowParams('INSERT'), 'manual', id);
    const names = (
      await admin.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE 'n8n_trigger_function_%' ORDER BY 1`,
        [schema],
      )
    ).rows.map((r) => r.proname as string);
    expect(names).toHaveLength(2);
    for (const name of names) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(names[0]).not.toBe(names[1]);
    expect(names.some((name) => name.endsWith('_manual'))).toBe(true);
    await real.response.closeFunction!();
    await test.response.closeFunction!();
    expect(await fnCount('n8n_trigger_function_%')).toBe(0);
  });

  it('leaves a function that another trigger still uses, and only logs the failure', async () => {
    const names = `u${rand()}`;
    await admin.query(`CREATE TABLE "${schema}".other_${names} (id int)`);
    await admin.query(
      `CREATE FUNCTION "${schema}"."fn_${names}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$`,
    );
    await admin.query(
      `CREATE TRIGGER tgo_${names} AFTER INSERT ON "${schema}".other_${names} FOR EACH ROW EXECUTE FUNCTION "${schema}"."fn_${names}"()`,
    );
    const t = await start(
      rowParams('INSERT', { functionName: `fn_${names}`, triggerName: `tg_${names}`, replaceIfExists: true }),
    );
    await t.response.closeFunction!();
    expect(await triggerCount(`tg_${names}`)).toBe(0);
    // the other trigger and the function it uses are still there
    expect(await triggerCount(`tgo_${names}`)).toBe(1);
    expect(await fnCount(`fn_${names}`)).toBe(1);
  });

  it('after a lost connection, close still drops what it made, so a restart with the same custom names works', async () => {
    const names = `l${rand()}`;
    const extra = { functionName: `fn_${names}`, triggerName: `tg_${names}`, channelName: `ch_${names}` };
    const first = await start(rowParams('INSERT', extra));
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'nodes_test' AND pid <> pg_backend_pid() AND query LIKE 'LISTEN%ch_${names}%'`,
    );
    await waitFor(() => first.errors.length >= 1);
    // the objects are still in the database; the runtime now stops the trigger and starts it again
    expect(await fnCount(`fn_${names}`)).toBe(1);
    await first.response.closeFunction!();
    expect(await fnCount(`fn_${names}`)).toBe(0);
    expect(await triggerCount(`tg_${names}`)).toBe(0);
    const again = await start(rowParams('INSERT', extra));
    await admin.query(`INSERT INTO "${schema}".people (name) VALUES ('back')`);
    await waitFor(() => again.emitted.length === 1);
    await again.response.closeFunction!();
  });

  it('with an SSH tunnel, the clean-up still works after the run signal has aborted', async () => {
    const ssh = await startSshServer({ password: 'tunnel-pw' });
    closers.push(() => ssh.close());
    const tunneled = {
      postgres: {
        ...creds.postgres,
        sshTunnel: true,
        sshAuthenticateWith: 'password',
        sshHost: '127.0.0.1',
        sshPort: ssh.port,
        sshUser: 'tester',
        sshPassword: 'tunnel-pw',
      },
    };
    const id = `t${rand()}`;
    const { ctx, abort } = build(rowParams('INSERT'), 'activate', id, tunneled);
    const response = (await typeOf().trigger!(ctx)) as TriggerResponse;
    expect(await fnCount(`n8n_trigger_function_${id}`)).toBe(1);
    expect(ssh.forwards.length).toBeGreaterThan(0);
    // the runtime aborts first and closes afterwards
    abort.abort();
    await response.closeFunction!();
    expect(await fnCount(`n8n_trigger_function_${id}`)).toBe(0);
    expect(await triggerCount(`n8n_trigger_${id}`)).toBe(0);
  });
});
