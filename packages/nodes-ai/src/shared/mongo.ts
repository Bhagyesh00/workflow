/**
 * MongoDB client behind the SSRF guard. Every socket of the driver (seed, discovered member,
 * monitor, pool) goes through an own loopback SOCKS5 listener that checks each destination with
 * `resolveAllowedHost` and connects only to the checked addresses. A `lookup` option alone is not
 * enough: Node skips it for an IP literal, so a server could list private members by address.
 *
 * Connection strings carry an allow-list of options: anything that reads files or host state
 * (CA files, OIDC, AWS, Kerberos) or picks a proxy is refused.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import type {
  AllowedHost,
  BaseContext,
  CredentialTestContext,
  DataObject,
  NodeCredentialTestResult,
} from '@workflow/workflow';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import { acquireShared, type ConnectionContext, type Shared, sharedKey } from './shared-resource';
import { redactSecrets } from './utils';

export interface MongoHandle {
  client: MongoClient;
  /** the credential's database, when it names one; the node's own parameter may override it */
  databaseName: string | undefined;
}

type GuardContext = Pick<CredentialTestContext, 'helpers' | 'logger'>;

interface Guard {
  port: number;
  username: string;
  password: string;
  close(): Promise<void>;
  /** why the last refused destination was refused (for a clearer error than a server selection timeout) */
  refusal(): Error | undefined;
}

/** sockets one guard holds open at once (a replica set of 7 with a pool of 5 needs about 50) */
const GUARD_MAX_CONNECTIONS = 100;
/** time a client has to finish the SOCKS greeting, sign-in and request */
const GUARD_HANDSHAKE_MS = 10_000;
/** largest SOCKS handshake buffer: a request with a 255-byte domain is far below it */
const GUARD_MAX_HANDSHAKE_BYTES = 1024;

const SOCKS_VERSION = 5;
const AUTH_VERSION = 1;
const METHOD_USER_PASSWORD = 2;
const NO_ACCEPTABLE_METHOD = 0xff;
const CMD_CONNECT = 1;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_IPV6 = 4;
const REPLY_OK = 0;
const REPLY_FAILURE = 1;
const REPLY_NOT_ALLOWED = 2;
const REPLY_NETWORK_UNREACHABLE = 3;
const REPLY_HOST_UNREACHABLE = 4;
const REPLY_CONNECTION_REFUSED = 5;
const REPLY_COMMAND_NOT_SUPPORTED = 7;
const REPLY_ADDRESS_NOT_SUPPORTED = 8;

/** Reads exact byte counts from a socket during the SOCKS handshake. */
function byteReader(socket: net.Socket) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  let waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  const settle = () => {
    if (!waiter) return;
    if (buffer.length >= waiter.n) {
      const chunk = buffer.subarray(0, waiter.n);
      buffer = buffer.subarray(waiter.n);
      const w = waiter;
      waiter = undefined;
      w.resolve(chunk);
    } else if (closed) {
      const w = waiter;
      waiter = undefined;
      w.reject(new Error('closed'));
    }
  };
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > GUARD_MAX_HANDSHAKE_BYTES) {
      socket.destroy();
      return;
    }
    settle();
  };
  const onClose = () => {
    closed = true;
    settle();
  };
  socket.on('data', onData);
  socket.on('close', onClose);
  return {
    read(n: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        waiter = { n, resolve, reject };
        settle();
      });
    },
    /** stops reading and returns the bytes that came after the handshake */
    detach(): Buffer {
      socket.pause();
      socket.off('data', onData);
      socket.off('close', onClose);
      return buffer;
    },
  };
}

function digest(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

function socksReply(code: number): Buffer {
  return Buffer.from([SOCKS_VERSION, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

function connectErrorReply(error: NodeJS.ErrnoException): number {
  if (error.code === 'ECONNREFUSED') return REPLY_CONNECTION_REFUSED;
  if (error.code === 'EHOSTUNREACH') return REPLY_HOST_UNREACHABLE;
  if (error.code === 'ENETUNREACH') return REPLY_NETWORK_UNREACHABLE;
  return REPLY_FAILURE;
}

async function createGuard(ctx: GuardContext): Promise<Guard> {
  // a pair per client, so no other local process can use this listener
  const username = randomBytes(16).toString('hex');
  const password = randomBytes(32).toString('hex');
  const userDigest = digest(username);
  const passwordDigest = digest(password);
  const sockets = new Set<net.Socket>();
  let lastRefusal: Error | undefined;

  const handle = async (client: net.Socket) => {
    const reader = byteReader(client);
    const timer = setTimeout(() => client.destroy(), GUARD_HANDSHAKE_MS);
    client.once('close', () => clearTimeout(timer));
    try {
      // greeting: version, methods; only username and password (RFC 1929) is accepted
      const [version, count] = await reader.read(2);
      if (version !== SOCKS_VERSION) return void client.destroy();
      const methods = await reader.read(count);
      if (!methods.includes(METHOD_USER_PASSWORD)) {
        return void client.end(Buffer.from([SOCKS_VERSION, NO_ACCEPTABLE_METHOD]));
      }
      client.write(Buffer.from([SOCKS_VERSION, METHOD_USER_PASSWORD]));
      const [authVersion, userLength] = await reader.read(2);
      const user = await reader.read(userLength);
      const [passwordLength] = await reader.read(1);
      const pass = await reader.read(passwordLength);
      const userOk = timingSafeEqual(digest(user), userDigest);
      const passwordOk = timingSafeEqual(digest(pass), passwordDigest);
      if (authVersion !== AUTH_VERSION || !userOk || !passwordOk) {
        return void client.end(Buffer.from([AUTH_VERSION, 1]));
      }
      client.write(Buffer.from([AUTH_VERSION, 0]));

      // request: CONNECT to an IPv4, domain or IPv6 destination
      const [requestVersion, command, , addressType] = await reader.read(4);
      if (requestVersion !== SOCKS_VERSION) return void client.destroy();
      let host: string;
      if (addressType === ATYP_IPV4) {
        host = [...(await reader.read(4))].join('.');
      } else if (addressType === ATYP_DOMAIN) {
        const [length] = await reader.read(1);
        host = (await reader.read(length)).toString('utf8');
      } else if (addressType === ATYP_IPV6) {
        const bytes = await reader.read(16);
        const groups: string[] = [];
        for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
        host = groups.join(':');
      } else {
        return void client.end(socksReply(REPLY_ADDRESS_NOT_SUPPORTED));
      }
      const port = (await reader.read(2)).readUInt16BE(0);
      if (command !== CMD_CONNECT) return void client.end(socksReply(REPLY_COMMAND_NOT_SUPPORTED));

      let allowed: AllowedHost;
      try {
        allowed = await ctx.helpers.resolveAllowedHost(host);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'the address is not allowed';
        lastRefusal = new Error(`MongoDB host ${host} refused: ${reason}`);
        ctx.logger.warn('MongoDB destination refused by the address policy', { host, port });
        return void client.end(socksReply(REPLY_NOT_ALLOWED));
      }

      // connect only to the checked addresses, never to a fresh resolution of the name
      const upstream = net.connect({ host, port, lookup: allowed.lookup, autoSelectFamily: true });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.once('error', (error: NodeJS.ErrnoException) => {
        if (!client.destroyed) client.end(socksReply(connectErrorReply(error)));
      });
      upstream.once('connect', () => {
        clearTimeout(timer);
        upstream.removeAllListeners('error');
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.write(socksReply(REPLY_OK));
        const rest = reader.detach();
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        ctx.logger.debug('MongoDB destination connected', { host, port });
      });
      client.once('close', () => {
        if (upstream.connecting) upstream.destroy();
      });
    } catch {
      client.destroy();
    }
  };

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    void handle(client);
  });
  server.maxConnections = GUARD_MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as net.AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    port,
    username,
    password,
    refusal: () => lastRefusal,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}

/** The loopback SOCKS5 guard one client connects through; closes with the client. */
export async function startMongoGuard(
  ctx: Pick<CredentialTestContext, 'helpers' | 'logger'>,
): Promise<{ port: number; username: string; password: string; close(): Promise<void> }> {
  return createGuard(ctx);
}

// ---------------------------------------------------------------------------------------------
// Connection string and options
// ---------------------------------------------------------------------------------------------

/** connection string options a credential may set, by lower-case name; none reads a file or host state */
const ALLOWED_OPTIONS = new Set(
  [
    'authSource',
    'authMechanism',
    'replicaSet',
    'directConnection',
    'tls',
    'ssl',
    'tlsAllowInvalidCertificates',
    'tlsAllowInvalidHostnames',
    'retryWrites',
    'retryReads',
    'w',
    'journal',
    'wtimeoutMS',
    'readPreference',
    'readConcernLevel',
    'appName',
    'maxPoolSize',
    'minPoolSize',
    'maxIdleTimeMS',
    'connectTimeoutMS',
    'socketTimeoutMS',
    'serverSelectionTimeoutMS',
    'srvMaxHosts',
    'srvServiceName',
    'compressors',
  ].map((name) => name.toLowerCase()),
);

/** sign-in methods that use only what the credential holds (X.509 uses its cert and key) */
const ALLOWED_MECHANISMS = new Set(['SCRAM-SHA-1', 'SCRAM-SHA-256', 'MONGODB-X509', 'PLAIN']);

/** the driver's own split of a connection string (mongodb-connection-string-url) */
const CONNECTION_STRING =
  /^(?<protocol>[^/]+):\/\/(?:(?<username>[^:@]*)(?::(?<password>[^@]*))?@)?(?<hosts>(?!:)[^/?@]*)(?<rest>.*)/;

const DEFAULT_SERVER_SELECTION_MS = 15_000;
const DEFAULT_CONNECT_MS = 10_000;

function text(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : value === undefined || value === null
      ? ''
      : String(value).trim();
}

function refuse(name: string): Error {
  return new Error(`The connection string option "${name}" is not allowed`);
}

/** Checks every option of the string; returns the values it sets, by lower-case name. */
function checkConnectionString(url: string): Map<string, string[]> {
  const match = CONNECTION_STRING.exec(url);
  const protocol = match?.groups?.protocol.toLowerCase();
  if (!match?.groups || (protocol !== 'mongodb' && protocol !== 'mongodb+srv')) {
    throw new Error('The connection string must start with mongodb:// or mongodb+srv://');
  }
  const rest = match.groups.rest.split('#')[0];
  const queryAt = rest.indexOf('?');
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : '';
  const values = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(query)) {
    const lower = name.toLowerCase();
    if (!ALLOWED_OPTIONS.has(lower)) throw refuse(name);
    if (lower === 'authmechanism' && !ALLOWED_MECHANISMS.has(value.trim().toUpperCase())) throw refuse(name);
    values.set(lower, [...(values.get(lower) ?? []), value]);
  }
  return values;
}

function bracketHost(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** The database the credential names: its own field, else the path of the connection string. */
function credentialDatabase(credentials: DataObject): string | undefined {
  const field = text(credentials.database);
  if (field) return field;
  if (credentials.configurationType !== 'connectionString') return undefined;
  const rest = CONNECTION_STRING.exec(text(credentials.connectionString))?.groups?.rest ?? '';
  const path = rest.split(/[?#]/)[0].replace(/^\//, '');
  try {
    return decodeURIComponent(path) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Connection string (allow-listed options only) and driver options from a `mongoDb` credential.
 * `maxTimeoutMS` caps the string's server selection and connect timeouts (an object option wins).
 */
export function buildMongoOptions(
  credentials: DataObject,
  maxTimeoutMS?: number,
): { url: string; options: MongoClientOptions } {
  const options: MongoClientOptions = {};
  let url: string;
  let set: Map<string, string[]>;
  if (credentials.configurationType === 'connectionString') {
    url = text(credentials.connectionString);
    if (!url) throw new Error('The connection string is empty');
    set = checkConnectionString(url);
  } else {
    const host = text(credentials.host) || 'localhost';
    if (!net.isIP(host) && !/^[A-Za-z0-9._-]+$/.test(host))
      throw new Error('The host is not a valid host name');
    const port = Number(credentials.port ?? 27017);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('The port must be between 1 and 65535');
    // the password goes to the driver as an option, never into the URL
    url = `mongodb://${bracketHost(host)}:${port}/`;
    set = new Map();
    const user = text(credentials.user);
    if (user) options.auth = { username: user, password: String(credentials.password ?? '') };
  }
  if (credentials.tls === true) {
    options.tls = true;
    // PEM text as driver options: no temp files, nothing read from disk
    for (const name of ['ca', 'cert', 'key', 'passphrase'] as const) {
      const value = typeof credentials[name] === 'string' ? (credentials[name] as string) : '';
      if (value.trim()) options[name] = value;
    }
  }
  // the string's own value wins; object options would override it
  if (!set.has('maxpoolsize')) options.maxPoolSize = 5;
  const timeouts = [
    ['serverselectiontimeoutms', 'serverSelectionTimeoutMS', DEFAULT_SERVER_SELECTION_MS],
    ['connecttimeoutms', 'connectTimeoutMS', DEFAULT_CONNECT_MS],
  ] as const;
  for (const [name, option, fallback] of timeouts) {
    const given = set.get(name);
    if (!given) options[option] = fallback;
    // 0 means no limit to the driver, so it is above any ceiling too
    else if (maxTimeoutMS !== undefined && !given.every((v) => Number(v) > 0 && Number(v) <= maxTimeoutMS)) {
      options[option] = maxTimeoutMS;
    }
  }
  return { url, options };
}

/** The error with the password and the whole connection string removed from its text. */
export function sanitizeMongoError(error: unknown, credentials: DataObject): Error {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    secrets.add(value);
    secrets.add(encodeURIComponent(value));
  };
  const connectionString =
    typeof credentials.connectionString === 'string' ? credentials.connectionString : '';
  add(connectionString.trim());
  add(connectionString);
  const userInfoPassword = CONNECTION_STRING.exec(connectionString.trim())?.groups?.password;
  if (userInfoPassword) {
    add(userInfoPassword);
    try {
      add(decodeURIComponent(userInfoPassword));
    } catch {
      // not percent-encoded: the raw form is already removed
    }
  }
  add(credentials.password);
  add(credentials.passphrase);
  add(credentials.key);
  // longest first, so a secret inside another is not left half removed
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join('[redacted]');
  }
  message = message.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]*/gi, '[connection string]');
  const sanitized = new Error(redactSecrets(message));
  if (error instanceof Error && error.name) sanitized.name = error.name;
  return sanitized;
}

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

/** a client's guard, and the removal of its abort listener */
const guards = new WeakMap<MongoClient, { guard: Guard; detach(): void }>();

/** server selection and connect timeouts of a credential test, whatever the string says */
const TEST_MAX_TIMEOUT_MS = 20_000;

interface OpenOptions {
  extra?: MongoClientOptions;
  /** closes the client and its guard when aborted, also while connecting */
  signal?: AbortSignal;
  maxTimeoutMS?: number;
}

function cancelled(): Error {
  return new Error('The connection was cancelled');
}

/** Opens a client whose every socket goes through a fresh guard; closes both on failure or abort. */
async function openGuardedClient(
  ctx: GuardContext,
  credentials: DataObject,
  { extra = {}, signal, maxTimeoutMS }: OpenOptions = {},
): Promise<MongoClient> {
  let guard: Guard | undefined;
  let client: MongoClient | undefined;
  const onAbort = () => {
    void client?.close().catch(() => {});
    void guard?.close();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const detach = () => signal?.removeEventListener('abort', onAbort);
  try {
    const { url, options } = buildMongoOptions(credentials, maxTimeoutMS);
    guard = await createGuard(ctx);
    if (signal?.aborted) throw cancelled();
    client = new MongoClient(url, {
      ...options,
      ...extra,
      // set after the parsed options, so nothing in the credential can point the driver elsewhere
      proxyHost: '127.0.0.1',
      proxyPort: guard.port,
      proxyUsername: guard.username,
      proxyPassword: guard.password,
    });
    guards.set(client, { guard, detach });
    await client.connect();
    if (signal?.aborted) throw cancelled();
    return client;
  } catch (error) {
    detach();
    const refusal = guard?.refusal();
    await client?.close().catch(() => {});
    await guard?.close();
    throw sanitizeMongoError(signal?.aborted ? cancelled() : (refusal ?? error), credentials);
  }
}

async function closeGuardedClient(client: MongoClient): Promise<void> {
  const entry = guards.get(client);
  entry?.detach();
  try {
    await client.close();
  } finally {
    await entry?.guard.close();
  }
}

/** A guarded MongoDB client for this node in this execution, shared by all items (see `sharedPostgres`). */
export async function sharedMongo(
  ctx: ConnectionContext & Pick<BaseContext, 'signal'>,
  itemIndex: number,
  credentialType = 'mongoDb',
): Promise<Shared<MongoHandle>> {
  const credentials = await ctx.getCredentials(credentialType, itemIndex);
  let built: ReturnType<typeof buildMongoOptions>;
  try {
    built = buildMongoOptions(credentials);
  } catch (error) {
    throw sanitizeMongoError(error, credentials);
  }
  const databaseName = credentialDatabase(credentials);
  return acquireShared<MongoHandle>(
    sharedKey(ctx, 'mongo', credentialType, built.url, built.options, databaseName),
    // the execution's abort closes the client, also while it connects
    async () => ({ client: await openGuardedClient(ctx, credentials, { signal: ctx.signal }), databaseName }),
    (handle) => closeGuardedClient(handle.client),
  );
}

/** Credential test of `mongoDb` (named by `testedBy` on the MongoDB nodes). */
export async function mongoDbConnectionTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let client: MongoClient | undefined;
  try {
    // the runner's abort closes the client and its guard, also while connecting
    client = await openGuardedClient(ctx, credential.data, {
      extra: { maxPoolSize: 1 },
      signal: ctx.signal,
      maxTimeoutMS: TEST_MAX_TIMEOUT_MS,
    });
    await client.db(credentialDatabase(credential.data) ?? 'admin').command({ ping: 1 });
    return { status: 'OK', message: 'Connection successful' };
  } catch (error) {
    return {
      status: 'Error',
      message: `Couldn't connect to MongoDB: ${sanitizeMongoError(error, credential.data).message}`,
    };
  } finally {
    if (client) await closeGuardedClient(client).catch(() => {});
  }
}
