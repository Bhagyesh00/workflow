/**
 * The one seam around kafkajs. Every broker socket, the bootstrap hosts and each broker the cluster
 * advertises alike, goes through the SSRF guard and connects only to the addresses it checked.
 */
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';
import type { CredentialTestContext, DataObject, Logger, NodeCredentialTestResult } from '@workflow/workflow';
import kafkajs, {
  type ISocketFactory,
  type Kafka as KafkaClient,
  type LogEntry,
  type SASLOptions,
} from 'kafkajs';
import { connectGuarded, type GuardedConnectContext, tlsOptions } from '../../../utils/broker-connect';
import { formatPemBlock } from '../../../utils/pem';
import './codecs';

const { Kafka, logLevel } = kafkajs;

const CLIENT_ID = 'workflow';
const CONNECTION_TIMEOUT_MS = 10_000;
const AUTHENTICATION_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_DELAY_MS = 60_000;
/** a topic just created may take a moment to reach the broker that answers */
const UNKNOWN_TOPIC_RETRY_DELAY_MS = 1000;
const COMPLETE_PEM = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+-----END \1-----/;
const BROKER_FORM = /^[^\s:]+:\d+$/;
/** Kafka's own naming rule */
const VALID_TOPIC = /^[a-zA-Z0-9._-]{1,249}$/;

export interface KafkaCredentials extends DataObject {
  clientId?: string;
  brokers?: string;
  ssl?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  allowUnauthorizedCerts?: boolean;
  authentication?: boolean;
  username?: string;
  password?: string;
  saslMechanism?: string;
}

export interface KafkaContext extends GuardedConnectContext {
  logger: Pick<Logger, 'debug'>;
}

export interface KafkaHandle {
  kafka: KafkaClient;
  /** ends every socket still open: a hung broker cannot keep one after the close */
  destroySockets(): void;
}

function brokerList(credentials: KafkaCredentials): string[] {
  const brokers = String(credentials.brokers ?? '')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
  if (brokers.length === 0) throw new Error('Enter at least one broker');
  for (const broker of brokers) {
    if (!BROKER_FORM.test(broker)) throw new Error(`Broker "${broker}" needs the form host:port`);
  }
  return brokers;
}

function checkedPem(value: string, fieldName: string): string {
  if (!COMPLETE_PEM.test(formatPemBlock(value))) {
    throw new Error(`The Kafka ${fieldName} is not a valid PEM block`);
  }
  return value;
}

/** the TLS settings of the credential; undefined when SSL is off. Verification stays on unless asked. */
export function kafkaTlsOptions(credentials: KafkaCredentials): ConnectionOptions | undefined {
  if (credentials.ssl === false) return undefined;
  const ca = credentials.ca?.trim();
  const cert = credentials.cert?.trim();
  const key = credentials.key?.trim();
  if (Boolean(cert) !== Boolean(key)) {
    throw new Error('Kafka mTLS needs both a client certificate and a client private key');
  }
  return tlsOptions({
    ...(ca ? { ca: checkedPem(ca, 'CA certificate') } : {}),
    ...(cert ? { cert: checkedPem(cert, 'client certificate') } : {}),
    ...(key ? { key: checkedPem(key, 'client private key') } : {}),
    ...(credentials.allowUnauthorizedCerts === true ? { rejectUnauthorized: false } : {}),
  });
}

function saslOptions(credentials: KafkaCredentials): SASLOptions | undefined {
  if (!credentials.authentication) return undefined;
  const { username, password } = credentials;
  if (!(username && password)) throw new Error('Username and password are required for authentication');
  return {
    mechanism: credentials.saslMechanism ?? 'plain',
    username,
    password,
  } as SASLOptions;
}

/**
 * kafkajs asks for its socket synchronously, and the guard is asynchronous. This stands in for the
 * socket until the guarded one is connected, and then passes bytes both ways. A TLS socket and a plain
 * one look the same to kafkajs from here, and it never sees a socket that has not been checked.
 */
class GuardedBrokerSocket extends Duplex {
  private target?: Socket;

  constructor(opening: Promise<Socket>, onConnect: () => void) {
    super();
    void opening.then(
      (socket) => {
        if (this.destroyed || this.writableEnded) {
          socket.destroy();
          this.destroy();
          return;
        }
        this.target = socket;
        socket.on('data', (chunk: Buffer) => {
          if (!this.push(chunk)) socket.pause();
        });
        socket.on('end', () => this.push(null));
        socket.on('error', (error) => this.destroy(error));
        socket.on('close', () => this.destroy());
        socket.setKeepAlive(true, KEEP_ALIVE_DELAY_MS);
        onConnect();
      },
      (error: Error) => this.destroy(error),
    );
  }

  override _read(): void {
    this.target?.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (!this.target) {
      done(new Error('The broker socket is not connected'));
      return;
    }
    this.target.write(chunk, encoding, done);
  }

  override _final(done: (error?: Error | null) => void): void {
    // kafkajs ends the socket only when it has finished with the connection
    if (this.target) this.target.destroySoon();
    else this.destroy();
    done();
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.target?.destroy();
    done(error);
  }

  unref(): this {
    this.target?.unref();
    return this;
  }

  ref(): this {
    this.target?.ref();
    return this;
  }
}

/** a kafkajs socket factory that checks each host it is asked for; `tlsConfig` present means TLS */
export function guardedSocketFactory(ctx: GuardedConnectContext, tlsConfig?: ConnectionOptions) {
  const sockets = new Set<GuardedBrokerSocket>();
  const socketFactory: ISocketFactory = ({ host, port, onConnect }) => {
    const socket = new GuardedBrokerSocket(
      connectGuarded(ctx, { host, port, tls: tlsConfig, timeoutMs: CONNECTION_TIMEOUT_MS }),
      onConnect,
    );
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket as unknown as Socket;
  };
  return {
    socketFactory,
    open: () => sockets.size,
    destroyAll() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

/** check the credential and the bootstrap hosts, so a blocked host fails at once, and build the client */
export async function openKafka(
  ctx: KafkaContext,
  credentials: KafkaCredentials,
  options: { retries?: number } = {},
): Promise<KafkaHandle> {
  const brokers = brokerList(credentials);
  const tlsConfig = kafkaTlsOptions(credentials);
  const sasl = saslOptions(credentials);
  for (const broker of brokers) await ctx.helpers.resolveAllowedHost(broker.split(':')[0]!);
  const sockets = guardedSocketFactory(ctx, tlsConfig);
  const kafka = new Kafka({
    clientId: credentials.clientId?.trim() || CLIENT_ID,
    brokers,
    sasl,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    authenticationTimeout: AUTHENTICATION_TIMEOUT_MS,
    socketFactory: sockets.socketFactory,
    ...(options.retries === undefined ? {} : { retry: { retries: options.retries } }),
    logLevel: logLevel.WARN,
    logCreator:
      () =>
      ({ log }: LogEntry) =>
        ctx.logger.debug(`kafkajs: ${log.message}`),
  });
  return { kafka, destroySockets: sockets.destroyAll };
}

/**
 * Fail a start on a topic that is not there: the workflow would show as published and consume nothing,
 * because a topic made later is only picked up at the next metadata refresh. A topic that starts with
 * `^` is a pattern. Any other problem is left for the consumer to report.
 */
export async function assertTopicExists(
  kafka: KafkaClient,
  topic: string,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  if (topic.startsWith('^')) return;
  if (!VALID_TOPIC.test(topic)) {
    throw new Error(
      `Kafka topic "${topic}" is not a valid Kafka topic name. Correct the Topic field, then publish the workflow again.`,
    );
  }
  const admin = kafka.admin();
  let found = true;
  try {
    await admin.connect();
    found = (await admin.listTopics()).includes(topic);
    if (!found) {
      await new Promise((resolve) => setTimeout(resolve, UNKNOWN_TOPIC_RETRY_DELAY_MS));
      found = (await admin.listTopics()).includes(topic);
    }
  } catch {
    found = true;
    logger.warn('Kafka topic could not be verified before starting the consumer');
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
  if (!found) {
    throw new Error(
      `Kafka topic "${topic}" does not exist. Create the topic on the broker, or correct the Topic field, then publish the workflow again.`,
    );
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  for (let current = error as { name?: string; originalError?: unknown } | undefined; current; ) {
    if (current.name === 'KafkaJSSASLAuthenticationError') return true;
    current = current.originalError as typeof current;
  }
  return false;
}

/** connect, sign in and read the topic list; the answer is ours, never the text of the broker */
export async function kafkaCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let handle: KafkaHandle;
  try {
    handle = await openKafka(ctx, credential.data as KafkaCredentials, { retries: 1 });
  } catch (error) {
    // a credential field that is not usable, or the guard refusing a host: our own texts
    return { status: 'Error', message: (error as Error).message };
  }
  const admin = handle.kafka.admin();
  const abort = () => handle.destroySockets();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    await admin.connect();
    await admin.listTopics();
    return { status: 'OK', message: 'Connection successful' };
  } catch (error) {
    return {
      status: 'Error',
      message: isAuthenticationFailure(error)
        ? 'Kafka refused the username or password'
        : "Couldn't connect to the Kafka brokers",
    };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    await admin.disconnect().catch(() => undefined);
    handle.destroySockets();
  }
}
