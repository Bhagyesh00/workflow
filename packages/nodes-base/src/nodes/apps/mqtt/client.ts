/**
 * The one seam around mqtt.js: the connection plan of a credential, a client that is connected to the
 * checked addresses only, and the credential test. TCP and TLS sockets come from `connectGuarded` (the
 * host is checked once and the socket uses only those addresses); a WebSocket gets the same pinned
 * `lookup`. The client never reconnects by itself: a lost connection is reported and the runtime restarts.
 */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';
import mqtt, { type IClientOptions, MqttClient } from 'mqtt';
import {
  connectGuarded,
  type GuardedConnectContext,
  guardedLookup,
  tlsOptions,
} from '../../../utils/broker-connect';
import { formatPemBlock } from '../../../utils/pem';

const CONNECT_TIMEOUT_MS = 10_000;
const KEEPALIVE_SECONDS = 60;
const CLOSE_WAIT_MS = 2000;
const COMPLETE_PEM = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+-----END \1-----/;

export type MqttProtocol = 'mqtt' | 'mqtts' | 'ws';

export interface MqttCredentials extends DataObject {
  protocol?: MqttProtocol;
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  clean?: boolean;
  clientId?: string;
  ssl?: boolean;
  passwordless?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

/** how to reach the broker, with every credential field checked */
export interface ConnectionPlan {
  /** mqtt: plain TCP, mqtts: TLS, ws and wss: WebSocket */
  transport: 'mqtt' | 'mqtts' | 'ws' | 'wss';
  host: string;
  port: number;
  tls: ReturnType<typeof tlsOptions>;
  options: IClientOptions;
}

function checkedPem(value: string, fieldName: string): string {
  if (!COMPLETE_PEM.test(formatPemBlock(value))) {
    throw new Error(`The MQTT ${fieldName} is not a valid PEM block`);
  }
  return value;
}

/** the settings of a credential; the password only ever sits in the returned options */
export function connectionPlan(creds: MqttCredentials): ConnectionPlan {
  const host = String(creds.host ?? '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Enter the MQTT host');
  const protocol = creds.protocol ?? 'mqtt';
  if (protocol !== 'mqtt' && protocol !== 'mqtts' && protocol !== 'ws') {
    throw new Error('The MQTT protocol must be mqtt, mqtts or ws');
  }
  const secure = creds.ssl === true || protocol === 'mqtts';
  const transport: ConnectionPlan['transport'] =
    protocol === 'ws' ? (creds.ssl === true ? 'wss' : 'ws') : secure ? 'mqtts' : 'mqtt';
  const defaultPort = { mqtt: 1883, mqtts: 8883, ws: 80, wss: 443 }[transport];
  const port = creds.port === undefined || creds.port === '' ? defaultPort : Number(creds.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('The MQTT port must be a number from 1 to 65535');
  }

  const ca = creds.ca?.trim();
  const cert = creds.cert?.trim();
  const key = creds.key?.trim();
  if (secure && Boolean(cert) !== Boolean(key)) {
    throw new Error('MQTT client certificates need both a certificate and a key');
  }
  const tls = secure
    ? tlsOptions({
        ...(ca ? { ca: checkedPem(ca, 'CA certificate') } : {}),
        ...(cert ? { cert: checkedPem(cert, 'client certificate') } : {}),
        ...(key ? { key: checkedPem(key, 'client key') } : {}),
        // verification stays on unless the credential turns it off
        rejectUnauthorized: creds.rejectUnauthorized !== false,
      })
    : {};

  const options: IClientOptions = {
    clientId: creds.clientId?.trim() || `mqttjs_${Math.random().toString(16).slice(2, 10)}`,
    clean: creds.clean !== false,
    keepalive: KEEPALIVE_SECONDS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // no reconnect inside the client: the socket is checked once, so a new one needs a new check
    reconnectPeriod: 0,
    resubscribe: false,
  };
  // a user name travels only together with a password, as in n8n
  if (creds.username && creds.password) {
    options.username = creds.username;
    options.password = creds.password;
  }
  return { transport, host, port, tls, options };
}

/** a text that never carries the broker's own words */
export function describeConnectError(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 4 || code === 5) return 'MQTT refused the username or password';
  if (code === 2) return 'MQTT refused the client ID';
  if (code === 3) return 'The MQTT broker is not available';
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return `Couldn't connect to MQTT (${code})`;
  const message = error instanceof Error ? error.message : '';
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) return "Couldn't connect to MQTT (ETIMEDOUT)";
  return "Couldn't connect to MQTT";
}

function bracket(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function isGuardRefusal(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'SsrfBlockedError' || /is blocked: private, loopback/.test(error.message))
  );
}

/**
 * check the host, then connect to the checked addresses only; resolves once the broker accepted us.
 * `onClient` runs before the broker can answer: what is delivered right after CONNACK needs its listener by then.
 */
export async function openMqtt(
  ctx: GuardedConnectContext,
  creds: MqttCredentials,
  onClient?: (client: MqttClient) => void,
): Promise<MqttClient> {
  const plan = connectionPlan(creds);
  let client: MqttClient;
  try {
    if (plan.transport === 'ws' || plan.transport === 'wss') {
      const lookup = await guardedLookup(ctx, plan.host);
      const url = `${plan.transport}://${bracket(plan.host)}:${plan.port}`;
      client = mqtt.connect(url, {
        ...plan.options,
        wsOptions: { ...plan.tls, lookup, followRedirects: false, handshakeTimeout: CONNECT_TIMEOUT_MS },
      });
    } else {
      const socket = await connectGuarded(ctx, {
        host: plan.host,
        port: plan.port,
        tls: plan.transport === 'mqtts' ? plan.tls : undefined,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
      client = new MqttClient(() => socket, plan.options);
    }
  } catch (error) {
    // the guard's own refusal says why; a network failure gets a fixed text
    throw isGuardRefusal(error) ? error : new Error(describeConnectError(error));
  }
  onClient?.(client);

  return await new Promise<MqttClient>((resolve, reject) => {
    const settle = (error?: unknown) => {
      client.off('connect', onConnect);
      client.off('error', onError);
      client.off('close', onClose);
      if (error === undefined) {
        resolve(client);
        return;
      }
      // an error with no listener would crash the process
      client.on('error', () => undefined);
      void client.endAsync(true).catch(() => undefined);
      reject(new Error(describeConnectError(error)));
    };
    const onConnect = () => settle();
    const onError = (error: Error) => settle(error);
    const onClose = () => settle(new Error('closed'));
    client.once('connect', onConnect);
    client.once('error', onError);
    client.once('close', onClose);
  });
}

/**
 * End the client within a bound. A plain end waits for every unanswered publish, and on a lost connection
 * they never get an answer. A second end returns at once while the first waits, so the socket goes by hand.
 */
export async function closeMqtt(client: MqttClient): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    client.endAsync(!client.connected).catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, CLOSE_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  client.stream?.destroy();
}

/** connect and sign in; the answer is ours, never the text of the broker */
export async function mqttCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let client: MqttClient | undefined;
  const abort = () => void client?.endAsync(true).catch(() => undefined);
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    client = await openMqtt(ctx, credential.data as MqttCredentials);
    client.on('error', () => undefined);
    return { status: 'OK', message: 'Connection successful' };
  } catch (error) {
    return { status: 'Error', message: (error as Error).message };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    await client?.endAsync(true).catch(() => undefined);
  }
}
