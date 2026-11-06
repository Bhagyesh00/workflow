/**
 * Postgres Trigger: starts a run on LISTEN/NOTIFY notifications. "Table Row Change Events" makes a
 * notify function and an AFTER ROW trigger on the table (and removes both on close); "Advanced"
 * listens on a channel that already exists. Behaviour of n8n's node on node-postgres, with the
 * connection pinned by postgresPool (SSRF guard, TLS, SSH tunnel).
 */
import type {
  DataObject,
  ListSearchResult,
  LoadOptionsContext,
  NodeProperty,
  NodeType,
  TriggerContext,
  TriggerResponse,
} from '@workflow/workflow';
import type pg from 'pg';
import { postgresPool } from './Postgres.node';
import { postgresDialect, tableRef } from './sql';

const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Postgres cuts an identifier at 63 bytes; pg_notify refuses a channel of 64 bytes or more */
const MAX_NAME_BYTES = 63;
const MANUAL_WAIT_MS = 60_000;
const quote = postgresDialect.quote;

function rlValue(value: unknown, fallback = ''): string {
  if (value && typeof value === 'object' && 'value' in (value as object))
    return String((value as { value: unknown }).value ?? fallback);
  return String(value ?? fallback);
}

function checkName(value: string, label: string): string {
  if (!NAME_PATTERN.test(value))
    throw new Error(
      `${label} must start with a letter or underscore and contain only letters, digits, and underscores`,
    );
  if (Buffer.byteLength(value) > MAX_NAME_BYTES)
    throw new Error(`${label} must be ${MAX_NAME_BYTES} characters or fewer`);
  return value;
}

/** a default name from the node ID, cut so that the whole name fits and the suffix stays */
function defaultName(prefix: string, id: string, suffix: string): string {
  return prefix + id.slice(0, Math.max(1, MAX_NAME_BYTES - prefix.length - suffix.length)) + suffix;
}

const rl = (name: string, displayName: string, list: string, def: string, placeholder: string) =>
  ({
    displayName,
    name,
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: def },
    required: true,
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: `Select a ${displayName.toLowerCase().replace(' name', '')}...`,
        typeOptions: { searchListMethod: list, searchable: true },
      },
      { displayName: 'By Name', name: 'name', type: 'string', placeholder },
    ],
    displayOptions: { show: { triggerMode: ['createTrigger'] } },
  }) as NodeProperty;

async function withPool<T>(ctx: LoadOptionsContext, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = await postgresPool(ctx, { connectionTimeoutSeconds: 15 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** what the trigger set up in the database, so close can take it away again */
interface Setup {
  channel: string;
  /** only for Table Row Change Events */
  created?: { table: string; fn: string; trigger: string };
}

function ddl(
  schema: string,
  table: string,
  fn: string,
  trigger: string,
  channel: string,
  event: 'INSERT' | 'UPDATE' | 'DELETE',
  replace: boolean,
): string[] {
  const target = tableRef(postgresDialect, schema, table);
  const fnRef = `${quote(schema)}.${quote(fn)}`;
  const row = event === 'DELETE' ? 'OLD' : 'NEW';
  // the channel was checked against NAME_PATTERN, so it is safe inside the quoted literal
  const body = `BEGIN PERFORM pg_notify('${channel}', row_to_json(${row})::text); RETURN NULL; END;`;
  return [
    `${replace ? 'CREATE OR REPLACE' : 'CREATE'} FUNCTION ${fnRef}() RETURNS trigger LANGUAGE plpgsql AS $fn$ ${body} $fn$`,
    ...(replace ? [`DROP TRIGGER IF EXISTS ${quote(trigger)} ON ${target}`] : []),
    `CREATE TRIGGER ${quote(trigger)} AFTER ${event} ON ${target} FOR EACH ROW EXECUTE FUNCTION ${fnRef}()`,
  ];
}

export const PostgresTriggerNode: NodeType = {
  description: {
    name: 'app.postgresTrigger',
    displayName: 'Postgres Trigger',
    description: 'Starts a run on table row events or a LISTEN/NOTIFY channel',
    icon: 'simple:postgresql',
    iconColor: '#336791',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Postgres Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Data & Storage', 'Triggers'],
    alias: ['postgres', 'postgresql', 'listen', 'notify', 'database', 'row'],
    eventTriggerDescription: 'Waiting for a notification from Postgres',
    credentials: [{ name: 'postgres', required: true }],
    properties: [
      {
        displayName: 'Trigger Mode',
        name: 'triggerMode',
        type: 'options',
        default: 'createTrigger',
        options: [
          {
            name: 'Listen and Create Trigger Rule',
            value: 'createTrigger',
            description: 'Creates a trigger on a table and listens for its row events',
          },
          {
            name: 'Advanced',
            value: 'listenTrigger',
            description: 'Listens on a channel that already exists',
          },
        ],
      },
      rl('schema', 'Schema Name', 'searchSchemas', 'public', 'public'),
      rl('tableName', 'Table Name', 'searchTables', '', 'orders'),
      {
        displayName: 'Channel Name',
        name: 'channelName',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'my_channel',
        description: 'The channel to listen on, as sent by NOTIFY or pg_notify; it is lower-cased',
        displayOptions: { show: { triggerMode: ['listenTrigger'] } },
      },
      {
        displayName: 'Event to Listen For',
        name: 'firesOn',
        type: 'options',
        default: 'INSERT',
        options: [
          { name: 'Insert', value: 'INSERT' },
          { name: 'Update', value: 'UPDATE' },
          { name: 'Delete', value: 'DELETE' },
        ],
        displayOptions: { show: { triggerMode: ['createTrigger'] } },
      },
      {
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection',
        placeholder: 'Add field',
        default: {},
        description:
          'Names of the objects the node creates. A notification carries at most 8000 bytes, and a larger row makes the insert, update or delete itself fail',
        displayOptions: { show: { triggerMode: ['createTrigger'] } },
        options: [
          {
            displayName: 'Channel Name',
            name: 'channelName',
            type: 'string',
            default: '',
            placeholder: 'n8n_channel_...',
            description: 'Channel the trigger notifies; by default one made from the node ID',
          },
          {
            displayName: 'Function Name',
            name: 'functionName',
            type: 'string',
            default: '',
            placeholder: 'n8n_trigger_function_...',
            description: 'Name of the notify function; by default one made from the node ID',
          },
          {
            displayName: 'Replace if Exists',
            name: 'replaceIfExists',
            type: 'boolean',
            default: false,
            description:
              'Whether to replace a function and trigger of the same name. Without it, a custom name that exists already makes the start fail',
          },
          {
            displayName: 'Trigger Name',
            name: 'triggerName',
            type: 'string',
            default: '',
            placeholder: 'n8n_trigger_...',
            description: 'Name of the table trigger; by default one made from the node ID',
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Connection Timeout',
            name: 'connectionTimeout',
            type: 'number',
            default: 30,
            typeOptions: { minValue: 1 },
            description: 'Seconds to wait for the connection to Postgres',
          },
          {
            displayName: 'Delay Closing Idle Connection',
            name: 'delayClosingIdleConnection',
            type: 'number',
            default: 0,
            typeOptions: { minValue: 0 },
            description:
              'Seconds of silence before TCP keep-alive probes start on the listening connection. 0 leaves keep-alive off',
          },
        ],
      },
    ],
  },

  async trigger(ctx: TriggerContext): Promise<TriggerResponse | undefined> {
    const manual = ctx.getActivationMode() === 'manual';
    const mode = String(ctx.getNodeParameter('triggerMode', 0, 'createTrigger'));
    const opt = (name: string, fallback: number) =>
      Number(ctx.getNodeParameter(`options.${name}`, 0, fallback));

    // names are checked before any connection is made
    let channel: string;
    let create: { schema: string; table: string; fn: string; trigger: string; replace: boolean } | undefined;
    let event: 'INSERT' | 'UPDATE' | 'DELETE' = 'INSERT';
    if (mode === 'listenTrigger') {
      channel = String(ctx.getNodeParameter('channelName', 0, ''))
        .trim()
        .toLowerCase();
      if (!channel) throw new Error('Channel Name is required');
      checkName(channel, 'Channel Name');
    } else {
      const schema = rlValue(ctx.getNodeParameter('schema', 0, 'public'), 'public') || 'public';
      const table = rlValue(ctx.getNodeParameter('tableName', 0, '')).trim();
      if (!table) throw new Error('Table Name is required');
      const extra = (ctx.getNodeParameter('additionalFields', 0, {}) ?? {}) as DataObject;
      const text = (key: string) => String(extra[key] ?? '').trim();
      const id = String(ctx.getNode().id ?? ctx.getNode().name).replace(/[^a-zA-Z0-9]/g, '_');
      const suffix = manual ? '_manual' : '';
      const fnGiven = text('functionName').replace(/\(\)$/, '');
      const triggerGiven = text('triggerName');
      channel = checkName(text('channelName') || defaultName('n8n_channel_', id, suffix), 'Channel Name');
      const fn = checkName(fnGiven || defaultName('n8n_trigger_function_', id, suffix), 'Function Name');
      const trigger = checkName(triggerGiven || defaultName('n8n_trigger_', id, suffix), 'Trigger Name');
      const raw = String(ctx.getNodeParameter('firesOn', 0, 'INSERT')).toUpperCase();
      if (raw !== 'INSERT' && raw !== 'UPDATE' && raw !== 'DELETE')
        throw new Error('Event to Listen For must be Insert, Update or Delete');
      event = raw;
      create = {
        schema,
        table,
        fn,
        trigger,
        replace: extra.replaceIfExists === true || (!fnGiven && !triggerGiven),
      };
    }

    const keepAlive = opt('delayClosingIdleConnection', 0);
    // The pool does not get the run's abort signal: with an SSH tunnel the signal would close the
    // tunnel before closeFunction runs (the runtime aborts first), and the clean-up could not reach
    // the database. closeFunction ends the pool, and that closes the tunnel.
    const pool = await postgresPool(
      {
        getCredentials: ((name: string) => ctx.getCredentials(name)) as typeof ctx.getCredentials,
        helpers: ctx.helpers,
      },
      {
        connectionTimeoutSeconds: opt('connectionTimeout', 30),
        ...(keepAlive > 0 ? { keepAliveDelayMs: keepAlive * 1000 } : {}),
      },
    );
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }

    const setup: Setup = { channel };
    let closed = false;
    let failed = false;
    /** the listening connection ended or broke */
    let dead = false;

    const closeFunction = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      // The listening connection is used while it lives. After a lost connection the objects are still
      // in the database, so they are dropped on a new connection from the pool: a restart with the
      // same custom names would otherwise fail with "already exists".
      let databaseDown = false;
      const attempt = async (text: string, viaPool: boolean) => {
        if (databaseDown) return;
        try {
          if (viaPool) await pool.query(text);
          else await client.query(text);
        } catch (error) {
          // a missing object or a database that is gone must not stop the rest of the clean-up; an
          // error without an SQLSTATE code means no connection could be made, so skip the rest
          const code = (error as { code?: unknown }).code;
          if (viaPool && !(typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code))) databaseDown = true;
          ctx.logger.warn('Postgres Trigger could not finish its clean-up');
        }
      };
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        client.removeAllListeners('notification');
        client.release(true);
      };
      if (dead) release();
      else await attempt(`UNLISTEN ${quote(setup.channel)}`, false);
      if (setup.created) {
        const { table, fn, trigger } = setup.created;
        // The trigger first, then the function without CASCADE: a function that other triggers still
        // use (a name the user gave for one that existed) stays, and the failure is only logged.
        await attempt(`DROP TRIGGER IF EXISTS ${quote(trigger)} ON ${table}`, dead);
        await attempt(`DROP FUNCTION IF EXISTS ${fn}()`, dead);
      }
      release();
      await pool.end().catch(() => undefined);
    };

    const lost = (reason?: string) => {
      if (closed || failed) return;
      failed = true;
      ctx.emitError(
        new Error(`The Postgres connection of the trigger was lost${reason ? `: ${reason}` : ''}`),
      );
    };
    // without these listeners an error on the connection would end the process
    client.on('error', (error) => {
      dead = true;
      lost(error.message);
    });
    client.on('end', () => {
      dead = true;
      lost();
    });

    try {
      if (create) {
        const { schema, table, fn, trigger, replace } = create;
        await client.query('BEGIN');
        try {
          for (const text of ddl(schema, table, fn, trigger, channel, event, replace))
            await client.query(text);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
        setup.created = {
          table: tableRef(postgresDialect, schema, table),
          fn: `${quote(schema)}.${quote(fn)}`,
          trigger,
        };
      }
      await client.query(`LISTEN ${quote(channel)}`);
    } catch (error) {
      await closeFunction();
      throw error;
    }

    const toItem = (message: pg.Notification): DataObject => {
      let payload: unknown = message.payload;
      try {
        payload = JSON.parse(String(message.payload));
      } catch {
        // a payload that is not JSON stays text
      }
      return { ...message, payload } as DataObject;
    };

    if (!manual) {
      client.on('notification', (message) => {
        if (!closed) ctx.emit([[{ json: toItem(message) }]]);
      });
      return { closeFunction };
    }

    // a test run: the first notification starts the run, a quiet minute ends the wait
    let first: pg.Notification | undefined;
    let deliver: ((message: pg.Notification) => void) | undefined;
    client.on('notification', (message) => {
      if (deliver) deliver(message);
      else first ??= message;
    });
    const manualTriggerFunction = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          deliver = undefined;
          void closeFunction().finally(() =>
            reject(new Error('No notification arrived within 60 seconds, the test was stopped')),
          );
        }, MANUAL_WAIT_MS);
        const onMessage = (message: pg.Notification) => {
          clearTimeout(timer);
          deliver = undefined;
          ctx.emit([[{ json: toItem(message) }]]);
          resolve();
        };
        if (first) onMessage(first);
        else deliver = onMessage;
      });
    return { closeFunction, manualTriggerFunction };
  },

  methods: {
    listSearch: {
      async searchSchemas(ctx, filter): Promise<ListSearchResult> {
        return withPool(ctx, async (pool) => {
          const { rows } = await pool.query(
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg_toast%' AND ($1 = '' OR schema_name ILIKE '%' || $1 || '%') ORDER BY schema_name",
            [filter ?? ''],
          );
          return {
            results: rows.map((r: DataObject) => ({
              name: String(r.schema_name),
              value: String(r.schema_name),
            })),
          };
        });
      },
      async searchTables(ctx, filter): Promise<ListSearchResult> {
        const schema = rlValue(ctx.getCurrentNodeParameter('schema'), 'public') || 'public';
        return withPool(ctx, async (pool) => {
          const { rows } = await pool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND ($2 = '' OR table_name ILIKE '%' || $2 || '%') ORDER BY table_name",
            [schema, filter ?? ''],
          );
          return {
            results: rows.map((r: DataObject) => ({
              name: String(r.table_name),
              value: String(r.table_name),
            })),
          };
        });
      },
    },
  },
};
