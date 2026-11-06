/**
 * The one seam around rhea (AMQP 1.0): the connection, the sender, the message conversion and the
 * credential test. The broker host goes through the SSRF guard once and rhea's `connect` option is our
 * function, so the socket (tcp or tls) goes only to the checked addresses through the pinned lookup.
 */
import net from 'node:net';
import tls from 'node:tls';
import type {
  CredentialTestContext,
  DataObject,
  Logger,
  NodeCredentialTestResult,
  NodeProperty,
} from '@workflow/workflow';
import rhea, { type Connection, type ConnectionOptions, type Message } from 'rhea';
import { type GuardedConnectContext, guardedLookup, tlsOptions } from '../../../utils/broker-connect';
import { formatPemBlock } from '../../../utils/pem';

const OPEN_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 3_000;
const COMPLETE_PEM = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+-----END \1-----/;
const DATA_SECTION = 0x75;

export interface AmqpCredentials extends DataObject {
  hostname?: string;
  port?: number | string;
  username?: string;
  password?: string;
  transportType?: string;
  ca?: string;
}

export interface AmqpContext extends GuardedConnectContext {
  logger: Pick<Logger, 'debug'>;
}

export interface ReconnectSettings {
  reconnect: boolean;
  /** attempts before the connection is given up */
  reconnectLimit: number;
  /** milliseconds to wait before the first new attempt */
  sleepTime: number;
}

export const DEFAULT_RECONNECT: ReconnectSettings = { reconnect: true, reconnectLimit: 50, sleepTime: 10 };

/** a text that never carries the broker's own words: they can echo the user name */
export function describeConnectError(error: unknown): string {
  const condition = (error as { condition?: unknown } | undefined)?.condition;
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : '';
  if (condition === 'amqp:unauthorized-access' || /Authentication failed|sasl/i.test(message)) {
    return 'The AMQP broker refused the username or password';
  }
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) {
    return `Couldn't connect to the AMQP broker (${code})`;
  }
  if (/^(Enter the AMQP|The AMQP|Couldn't connect to the AMQP)/.test(message)) return message;
  return "Couldn't connect to the AMQP broker";
}

function checkedPem(value: string): string {
  if (!COMPLETE_PEM.test(formatPemBlock(value))) {
    throw new Error('The AMQP CA certificate is not a valid PEM block');
  }
  return value;
}

/** the checked host, port and transport of a credential */
export function readEndpoint(creds: AmqpCredentials) {
  const host = String(creds.hostname ?? '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Enter the AMQP hostname');
  const port = creds.port === undefined || creds.port === '' ? 5672 : Number(creds.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The AMQP port must be a number from 1 to 65535');
  }
  const transport = creds.transportType === 'tls' || creds.transportType === 'ssl' ? 'tls' : 'tcp';
  return { host, port, transport } as const;
}

/**
 * rhea's `connect` option. rhea calls it as (port, host, options, onConnected). The name goes through the
 * checked lookup, and a TLS socket checks the certificate against the host name, not an address.
 */
export function pinnedConnect(
  transport: 'tcp' | 'tls',
  lookup: Awaited<ReturnType<typeof guardedLookup>>,
  tlsConfig: tls.ConnectionOptions,
) {
  return (port: number, host: string, _options: unknown, onConnected: () => void) => {
    const target = { port, host, lookup, autoSelectFamily: true };
    if (transport === 'tls') {
      return tls.connect(
        { ...tlsConfig, ...target, servername: net.isIP(host) ? undefined : host },
        onConnected,
      );
    }
    return net.connect(target, onConnected);
  };
}

/** The connection settings of a credential; the password only ever sits in the returned object. */
export async function buildConnectionOptions(
  ctx: GuardedConnectContext,
  creds: AmqpCredentials,
  extra: { containerId?: string } = {},
): Promise<ConnectionOptions> {
  const { host, port, transport } = readEndpoint(creds);
  const ca = creds.ca?.trim();
  const tlsConfig = transport === 'tls' ? tlsOptions(ca ? { ca: checkedPem(ca) } : {}) : {};
  const lookup = await guardedLookup(ctx, host);
  const options: ConnectionOptions & Record<string, unknown> = {
    host,
    port,
    reconnect: false,
    connect: pinnedConnect(transport, lookup, tlsConfig),
  };
  if (creds.username) {
    options.username = creds.username;
    if (creds.password) options.password = creds.password;
  }
  if (extra.containerId) options.container_id = extra.containerId;
  return options;
}

/** connect and sign in; a failed first attempt rejects with our own text, a later loss goes to `onLost` */
export async function openAmqp(
  ctx: GuardedConnectContext,
  creds: AmqpCredentials,
  settings: { containerId?: string } & Partial<ReconnectSettings> = {},
  onLost: (error: Error) => void = () => undefined,
): Promise<Connection> {
  const options = await buildConnectionOptions(ctx, creds, settings);
  const connection = rhea.create_container().create_connection(options);
  let opened = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error("Couldn't connect to the AMQP broker (ETIMEDOUT)")),
        OPEN_TIMEOUT_MS,
      );
      function fail(error: Error) {
        clearTimeout(timer);
        reject(error);
      }
      const lost = (error: unknown) => {
        const reason = new Error(describeConnectError(error));
        if (opened) onLost(reason);
        else fail(reason);
      };
      connection.on('connection_open', () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      });
      connection.on('connection_error', (context: { error?: unknown }) => lost(context.error));
      connection.on('protocol_error', lost);
      connection.on('error', lost);
      connection.on('disconnected', (context: { error?: unknown; reconnecting?: boolean }) => {
        if (context.reconnecting) return;
        lost(context.error ?? new Error('The AMQP connection closed unexpectedly'));
      });
      // errors of a link are handled on the link where the node cares about them
      connection.on('sender_error', () => undefined);
      connection.on('receiver_error', () => undefined);
      connection.on('session_error', () => undefined);
      connection.connect();
    });
  } catch (error) {
    await closeAmqp(connection);
    throw error;
  }

  const reconnect = { ...DEFAULT_RECONNECT, ...settings };
  if (reconnect.reconnect) {
    connection.options.initial_reconnect_delay = Math.max(1, reconnect.sleepTime);
    connection.options.reconnect_limit = reconnect.reconnectLimit;
    connection.set_reconnect(true);
  }
  return connection;
}

/** close the connection and wait for the broker's answer for a short while, then drop the socket */
export async function closeAmqp(connection: Connection): Promise<void> {
  connection.set_reconnect(false);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, CLOSE_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      connection.removeListener('connection_close', done);
      connection.removeListener('disconnected', done);
      (connection as unknown as { socket?: net.Socket }).socket?.destroy();
      resolve();
    }
    connection.on('connection_close', done);
    connection.on('disconnected', done);
    try {
      if (connection.is_open()) connection.close();
      else done();
    } catch {
      done();
    }
  });
}

/** send one message and wait until the broker accepts it */
export async function sendMessage(
  connection: Connection,
  sink: string,
  message: Message,
): Promise<{ id: number }> {
  const sender = connection.open_sender({ target: { address: sink } });
  try {
    return await new Promise<{ id: number }>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(new Error(`The AMQP broker did not take the message within ${SEND_TIMEOUT_MS / 1000} seconds`)),
        SEND_TIMEOUT_MS,
      );
      let sent = false;
      function finish(error?: Error, id?: number) {
        clearTimeout(timer);
        connection.removeListener('disconnected', onDisconnect);
        if (error) reject(error);
        else resolve({ id: id! });
      }
      const onDisconnect = () => finish(new Error('The AMQP connection closed unexpectedly'));
      connection.on('disconnected', onDisconnect);
      sender.on('accepted', (context: { delivery: { id: number } }) => finish(undefined, context.delivery.id));
      sender.on('rejected', () => finish(new Error('The AMQP broker rejected the message')));
      sender.on('released', () => finish(new Error('The AMQP broker released the message')));
      sender.on('modified', () => finish(new Error('The AMQP broker did not take the message')));
      sender.on('sender_error', () => finish(new Error("Couldn't open the AMQP sender")));
      sender.on('sender_close', () => finish(new Error('The AMQP broker closed the link')));
      sender.on('sendable', () => {
        if (sent) return;
        sent = true;
        sender.send(message);
      });
    });
  } finally {
    try {
      sender.close();
    } catch {
      // the link is gone with the connection
    }
  }
}

/** connect and sign in; the answer is ours, never the text of the broker */
export async function amqpCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let connection: Connection | undefined;
  const abort = () => void (connection && closeAmqp(connection));
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    connection = await openAmqp(ctx, credential.data as AmqpCredentials, { reconnect: false });
    return { status: 'OK', message: 'Connection successful' };
  } catch (error) {
    // openAmqp already maps the broker's own words to ours; the guard and field checks are our texts
    return { status: 'Error', message: (error as Error).message };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    if (connection) await closeAmqp(connection);
  }
}

// ---- shared options ----

/** the options both nodes offer for a broker that goes away */
export const CONNECTION_FIELDS: NodeProperty[] = [
  {
    displayName: 'Container ID',
    name: 'containerId',
    type: 'string',
    default: '',
    description: 'Identifies this client to the broker. Empty: a new random id for each connection.',
  },
  {
    displayName: 'Reconnect',
    name: 'reconnect',
    type: 'boolean',
    default: true,
    description: 'Whether to connect again when the connection is lost',
  },
  {
    displayName: 'Reconnect Limit',
    name: 'reconnectLimit',
    type: 'number',
    default: 50,
    description: 'How many times to try to connect again before giving up',
  },
  {
    displayName: 'Sleep Time',
    name: 'sleepTime',
    type: 'number',
    default: 10,
    description: 'Milliseconds to wait before the first new attempt. Each next wait is twice as long, up to 60 seconds.',
  },
];

/** the reconnect settings and container id of a node's Options collection */
export function readConnectionOptions(options: DataObject): { containerId?: string } & ReconnectSettings {
  const whole = (value: unknown, fallback: number, min: number) => {
    const number = Number(value);
    if (value === undefined || value === '' || !Number.isFinite(number)) return fallback;
    return Math.max(min, Math.floor(number));
  };
  const containerId = typeof options.containerId === 'string' ? options.containerId.trim() : '';
  return {
    ...(containerId ? { containerId } : {}),
    reconnect: options.reconnect !== false,
    reconnectLimit: whole(options.reconnectLimit, DEFAULT_RECONNECT.reconnectLimit, 0),
    sleepTime: whole(options.sleepTime, DEFAULT_RECONNECT.sleepTime, 1),
  };
}

// ---- messages ----

const isObject = (value: unknown): value is DataObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);

/** the bytes of a data-section body (one section or many) */
function sectionBytes(body: unknown): Buffer | undefined {
  const section = body as { typecode?: unknown; content?: unknown; multiple?: unknown } | null;
  if (!section || typeof section !== 'object' || section.typecode !== DATA_SECTION) return undefined;
  if (section.multiple && Array.isArray(section.content)) return Buffer.concat(section.content as Buffer[]);
  return Buffer.isBuffer(section.content) ? section.content : undefined;
}

/** a value rhea decoded, made safe for JSON: bytes as base64, dates as ISO text, ids as text */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value !== 'object') return value;
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return String(value);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonSafe(entry, depth + 1)]),
  );
}

export interface BodyOptions {
  convertBodyToString: boolean;
  jsonParseBody: boolean;
  onlyBody: boolean;
}

/** the body of a message as the node outputs it */
export function readBody(message: { body?: unknown }, options: BodyOptions): unknown {
  let body: unknown = sectionBytes(message.body) ?? message.body;
  if (Buffer.isBuffer(body)) {
    // bytes that were not converted keep the shape JSON.stringify gives them
    body = options.convertBodyToString ? body.toString('utf8') : { type: 'Buffer', data: [...body] };
  }
  if (options.jsonParseBody && typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      // not JSON: the text stays as it is
    }
  }
  return jsonSafe(body);
}

/** the item a message starts a run with; a body that is not an object becomes `{ message: body }` */
export function messageToJson(message: Record<string, unknown>, options: BodyOptions): DataObject {
  const body = readBody(message, options);
  if (options.onlyBody) return isObject(body) ? body : { message: body };
  const { body: _body, ...rest } = message;
  return { ...(jsonSafe(rest) as DataObject), body } as DataObject;
}
