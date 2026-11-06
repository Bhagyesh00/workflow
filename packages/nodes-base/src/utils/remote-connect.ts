/**
 * Raw TCP connections for the SSH, SFTP and FTP nodes. They are not HTTP, so the host goes through
 * the SSRF guard with `resolveAllowedHost` (resolved and checked once) and the socket connects only to
 * those checked addresses through the pinned `lookup`: a name that rebinds after the check cannot send
 * the connection elsewhere. Also the size caps that keep a remote file or command output in memory.
 */
import net from 'node:net';
import type { Readable } from 'node:stream';
import type { BaseContext, DataObject, ExecuteContext, ResolvedAddress } from '@workflow/workflow';
import type { AuthenticationType } from 'ssh2';
import { formatPemBlock } from './pem';

/** the port as a number between 1 and 65535, or the protocol's default when empty */
export function remotePort(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Port "${String(value)}" is not valid`);
  return port;
}

/** the host from a credential, trimmed; an empty host is an error */
export function remoteHost(value: unknown, credentialName: string): string {
  const host = String(value ?? '').trim();
  if (!host) throw new Error(`The ${credentialName} credential has no host`);
  return host;
}

/**
 * Check `host` against the SSRF policy and return its checked addresses (IP literals). For clients
 * that open their own sockets (basic-ftp): connect to these literals, never to the name.
 */
export async function checkedAddresses(ctx: ExecuteContext, host: string): Promise<ResolvedAddress[]> {
  return (await ctx.helpers.resolveAllowedHost(host)).addresses;
}

/**
 * Open a TCP connection to `host:port` through the SSRF guard. Resolves once the socket is connected;
 * the socket is destroyed when the execution is cancelled. Callers hand it to ssh2 as `sock`.
 */
export async function connectSocket(
  ctx: Pick<BaseContext, 'helpers'> & { signal?: AbortSignal },
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const allowed = await ctx.helpers.resolveAllowedHost(host);
  const signal = ctx.signal;
  if (signal?.aborted) throw new Error('The execution was cancelled');
  const socket = net.connect({
    host,
    port,
    lookup: allowed.lookup,
    autoSelectFamily: true,
  });
  const onAbort = () => socket.destroy(new Error('The execution was cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.once('close', () => signal?.removeEventListener('abort', onAbort));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out connecting to ${host}:${port}`)),
        Math.max(1, timeoutMs),
      );
      const done = (error?: Error) => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onConnect = () => done();
      const onError = (error: Error) =>
        done(new Error(`Couldn't connect to ${host}:${port}: ${error.message}`));
      const onClose = () => done(new Error(`Couldn't connect to ${host}:${port}: the connection closed`));
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return socket;
}

/** "100 MB" for whole megabytes, otherwise "1000 bytes" */
export function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${bytes} bytes`;
}

export class RemoteSizeError extends Error {}

/** the error for a remote file above the instance limit */
export function fileTooLarge(remotePath: string, maxBytes: number): RemoteSizeError {
  return new RemoteSizeError(
    `The file "${remotePath}" is larger than the limit of ${formatLimit(maxBytes)} (NODE_REMOTE_FILE_MAX_MB)`,
  );
}

/**
 * Collects bytes up to `maxBytes`. `push` returns false (and the collector is over) once the total
 * would pass the cap, so the caller can stop the transfer at once.
 */
export class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  over = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer | string): boolean {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.total += bytes.length;
    if (this.total > this.maxBytes) {
      this.over = true;
      this.chunks.length = 0;
      return false;
    }
    this.chunks.push(bytes);
    return true;
  }

  get size(): number {
    return this.total;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** read a whole stream into memory, destroying it as soon as it passes `maxBytes` */
export function readCapped(stream: Readable, maxBytes: number, tooLarge: () => Error): Promise<Buffer> {
  const buffer = new CappedBuffer(maxBytes);
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(buffer.toBuffer());
    };
    stream.on('data', (chunk: Buffer) => {
      if (!buffer.push(chunk)) {
        finish(tooLarge());
        stream.destroy();
      }
    });
    stream.once('end', () => finish());
    stream.once('error', (error: Error) => finish(error));
    // a stream closed without 'end' lost its connection: never hand back a cut-off file
    stream.once('close', () => finish(new Error('The transfer stopped before the end of the file')));
  });
}

export interface SshAuthConfig {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** ssh2's order of sign-in methods; set when a key and a password are both sent */
  authHandler?: AuthenticationType[];
}

/**
 * The ssh2 sign-in fields from an SSH or SFTP credential: the private key (re-wrapped by
 * formatPemBlock, so a key pasted on one line works) when one is set, else the password. The
 * passphrase is added only when set. `includePassword` (the SFTP credential, as n8n) also sends a
 * non-empty password with the key, so ssh2 can fall back to it or answer a key-plus-password server.
 */
export function sshAuthConfig(
  creds: DataObject,
  usePrivateKey: boolean,
  includePassword = false,
): SshAuthConfig {
  const config: SshAuthConfig = { username: String(creds.username ?? '') };
  const privateKey = String(creds.privateKey ?? '').trim();
  if (usePrivateKey && privateKey) {
    config.privateKey = formatPemBlock(privateKey);
    if (creds.passphrase) config.passphrase = String(creds.passphrase);
    if (includePassword && creds.password) {
      config.password = String(creds.password);
      // the key first: then a server that wants key plus password gets both (ssh2 tries password first)
      config.authHandler = ['none', 'publickey', 'password'];
    }
  } else {
    config.password = String(creds.password ?? '');
  }
  return config;
}

/** quote a value for a POSIX shell: 'it'\''s' */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** the last part of a remote path ('a/b/c.txt' -> 'c.txt') */
export function remoteBaseName(remotePath: string): string {
  return remotePath.split(/[\\/]/).filter(Boolean).pop() ?? '';
}
