/**
 * P6-72 (L1): the SSH adapter behind isomorphic-git's HTTP plugin interface. GET `info/refs?service=X` maps to an
 * ssh2 `exec` of `X '<path>'` (path quoted, no other command); POST writes the body to the same channel. The
 * socket comes from `ctx.http.resolveAllowedHost` with its pinned `lookup` (handed to ssh2 as `sock`);
 * `hostVerifier` keeps the first SHA256 fingerprint through `onFirstSeen` and refuses a changed one with
 * `GitHostKeyChangedError`. Connect timeout 30 s. Keys stay in memory.
 *
 * Over SSH the Git services speak the stateful protocol: the advertisement comes first on the channel, then the
 * client's request, then the answer. isomorphic-git speaks Smart HTTP (stateless), so the adapter reads the
 * advertisement up to its flush packet for the GET (adding the `# service=` header HTTP has), keeps the channel
 * open, and for the POST writes the whole request to it and streams the answer until the channel closes.
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import type { HttpClient } from '@workflow/core';
import { Client, type ClientChannel } from 'ssh2';
import { GitAuthError, GitHostKeyChangedError, GitLimitError, GitRemoteError } from './git-repo';
import type { GitHttpPlugin } from './transport-http';
import type { ParsedRemote } from './url';

/** the host key memory of one connection: the stored fingerprint, or null before the first connect */
export interface HostKeyCheck {
  fingerprint: string | null;
  /** called once with the SHA256 fingerprint when none was stored (accept-new) */
  onFirstSeen(fingerprint: string): Promise<void>;
}

/** the plugin plus `close()`, which ends any open channel and the connection */
export interface GitSshPlugin extends GitHttpPlugin {
  close(): Promise<void>;
}

type GitService = 'git-upload-pack' | 'git-receive-pack';
type PluginRequest = Parameters<GitHttpPlugin['request']>[0];
type PluginResponse = Awaited<ReturnType<GitHttpPlugin['request']>>;

export const SSH_CONNECT_TIMEOUT_MS = 30_000;
/** the same cap the guarded HTTP client puts on one response (100 MiB) */
export const SSH_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
/** an advertisement larger than this is refused (a repository with a huge number of refs) */
const MAX_ADVERTISEMENT_BYTES = 16 * 1024 * 1024;

/** OpenSSH's `SHA256:<base64, no padding>` fingerprint of a raw public host key */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** one pkt-line, as Smart HTTP frames the service header */
function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}

const FLUSH = Buffer.from('0000', 'ascii');

/** the end offset (after the flush packet) of a complete pkt-line advertisement in `buf`, or -1 */
function advertisementEnd(buf: Buffer): number {
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const size = Number.parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(size) || Number.isNaN(size))
      throw new GitRemoteError('The Git server sent a bad answer.');
    if (size === 0) return offset + 4;
    if (size < 4) throw new GitRemoteError('The Git server sent a bad answer.');
    if (offset + size > buf.length) return -1;
    offset += size;
  }
  return -1;
}

/** reads a channel's stdout chunk by chunk, with a byte cap over the channel's whole life */
class ChannelReader {
  private readonly chunks: Buffer[] = [];
  private ended = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private total = 0;
  exitCode: number | null = null;
  stderr = '';

  constructor(readonly channel: ClientChannel) {
    channel.on('data', (chunk: Buffer) => {
      this.total += chunk.length;
      if (this.total > SSH_MAX_RESPONSE_BYTES) {
        this.fail(new GitLimitError('The Git server sent more than the size limit allows.'));
        channel.destroy();
        return;
      }
      this.chunks.push(chunk);
      this.notify();
    });
    channel.stderr.on('data', (chunk: Buffer) => {
      // kept short, for the log reason only; never sent to a client
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2000);
    });
    channel.on('exit', (code: number | null) => {
      this.exitCode = typeof code === 'number' ? code : null;
    });
    channel.on('close', () => {
      this.ended = true;
      this.notify();
    });
    channel.on('error', (error: Error) => this.fail(error));
  }

  private notify() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.ended = true;
    this.notify();
  }

  /** the next chunk, or null once the channel closed */
  async read(): Promise<Buffer | null> {
    for (;;) {
      if (this.failure) throw this.failure;
      const next = this.chunks.shift();
      if (next) return next;
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  unshift(chunk: Buffer) {
    if (chunk.length) this.chunks.unshift(chunk);
  }
}

interface OpenService {
  service: GitService;
  reader: ChannelReader;
}

/** builds the adapter; nothing connects until isomorphic-git sends its first request */
export function gitSshTransport(
  http: HttpClient,
  remote: ParsedRemote,
  key: { privateKey: string },
  hostKey: HostKeyCheck,
): GitSshPlugin {
  if (remote.kind !== 'ssh') throw new GitRemoteError('The SSH transport needs an SSH repository URL.');
  let connection: Promise<Client> | undefined;
  let client: { ssh: Client; closed: boolean } | undefined;
  const open = new Set<OpenService>();
  const pending = new Map<GitService, OpenService>();

  const connect = (): Promise<Client> => {
    connection ??= (async () => {
      // throws SsrfBlockedError for a host the policy refuses, before any socket opens
      const allowed = await http.resolveAllowedHost(remote.host);
      const sock = net.connect({ host: remote.host, port: remote.port, lookup: allowed.lookup });
      const ssh = new Client();
      const current = { ssh, closed: false };
      client = current;
      ssh.on('close', () => {
        current.closed = true;
      });
      let hostKeyChanged = false;
      return await new Promise<Client>((resolve, reject) => {
        const onError = (error: Error & { level?: string }) => {
          sock.destroy();
          if (hostKeyChanged) reject(new GitHostKeyChangedError());
          else if (error.level === 'client-authentication') reject(new GitAuthError());
          else if (error.level === 'client-timeout') {
            reject(new GitRemoteError('The Git server did not answer within 30 seconds.', error));
          } else reject(new GitRemoteError('Could not connect to the Git server over SSH.', error));
        };
        sock.on('error', onError);
        ssh.once('error', onError);
        ssh.once('ready', () => {
          ssh.off('error', onError);
          // later transport errors surface through the channels
          ssh.on('error', () => undefined);
          resolve(ssh);
        });
        ssh.connect({
          sock,
          username: remote.user ?? 'git',
          privateKey: key.privateKey,
          readyTimeout: SSH_CONNECT_TIMEOUT_MS,
          hostVerifier: (raw: Buffer, verify: (valid: boolean) => void) => {
            const fingerprint = hostKeyFingerprint(raw);
            if (hostKey.fingerprint === null) {
              hostKey.onFirstSeen(fingerprint).then(
                () => verify(true),
                () => verify(false),
              );
              return;
            }
            if (hostKey.fingerprint === fingerprint) {
              verify(true);
              return;
            }
            hostKeyChanged = true;
            verify(false);
          },
        });
      });
    })();
    return connection;
  };

  const exec = async (service: GitService): Promise<OpenService> => {
    const ssh = await connect();
    // the only command ever run: one of the two service names and the quoted path (url.ts refuses a quote in it)
    const command = `${service} '${remote.path}'`;
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      ssh.exec(command, (error, stream) => {
        if (error) reject(new GitRemoteError('The Git server refused the repository.', error));
        else resolve(stream);
      });
    });
    const entry: OpenService = { service, reader: new ChannelReader(channel) };
    open.add(entry);
    channel.on('close', () => open.delete(entry));
    return entry;
  };

  /** the advertisement, read up to its flush packet; the channel stays open for the request */
  const readAdvertisement = async (entry: OpenService): Promise<Buffer> => {
    let buf = Buffer.alloc(0);
    for (;;) {
      const end = advertisementEnd(buf);
      if (end >= 0) {
        entry.reader.unshift(buf.subarray(end));
        return buf.subarray(0, end);
      }
      if (buf.length > MAX_ADVERTISEMENT_BYTES) {
        throw new GitLimitError('The Git server sent more than the size limit allows.');
      }
      const chunk = await entry.reader.read();
      if (chunk === null) {
        throw new GitRemoteError(
          'The Git server closed the connection. Check the repository path and the key access.',
          entry.reader.stderr,
        );
      }
      buf = Buffer.concat([buf, chunk]);
    }
  };

  const endService = (entry: OpenService) => {
    open.delete(entry);
    try {
      // a flush tells the service the client wants nothing more
      entry.reader.channel.end(FLUSH);
    } catch {
      /* already closed */
    }
  };

  async function* answer(entry: OpenService): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = await entry.reader.read();
      if (chunk === null) break;
      yield chunk;
    }
    if (entry.reader.exitCode !== null && entry.reader.exitCode !== 0) {
      throw new GitRemoteError('The Git server failed the operation.', entry.reader.stderr);
    }
  }

  async function request({ url, method, body }: PluginRequest): Promise<PluginResponse> {
    const target = new URL(url);
    if ((method ?? 'GET').toUpperCase() === 'GET') {
      const service = target.searchParams.get('service');
      if (
        !target.pathname.endsWith('/info/refs') ||
        (service !== 'git-upload-pack' && service !== 'git-receive-pack')
      ) {
        throw new GitRemoteError('Only the Git upload-pack and receive-pack services are used.');
      }
      const previous = pending.get(service);
      if (previous) endService(previous);
      const entry = await exec(service);
      pending.set(service, entry);
      const advertisement = await readAdvertisement(entry);
      const framed = Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, advertisement]);
      return {
        url,
        method: 'GET',
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'content-type': `application/x-${service}-advertisement` },
        body: (async function* () {
          yield framed;
        })(),
      };
    }

    const service = target.pathname.endsWith('/git-upload-pack')
      ? 'git-upload-pack'
      : target.pathname.endsWith('/git-receive-pack')
        ? 'git-receive-pack'
        : undefined;
    if (!service || (method ?? '').toUpperCase() !== 'POST') {
      throw new GitRemoteError('Only the Git upload-pack and receive-pack services are used.');
    }
    let entry = pending.get(service);
    pending.delete(service);
    if (!entry) {
      entry = await exec(service);
      await readAdvertisement(entry);
    }
    const parts: Buffer[] = [];
    if (body) for await (const chunk of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(chunk));
    const channel = entry.reader.channel;
    channel.write(Buffer.concat(parts));
    channel.end();
    return {
      url,
      method: 'POST',
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': `application/x-${service}-result` },
      body: answer(entry),
    };
  }

  return {
    request,
    async close() {
      pending.clear();
      for (const entry of [...open]) endService(entry);
      const current = client;
      connection = undefined;
      client = undefined;
      if (current && !current.closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref();
          current.ssh.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          current.ssh.end();
        });
      }
    },
  };
}
