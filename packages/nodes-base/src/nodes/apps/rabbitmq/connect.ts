/**
 * The one seam around amqplib: the connection, the queue setup and the credential test. The broker host
 * goes through the SSRF guard once, and the socket connects only to the addresses that were checked.
 */
import type { CredentialTestContext, DataObject, Logger, NodeCredentialTestResult } from '@workflow/workflow';
import {
  type Channel,
  type ChannelModel,
  connect,
  credentials as amqpCredentials,
  type Options,
  type SocketOptions,
} from 'amqplib';
import { type GuardedConnectContext, guardedLookup, tlsOptions } from '../../../utils/broker-connect';
import { formatPemBlock } from '../../../utils/pem';

const CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_SECONDS = 60;
const COMPLETE_PEM = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+-----END \1-----/;

export interface RabbitMqCredentials extends DataObject {
  hostname?: string;
  port?: number | string;
  username?: string;
  password?: string;
  vhost?: string;
  ssl?: boolean;
  passwordless?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
}

export interface RabbitMqContext extends GuardedConnectContext {
  logger: Pick<Logger, 'debug'>;
}

function checkedPem(value: string, fieldName: string): string {
  if (!COMPLETE_PEM.test(formatPemBlock(value))) {
    throw new Error(`The RabbitMQ ${fieldName} is not a valid PEM block`);
  }
  return value;
}

/** the amqplib connection settings of a credential; the password only ever sits in the returned object */
export function connectionSettings(creds: RabbitMqCredentials): {
  url: Options.Connect;
  socketOptions: SocketOptions;
} {
  const hostname = String(creds.hostname ?? '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('Enter the RabbitMQ hostname');
  const port = creds.port === undefined || creds.port === '' ? 5672 : Number(creds.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The RabbitMQ port must be a number from 1 to 65535');
  }
  const ssl = creds.ssl === true;
  const url: Options.Connect = {
    protocol: ssl ? 'amqps' : 'amqp',
    hostname,
    port,
    vhost: creds.vhost?.trim() || '/',
    heartbeat: HEARTBEAT_SECONDS,
  };
  const socketOptions: SocketOptions = { timeout: CONNECT_TIMEOUT_MS, keepAlive: true };

  if (ssl) {
    const ca = creds.ca?.trim();
    const cert = creds.cert?.trim();
    const key = creds.key?.trim();
    if (Boolean(cert) !== Boolean(key)) {
      throw new Error('RabbitMQ client certificates need both a certificate and a key');
    }
    Object.assign(
      socketOptions,
      tlsOptions({
        ...(ca ? { ca: checkedPem(ca, 'CA certificate') } : {}),
        ...(cert ? { cert: checkedPem(cert, 'client certificate') } : {}),
        ...(key ? { key: checkedPem(key, 'client key') } : {}),
        ...(creds.passphrase ? { passphrase: creds.passphrase } : {}),
      }),
    );
  }
  if (ssl && creds.passwordless !== false) {
    if (!(creds.cert?.trim() && creds.key?.trim())) {
      throw new Error('Passwordless sign-in needs a client certificate and a client key');
    }
    socketOptions.credentials = amqpCredentials.external();
  } else {
    url.username = creds.username ?? 'guest';
    url.password = creds.password ?? '';
  }
  return { url, socketOptions };
}

/** a text that never carries the broker's own words: they can echo the user name or the virtual host */
export function describeConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = (error as { code?: unknown } | undefined)?.code;
  if (/ACCESS[-_]REFUSED/i.test(message)) return 'RabbitMQ refused the username or password';
  // the broker signed the user in and then closed the connection at the virtual host
  if (/NOT[-_]ALLOWED|Expected ConnectionOpenOk/i.test(message)) return 'RabbitMQ refused access to the virtual host';
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return `Couldn't connect to RabbitMQ (${code})`;
  if (/ETIMEDOUT/.test(message)) return "Couldn't connect to RabbitMQ (ETIMEDOUT)";
  return "Couldn't connect to RabbitMQ";
}

/** the broker's refusal of a queue or exchange setup, short and without its long advice */
export function describeSetupError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/transient_nonexcl_queues/.test(message)) {
    return 'RabbitMQ no longer allows a queue that is neither durable nor exclusive. Turn on Durable or Exclusive.';
  }
  if (/ACCESS[-_]REFUSED/i.test(message)) return 'RabbitMQ refused this user access to the queue or exchange';
  const firstLine = message.split(/\r?\n/)[0]!.trim().slice(0, 300);
  return firstLine || "Couldn't set up the RabbitMQ queue";
}

/** check the host, then connect to the checked addresses only */
export async function openRabbit(
  ctx: GuardedConnectContext,
  creds: RabbitMqCredentials,
): Promise<ChannelModel> {
  const { url, socketOptions } = connectionSettings(creds);
  socketOptions.lookup = await guardedLookup(ctx, url.hostname!);
  try {
    return await connect(url, socketOptions);
  } catch (error) {
    throw new Error(describeConnectError(error));
  }
}

export interface QueueSettings {
  queue: string;
  /** declare the queue (true) or require it to be there (false) */
  assertQueue: boolean;
  assertExchange: boolean;
  durable: boolean;
  exclusive: boolean;
  autoDelete: boolean;
  queueArguments: DataObject;
  bindings: Array<{ exchange: string; routingKey: string }>;
  /** matched when the exchange is a headers exchange */
  bindingHeaders: DataObject;
}

/**
 * Declare or check the queue, then bind it. A missing exchange is declared as a topic exchange; one that
 * exists is used as it is, whatever its type, because declaring it again with another type is refused.
 */
export async function prepareQueue(
  connection: ChannelModel,
  channel: Channel,
  settings: QueueSettings,
): Promise<void> {
  if (settings.assertQueue) {
    await channel.assertQueue(settings.queue, {
      durable: settings.durable,
      exclusive: settings.exclusive,
      autoDelete: settings.autoDelete,
      arguments: settings.queueArguments,
    });
  } else {
    await channel.checkQueue(settings.queue);
  }
  for (const { exchange, routingKey } of settings.bindings) {
    if (settings.assertExchange && !(await exchangeExists(connection, exchange))) {
      await channel.assertExchange(exchange, 'topic', { durable: settings.durable });
    }
    await channel.bindQueue(settings.queue, exchange, routingKey, settings.bindingHeaders);
  }
}

/** a refused check closes its channel, so it gets one of its own */
async function exchangeExists(connection: ChannelModel, exchange: string): Promise<boolean> {
  const probe = await connection.createChannel();
  probe.on('error', () => undefined);
  try {
    await probe.checkExchange(exchange);
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/** connect, sign in and open a channel; the answer is ours, never the text of the broker */
export async function rabbitmqCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let connection: ChannelModel | undefined;
  const abort = () => void connection?.close().catch(() => undefined);
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      connection = await openRabbit(ctx, credential.data as RabbitMqCredentials);
    } catch (error) {
      // openRabbit's errors are already ours
      return { status: 'Error', message: (error as Error).message };
    }
    connection.on('error', () => undefined);
    const channel = await connection.createChannel();
    channel.on('error', () => undefined);
    await channel.close();
    return { status: 'OK', message: 'Connection successful' };
  } catch (error) {
    return { status: 'Error', message: describeConnectError(error) };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    await connection?.close().catch(() => undefined);
  }
}
