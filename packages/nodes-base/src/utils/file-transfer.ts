/**
 * FTP and SFTP back ends of the FTP node behind one small interface. Both go through the SSRF guard:
 * - FTP (basic-ftp): the host is resolved and checked once and basic-ftp connects to the checked IP
 *   literal (never the name), trying the next checked address when one refuses. Data connections use
 *   basic-ftp's default passive mode, which dials only the control connection's IP: EPSV gives just a
 *   port, and a PASV reply that names another host is refused. `allowSeparateTransferHost` is never set.
 * - SFTP (ssh2-sftp-client): ssh2 gets a socket already connected to the checked address (`sock`).
 * Downloads stay in memory, capped by the instance remote file limit. As in n8n, plain FTP has no TLS
 * and the SFTP server's host key is not checked.
 */
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { DataObject, ExecuteContext } from '@workflow/workflow';
import { type FileInfo, FileType, FTPError, Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import {
  CappedBuffer,
  checkedAddresses,
  connectSocket,
  fileTooLarge,
  readCapped,
  remoteHost,
  remotePort,
  sshAuthConfig,
} from './remote-connect';

/** one list entry, in the shape of n8n's FTP node (version 1.1: dates as ISO strings) */
export interface RemoteEntry extends DataObject {
  type: string;
  name: string;
  size: number;
  modifyTime: string | null;
  rights: { user: string; group: string; other: string };
  path: string;
}

export interface RemoveOptions {
  folder: boolean;
  recursive: boolean;
}

export interface FileTransfer {
  list(dir: string, recursive: boolean): Promise<RemoteEntry[]>;
  download(remotePath: string): Promise<Buffer>;
  upload(remotePath: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string, createDirectories: boolean): Promise<void>;
  remove(remotePath: string, options: RemoveOptions): Promise<void>;
  close(): Promise<void>;
}

/** a path with CR or LF could smuggle a second FTP command; refuse it on both protocols */
export function assertSafePath(remotePath: string): string {
  if (/[\r\n\0]/.test(remotePath)) throw new Error('The path must not contain line breaks');
  return remotePath;
}

/** a recursive list stops with an error past this many entries or this many folder levels */
export const MAX_LIST_ENTRIES = 100_000;
export const MAX_LIST_DEPTH = 50;

/**
 * Recursive list as n8n does it: breadth-first, folders included, '.' and '..' skipped. Bounded: a
 * server can show a looping symlink as a folder or invent an endless tree, so the walk stops with an
 * error past MAX_LIST_ENTRIES entries or MAX_LIST_DEPTH levels, never lists a folder twice, and
 * checks for a stopped run before each LIST.
 */
async function listRecursive<T>(
  signal: AbortSignal,
  dir: string,
  listOnce: (dir: string) => Promise<T[]>,
  describe: (info: T) => { name: string; isDirectory: boolean },
  toEntry: (info: T, fullPath: string) => RemoteEntry,
): Promise<RemoteEntry[]> {
  const out: RemoteEntry[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
  const queued = new Set([dir]);
  for (let index = 0; index < queue.length; index++) {
    if (signal.aborted) throw new Error('The list was stopped because the run was cancelled');
    const current = queue[index];
    for (const info of await listOnce(current.path)) {
      const { name, isDirectory } = describe(info);
      if (name === '.' || name === '..') continue;
      const full = joinPath(current.path, name);
      out.push(toEntry(info, full));
      if (out.length > MAX_LIST_ENTRIES) {
        throw new Error(
          `The folder has more than ${MAX_LIST_ENTRIES} entries in its sub folders: list a smaller folder or turn off Recursive`,
        );
      }
      if (!isDirectory || queued.has(full)) continue;
      if (current.depth + 1 > MAX_LIST_DEPTH) {
        throw new Error(
          `The folder has sub folders more than ${MAX_LIST_DEPTH} levels deep (a folder link may loop): list a smaller folder or turn off Recursive`,
        );
      }
      queued.add(full);
      queue.push({ path: full, depth: current.depth + 1 });
    }
  }
  return out;
}

/** `dir` + `name` without a double slash */
function joinPath(dir: string, name: string): string {
  return `${dir}${dir.endsWith('/') ? '' : '/'}${name}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The ISO date of a LIST line's raw date (read as UTC, the listing carries no zone): "Jan 02 2024",
 * "Oct 30 12:34" (this year, or last year when that would be in the future, as `ls` prints it) and
 * the DOS form "04-27-24 09:15PM". Null when the form is unknown.
 */
export function parseFtpListDate(raw: string, now = new Date()): string | null {
  const text = raw.trim();
  const unix = /^([A-Za-z]{3})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/.exec(text);
  if (unix) {
    const month = MONTHS.indexOf(unix[1].toLowerCase());
    if (month < 0) return null;
    const day = Number(unix[2]);
    if (unix[3]) return new Date(Date.UTC(Number(unix[3]), month, day)).toISOString();
    const hour = Number(unix[4]);
    const minute = Number(unix[5]);
    let date = Date.UTC(now.getUTCFullYear(), month, day, hour, minute);
    if (date > now.getTime() + 24 * 3600 * 1000)
      date = Date.UTC(now.getUTCFullYear() - 1, month, day, hour, minute);
    return new Date(date).toISOString();
  }
  const dos = /^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/.exec(text);
  if (dos) {
    let year = Number(dos[3]);
    if (dos[3].length === 2) year += year < 70 ? 2000 : 1900;
    let hour = Number(dos[4]);
    const meridiem = dos[6]?.toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    return new Date(Date.UTC(year, Number(dos[1]) - 1, Number(dos[2]), hour, Number(dos[5]))).toISOString();
  }
  return null;
}

/** basic-ftp's numeric permission bits as n8n's rights strings ('rwx', 'rx', ...) */
function rightsOf(bits: number | undefined): string {
  if (bits === undefined) return '';
  return `${bits & 4 ? 'r' : ''}${bits & 2 ? 'w' : ''}${bits & 1 ? 'x' : ''}`;
}

function ftpEntry(info: FileInfo, fullPath: string): RemoteEntry {
  const type = info.type === FileType.Directory ? 'd' : info.type === FileType.SymbolicLink ? 'l' : '-';
  const entry: RemoteEntry = {
    type,
    name: info.name,
    size: info.size,
    modifyTime: info.modifiedAt ? info.modifiedAt.toISOString() : parseFtpListDate(info.rawModifiedAt),
    rights: {
      user: rightsOf(info.permissions?.user),
      group: rightsOf(info.permissions?.group),
      other: rightsOf(info.permissions?.world),
    },
    owner: info.user ?? '',
    group: info.group ?? '',
    path: fullPath,
  };
  if (info.link) entry.target = info.link;
  return entry;
}

/** basic-ftp's per-task and data timeout; the node's Timeout option bounds only the sign-in, as in n8n */
export const FTP_TASK_TIMEOUT_MS = 60_000;

/** a basic-ftp client; the separate-transfer-host option keeps its safe default (false) */
export function createFtpClient(timeoutMs: number): FtpClient {
  return new FtpClient(timeoutMs);
}

function replyCode(error: unknown): number | undefined {
  return error instanceof FTPError ? Number(error.code) : undefined;
}

/** a Writable that keeps at most `maxBytes` in memory and fails above that */
class CappedWritable extends Writable {
  readonly buffer: CappedBuffer;
  overflowed = false;

  constructor(
    maxBytes: number,
    private readonly tooLarge: () => Error,
  ) {
    super();
    this.buffer = new CappedBuffer(maxBytes);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.buffer.push(chunk)) return callback(null);
    this.overflowed = true;
    callback(this.tooLarge());
  }
}

export async function openFtp(
  ctx: ExecuteContext,
  creds: DataObject,
  timeoutMs: number,
): Promise<FileTransfer> {
  const host = remoteHost(creds.host, 'FTP');
  const port = remotePort(creds.port, 21);
  const addresses = await checkedAddresses(ctx, host);
  const maxBytes = ctx.helpers.getInstanceLimits().maxRemoteFileBytes;
  // a slow reply after sign-in (a late 226 after a big upload, a large LIST) must not cut the
  // connection after the short connect timeout
  const client = createFtpClient(Math.max(timeoutMs, FTP_TASK_TIMEOUT_MS));
  const onAbort = () => client.close();
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  /** sign in to one checked address, bounded by the node's Timeout option */
  const signIn = async (address: (typeof addresses)[number]) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      client.close();
    }, timeoutMs);
    try {
      client.ftp.ipFamily = address.family;
      // the IP literal never reaches DNS again, so a rebind after the check cannot redirect us
      await client.access({
        host: address.address,
        port,
        user: creds.username ? String(creds.username) : undefined,
        password: creds.username ? String(creds.password ?? '') : undefined,
      });
    } catch (error) {
      if (timedOut) throw new Error(`The FTP server did not answer within ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  let connectedTo: (typeof addresses)[number] | undefined;
  let lastError: unknown;
  for (const address of addresses) {
    try {
      await signIn(address);
      connectedTo = address;
      break;
    } catch (error) {
      lastError = error;
      // the server answered (wrong password, ...): another address of the same host would not help
      if (replyCode(error) !== undefined) break;
    }
  }
  if (!connectedTo) {
    ctx.signal.removeEventListener('abort', onAbort);
    client.close();
    throw lastError;
  }
  const home = await client.pwd();
  const signedInTo = connectedTo;

  /** basic-ftp closes the whole connection when a download's sink fails: sign in again for the next item */
  const reconnect = async () => {
    if (!client.closed || ctx.signal.aborted) return;
    await signIn(signedInTo);
    await client.cd(home);
  };

  /** mkdir -p, then back to the folder we started in (ensureDir changes it) */
  const makeDirs = async (dir: string) => {
    if (!dir || dir === '.' || dir === '/') return;
    try {
      await client.ensureDir(dir);
    } finally {
      await client.cd(home);
    }
  };

  const listOnce = async (dir: string) => client.list(assertSafePath(dir));

  return {
    async list(dir, recursive) {
      if (!recursive) return (await listOnce(dir)).map((info) => ftpEntry(info, joinPath(dir, info.name)));
      return listRecursive(
        ctx.signal,
        dir,
        listOnce,
        (info) => ({ name: info.name, isDirectory: info.isDirectory }),
        ftpEntry,
      );
    },

    async download(remotePath) {
      assertSafePath(remotePath);
      // refuse early by SIZE when the server reports it; the transfer itself is capped as well
      const size = await client.size(remotePath).catch(() => undefined);
      if (size !== undefined && size > maxBytes) throw fileTooLarge(remotePath, maxBytes);
      const sink = new CappedWritable(maxBytes, () => fileTooLarge(remotePath, maxBytes));
      try {
        await client.downloadTo(sink, remotePath);
      } catch (error) {
        // over the cap mid-transfer (no SIZE, or a SIZE that under-reports): the connection is gone
        if (sink.overflowed) await reconnect().catch(() => undefined);
        throw error;
      }
      return sink.buffer.toBuffer();
    },

    async upload(remotePath, data) {
      assertSafePath(remotePath);
      const send = () => client.uploadFrom(Readable.from([Buffer.from(data)]), remotePath);
      try {
        await send();
      } catch (error) {
        // as n8n: 553 (cannot create the file) means a missing folder; create it and try once more
        if (replyCode(error) !== 553) throw error;
        await makeDirs(path.posix.dirname(remotePath));
        await send();
      }
    },

    async rename(from, to, createDirectories) {
      assertSafePath(from);
      assertSafePath(to);
      try {
        await client.rename(from, to);
      } catch (error) {
        // as n8n: 451 / 550 with Create Directories on means a missing target folder
        const code = replyCode(error);
        if (!createDirectories || (code !== 451 && code !== 550)) throw error;
        await makeDirs(path.posix.dirname(to));
        await client.rename(from, to);
      }
    },

    async remove(remotePath, { folder, recursive }) {
      assertSafePath(remotePath);
      if (!folder) await client.remove(remotePath);
      else if (recursive) await client.removeDir(remotePath);
      else await client.removeEmptyDir(remotePath);
    },

    async close() {
      ctx.signal.removeEventListener('abort', onAbort);
      client.close();
    },
  };
}

interface SftpListEntry {
  type: string;
  name: string;
  size: number;
  modifyTime: number;
  accessTime: number;
  rights: { user: string; group: string; other: string };
  owner: number;
  group: number;
}

function sftpEntry(info: SftpListEntry, fullPath: string): RemoteEntry {
  return {
    type: info.type,
    name: info.name,
    size: info.size,
    modifyTime: new Date(info.modifyTime).toISOString(),
    accessTime: new Date(info.accessTime).toISOString(),
    rights: { ...info.rights },
    owner: info.owner,
    group: info.group,
    path: fullPath,
  };
}

export async function openSftp(
  ctx: ExecuteContext,
  creds: DataObject,
  timeoutMs: number,
): Promise<FileTransfer> {
  const host = remoteHost(creds.host, 'SFTP');
  const port = remotePort(creds.port, 22);
  const maxBytes = ctx.helpers.getInstanceLimits().maxRemoteFileBytes;
  const sock = await connectSocket(ctx, host, port, timeoutMs);
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      sock,
      readyTimeout: timeoutMs,
      // as n8n: the password goes along with the key (a key refused, or key plus password)
      ...sshAuthConfig(creds, true, true),
      // as n8n
      algorithms: { compress: ['zlib@openssh.com', 'zlib', 'none'] },
    });
  } catch (error) {
    sock.destroy();
    await sftp.end().catch(() => undefined);
    throw error;
  }

  /** as n8n: create the parent folder (recursively) when it is missing */
  const ensureParent = async (remotePath: string) => {
    const dir = path.posix.dirname(remotePath);
    if (!dir || dir === '.' || dir === '/') return;
    if (!(await sftp.exists(dir))) await sftp.mkdir(dir, true);
  };

  const listOnce = async (dir: string) =>
    (await sftp.list(assertSafePath(dir))) as unknown as SftpListEntry[];

  return {
    async list(dir, recursive) {
      if (!recursive) return (await listOnce(dir)).map((info) => sftpEntry(info, joinPath(dir, info.name)));
      return listRecursive(
        ctx.signal,
        dir,
        listOnce,
        (info) => ({ name: info.name, isDirectory: info.type === 'd' }),
        sftpEntry,
      );
    },

    async download(remotePath) {
      assertSafePath(remotePath);
      const stats = await sftp.stat(remotePath);
      if (stats.size > maxBytes) throw fileTooLarge(remotePath, maxBytes);
      // the stat size is only a hint: the read is capped as well
      return readCapped(sftp.createReadStream(remotePath) as unknown as Readable, maxBytes, () =>
        fileTooLarge(remotePath, maxBytes),
      );
    },

    async upload(remotePath, data) {
      assertSafePath(remotePath);
      await ensureParent(remotePath);
      await sftp.put(Buffer.from(data), remotePath);
    },

    async rename(from, to, createDirectories) {
      assertSafePath(from);
      assertSafePath(to);
      if (createDirectories) await ensureParent(to);
      await sftp.rename(from, to);
    },

    async remove(remotePath, { folder, recursive }) {
      assertSafePath(remotePath);
      if (folder) await sftp.rmdir(remotePath, recursive);
      else await sftp.delete(remotePath);
    },

    async close() {
      await sftp.end().catch(() => undefined);
      sock.destroy();
    },
  };
}
