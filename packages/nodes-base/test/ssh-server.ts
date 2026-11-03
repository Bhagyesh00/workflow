/**
 * In-process SSH server on 127.0.0.1 for the SSH and SFTP node tests (ssh2's own Server, no outbound
 * network). Password and public key sign-in, scripted `exec` answers, and an in-memory SFTP subsystem
 * (open, read, write, stat, readdir, remove, rename, mkdir, rmdir, realpath) over one shared file tree.
 */
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import ssh2, { type Attributes, type Connection, type ParsedKey, type SFTPWrapper } from 'ssh2';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

export type MemoryEntry = { type: 'dir'; mtime: number } | { type: 'file'; data: Buffer; mtime: number };

export interface ExecResult {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number;
  signal?: string;
}

export interface SshServerOptions {
  username?: string;
  password?: string;
  /** OpenSSH public key text that may sign in */
  publicKey?: string;
  /** answer for an exec request; the default runs `echo $HOME` and returns empty output otherwise */
  exec?: (command: string) => ExecResult | Promise<ExecResult>;
  home?: string;
  /** require the key AND the password (the key first, answered with partial success) */
  requireKeyAndPassword?: boolean;
}

export interface SshServer {
  port: number;
  /** the in-memory file tree, keyed by absolute POSIX path ('/' always exists) */
  files: Map<string, MemoryEntry>;
  /** every exec command as received */
  commands: string[];
  /** TCP connections accepted */
  connections: number;
  close: () => Promise<void>;
}

/** a fixed time (2024-01-02T03:04:05Z) so list output can be compared exactly */
export const FIXED_MTIME = Date.UTC(2024, 0, 2, 3, 4, 5) / 1000;

const hostKey = utils.generateKeyPairSync('ed25519').private;

export function addFile(files: Map<string, MemoryEntry>, filePath: string, data: string | Buffer) {
  files.set(filePath, { type: 'file', data: Buffer.from(data), mtime: FIXED_MTIME });
}

export function addDir(files: Map<string, MemoryEntry>, dirPath: string) {
  files.set(dirPath, { type: 'dir', mtime: FIXED_MTIME });
}

function attrsOf(entry: MemoryEntry): Attributes {
  const isDir = entry.type === 'dir';
  return {
    mode: (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644) >>> 0,
    uid: 1000,
    gid: 1000,
    size: isDir ? 4096 : entry.data.length,
    atime: entry.mtime,
    mtime: entry.mtime,
  };
}

function longnameOf(name: string, entry: MemoryEntry): string {
  const rights = entry.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--';
  const size = entry.type === 'dir' ? 4096 : entry.data.length;
  return `${rights} 1 test test ${size} Jan 02 03:04 ${name}`;
}

function childrenOf(files: Map<string, MemoryEntry>, dir: string): string[] {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  return [...files.keys()].filter(
    (key) => key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'),
  );
}

function serveSftp(sftp: SFTPWrapper, files: Map<string, MemoryEntry>, home: string) {
  const handles = new Map<number, { path: string; dir?: boolean; listed?: boolean; write?: Buffer[] }>();
  let nextHandle = 1;
  const resolve = (p: string) => path.posix.resolve(home, p || '.');
  const newHandle = (state: { path: string; dir?: boolean; write?: Buffer[] }) => {
    const id = nextHandle++;
    handles.set(id, state);
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id, 0);
    return handle;
  };
  const stateOf = (handle: Buffer) => (handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined);

  sftp.on('REALPATH', (reqId: number, p: string) => {
    const full = resolve(p);
    sftp.name(reqId, [{ filename: full, longname: full, attrs: {} as Attributes }]);
  });
  const stat = (reqId: number, p: string) => {
    const entry = files.get(resolve(p));
    if (!entry) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    sftp.attrs(reqId, attrsOf(entry));
  };
  sftp.on('STAT', stat);
  sftp.on('LSTAT', stat);
  sftp.on('FSTAT', (reqId: number, handle: Buffer) => {
    const state = stateOf(handle);
    const entry = state && files.get(state.path);
    if (!entry) return sftp.status(reqId, STATUS_CODE.FAILURE);
    sftp.attrs(reqId, attrsOf(entry));
  });
  sftp.on('SETSTAT', (reqId: number) => sftp.status(reqId, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqId: number) => sftp.status(reqId, STATUS_CODE.OK));
  sftp.on('OPEN', (reqId: number, filename: string, flags: number) => {
    const full = resolve(filename);
    const parent = files.get(path.posix.dirname(full));
    if (parent?.type !== 'dir') return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    const existing = files.get(full);
    if (flags & OPEN_MODE.WRITE) {
      if (existing?.type === 'dir') return sftp.status(reqId, STATUS_CODE.FAILURE);
      if (!existing || flags & OPEN_MODE.TRUNC) addFile(files, full, Buffer.alloc(0));
      return sftp.handle(reqId, newHandle({ path: full, write: [] }));
    }
    if (existing?.type !== 'file') return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    sftp.handle(reqId, newHandle({ path: full }));
  });
  sftp.on('READ', (reqId: number, handle: Buffer, offset: number, length: number) => {
    const state = stateOf(handle);
    const entry = state && files.get(state.path);
    if (entry?.type !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE);
    if (offset >= entry.data.length) return sftp.status(reqId, STATUS_CODE.EOF);
    sftp.data(reqId, entry.data.subarray(offset, offset + length));
  });
  sftp.on('WRITE', (reqId: number, handle: Buffer, offset: number, data: Buffer) => {
    const state = stateOf(handle);
    const entry = state && files.get(state.path);
    if (entry?.type !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE);
    const size = Math.max(entry.data.length, offset + data.length);
    const next = Buffer.alloc(size);
    entry.data.copy(next);
    data.copy(next, offset);
    entry.data = next;
    sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('CLOSE', (reqId: number, handle: Buffer) => {
    if (!stateOf(handle)) return sftp.status(reqId, STATUS_CODE.FAILURE);
    handles.delete(handle.readUInt32BE(0));
    sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('OPENDIR', (reqId: number, p: string) => {
    const full = resolve(p);
    const entry = files.get(full);
    if (entry?.type !== 'dir') return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    sftp.handle(reqId, newHandle({ path: full, dir: true }));
  });
  sftp.on('READDIR', (reqId: number, handle: Buffer) => {
    const state = stateOf(handle);
    if (!state?.dir) return sftp.status(reqId, STATUS_CODE.FAILURE);
    if (state.listed) return sftp.status(reqId, STATUS_CODE.EOF);
    state.listed = true;
    const names = childrenOf(files, state.path).map((key) => {
      const entry = files.get(key) as MemoryEntry;
      const name = path.posix.basename(key);
      return { filename: name, longname: longnameOf(name, entry), attrs: attrsOf(entry) };
    });
    if (!names.length) return sftp.status(reqId, STATUS_CODE.EOF);
    sftp.name(reqId, names);
  });
  sftp.on('REMOVE', (reqId: number, p: string) => {
    const full = resolve(p);
    if (files.get(full)?.type !== 'file') return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    files.delete(full);
    sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('MKDIR', (reqId: number, p: string) => {
    const full = resolve(p);
    if (files.has(full)) return sftp.status(reqId, STATUS_CODE.FAILURE);
    if (files.get(path.posix.dirname(full))?.type !== 'dir')
      return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    addDir(files, full);
    sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('RMDIR', (reqId: number, p: string) => {
    const full = resolve(p);
    if (files.get(full)?.type !== 'dir') return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    if (childrenOf(files, full).length) return sftp.status(reqId, STATUS_CODE.FAILURE);
    files.delete(full);
    sftp.status(reqId, STATUS_CODE.OK);
  });
  sftp.on('RENAME', (reqId: number, from: string, to: string) => {
    const source = resolve(from);
    const target = resolve(to);
    if (!files.has(source)) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    if (files.get(path.posix.dirname(target))?.type !== 'dir')
      return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE);
    if (files.has(target)) return sftp.status(reqId, STATUS_CODE.FAILURE);
    for (const key of [...files.keys()]) {
      if (key === source || key.startsWith(`${source}/`)) {
        files.set(target + key.slice(source.length), files.get(key) as MemoryEntry);
        files.delete(key);
      }
    }
    sftp.status(reqId, STATUS_CODE.OK);
  });
}

function keyMatches(allowed: ParsedKey, key: { algo: string; data: Buffer }) {
  return key.algo === allowed.type && key.data.equals(allowed.getPublicSSH());
}

export async function startSshServer(options: SshServerOptions = {}): Promise<SshServer> {
  const username = options.username ?? 'tester';
  const home = options.home ?? '/home/tester';
  const files = new Map<string, MemoryEntry>();
  addDir(files, '/');
  addDir(files, '/home');
  addDir(files, home);
  const commands: string[] = [];
  const clients = new Set<Connection>();
  const allowedKey = options.publicKey ? utils.parseKey(options.publicKey) : undefined;
  if (allowedKey instanceof Error) throw allowedKey;
  const state = { connections: 0 };

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    let keyDone = false;
    client.on('authentication', (ctx) => {
      if (ctx.username !== username) return ctx.reject();
      const both = options.requireKeyAndPassword === true;
      if (ctx.method === 'password' && options.password !== undefined && ctx.password === options.password) {
        if (!both || keyDone) return ctx.accept();
      }
      if (ctx.method === 'publickey' && allowedKey && keyMatches(allowedKey, ctx.key)) {
        if (!ctx.signature) return ctx.accept();
        if (ctx.blob && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
          if (!both) return ctx.accept();
          keyDone = true;
          return ctx.reject(['password'], true);
        }
      }
      ctx.reject(both && keyDone ? ['password'] : ['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', async (accept, _reject, info) => {
          const stream = accept();
          commands.push(info.command);
          const home_ = /;\s*echo \$HOME$/.test(info.command) || info.command === 'echo $HOME';
          const result: ExecResult = home_
            ? { stdout: `${home}\n`, code: 0 }
            : await (options.exec?.(info.command) ?? { code: 0 });
          if (result.stdout) stream.write(result.stdout);
          if (result.stderr) stream.stderr.write(result.stderr);
          if (result.signal) stream.exit(result.signal, false, '');
          else stream.exit(result.code ?? 0);
          stream.end();
        });
        session.on('sftp', (accept) => serveSftp(accept(), files, home));
      });
    });
  });
  // an outer TCP server counts raw connections (before any SSH handshake) and hands them to ssh2
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    server.injectSocket(socket);
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const { port } = tcp.address() as AddressInfo;
  return {
    port,
    files,
    commands,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        for (const socket of sockets) socket.destroy();
        tcp.close(() => resolve());
      }),
  };
}
