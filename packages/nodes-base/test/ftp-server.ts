/**
 * In-process FTP server on node:net (127.0.0.1) for the FTP node tests: USER/PASS, FEAT, PWD, CWD,
 * CDUP, EPSV and PASV (one data listener per transfer), LIST, RETR, STOR, SIZE, DELE, RNFR/RNTO, MKD,
 * RMD and QUIT over an in-memory file tree. Replies follow common servers: STOR into a missing folder
 * is 553, RNTO into a missing folder is 550.
 */
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { addDir, addFile, type MemoryEntry } from './ssh-server';

export interface FtpServerOptions {
  username?: string;
  password?: string;
  /** answer EPSV (default true); false makes the client fall back to PASV */
  epsv?: boolean;
  /** the host the PASV reply names, as four comma-separated numbers (default 127,0,0,1) */
  pasvHost?: string;
  /** answer SIZE (default true); false answers 502, so a download is capped only while streaming */
  size?: boolean;
  /** hold the reply to this command (after sign-in) for `ms` milliseconds */
  delay?: { verb: string; ms: number };
  /** extra `ls -l` lines LIST adds for a folder (for example a folder that lists itself again) */
  extraListing?: (dir: string) => string[];
}

export interface FtpServer {
  port: number;
  files: Map<string, MemoryEntry>;
  /** every command line as received (PASS shows as "PASS ***") */
  commands: string[];
  /** control connections accepted */
  connections: number;
  /** data connections accepted */
  dataConnections: number;
  close: () => Promise<void>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** one `ls -l` line; the date uses the "Mon DD YYYY" form */
function listLine(name: string, entry: MemoryEntry): string {
  const date = new Date(entry.mtime * 1000);
  const when = `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.getUTCFullYear()}`;
  const rights = entry.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--';
  const size = entry.type === 'dir' ? 4096 : entry.data.length;
  return `${rights} 1 owner group ${size} ${when} ${name}`;
}

function childrenOf(files: Map<string, MemoryEntry>, dir: string): string[] {
  const prefix = dir === '/' ? '/' : `${dir}/`;
  return [...files.keys()].filter(
    (key) => key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'),
  );
}

export async function startFtpServer(options: FtpServerOptions = {}): Promise<FtpServer> {
  const username = options.username ?? 'tester';
  const password = options.password ?? 'ftp-pw';
  const files = new Map<string, MemoryEntry>();
  addDir(files, '/');
  const commands: string[] = [];
  const counts = { connections: 0, dataConnections: 0 };
  const open = new Set<net.Socket>();
  const dataServers = new Set<net.Server>();

  const server = net.createServer((socket) => {
    counts.connections++;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => undefined);
    let cwd = '/';
    let user = '';
    let loggedIn = false;
    let renameFrom: string | undefined;
    let data: { server: net.Server; socket: Promise<net.Socket> } | undefined;
    let buffer = '';
    let queue = Promise.resolve();
    const reply = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    const resolvePath = (arg: string) => path.posix.resolve(cwd, arg || '.');

    const openData = async () => {
      if (data) data.server.close();
      const dataServer = net.createServer();
      dataServers.add(dataServer);
      const accepted = new Promise<net.Socket>((resolve) =>
        dataServer.once('connection', (s) => {
          counts.dataConnections++;
          open.add(s);
          s.on('close', () => open.delete(s));
          s.on('error', () => undefined);
          resolve(s);
        }),
      );
      await new Promise<void>((resolve) => dataServer.listen(0, '127.0.0.1', resolve));
      data = { server: dataServer, socket: accepted };
      return (dataServer.address() as AddressInfo).port;
    };

    /** send `payload` over the data connection opened by the last EPSV/PASV */
    const sendData = async (payload: Buffer) => {
      const current = data;
      data = undefined;
      if (!current) return reply('425 Use PASV or EPSV first');
      reply('150 Opening data connection');
      const s = await current.socket;
      await new Promise<void>((resolve) => s.end(payload, () => resolve()));
      current.server.close();
      reply('226 Transfer complete');
    };

    const receiveData = async (): Promise<Buffer | undefined> => {
      const current = data;
      data = undefined;
      if (!current) {
        reply('425 Use PASV or EPSV first');
        return undefined;
      }
      reply('150 Ok to send data');
      const s = await current.socket;
      const chunks: Buffer[] = [];
      for await (const chunk of s) chunks.push(chunk as Buffer);
      current.server.close();
      return Buffer.concat(chunks);
    };

    const handle = async (line: string) => {
      const space = line.indexOf(' ');
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const arg = space < 0 ? '' : line.slice(space + 1);
      commands.push(verb === 'PASS' ? 'PASS ***' : line);
      if (verb === 'USER') {
        user = arg;
        return reply('331 Password required');
      }
      if (verb === 'PASS') {
        loggedIn = user === username && arg === password;
        return reply(loggedIn ? '230 Logged in' : '530 Login incorrect');
      }
      if (verb === 'QUIT') {
        reply('221 Bye');
        return void socket.end();
      }
      if (verb === 'FEAT') return reply('211-Features:\r\n EPSV\r\n PASV\r\n SIZE\r\n UTF8\r\n211 End');
      if (verb === 'OPTS') return reply('200 Ok');
      if (!loggedIn) return reply('530 Please login');
      if (options.delay && verb === options.delay.verb.toUpperCase()) {
        await new Promise((resolve) => setTimeout(resolve, options.delay?.ms));
      }
      const target = resolvePath(arg);
      const entry = files.get(target);
      switch (verb) {
        case 'SYST':
          return reply('215 UNIX Type: L8');
        case 'TYPE':
        case 'STRU':
          return reply('200 Ok');
        case 'PWD':
          return reply(`257 "${cwd}" is the current directory`);
        case 'CWD':
          if (entry?.type !== 'dir') return reply('550 Failed to change directory');
          cwd = target;
          return reply('250 Directory changed');
        case 'CDUP':
          cwd = path.posix.dirname(cwd);
          return reply('250 Directory changed');
        case 'EPSV':
          if (options.epsv === false) return reply('502 EPSV not implemented');
          return reply(`229 Entering Extended Passive Mode (|||${await openData()}|)`);
        case 'PASV': {
          const port = await openData();
          const host = options.pasvHost ?? '127,0,0,1';
          return reply(`227 Entering Passive Mode (${host},${port >> 8},${port & 255})`);
        }
        case 'LIST': {
          const listArg = arg
            .split(' ')
            .filter((part) => part && !part.startsWith('-'))
            .join(' ');
          const listed = resolvePath(listArg);
          const listedEntry = files.get(listed);
          const extra = options.extraListing?.(listed) ?? [];
          if (!listedEntry && extra.length)
            return sendData(Buffer.from(extra.map((l) => `${l}\r\n`).join('')));
          if (!listedEntry) {
            data?.server.close();
            data = undefined;
            return reply('450 No such file or directory');
          }
          const lines =
            listedEntry.type === 'file'
              ? [listLine(path.posix.basename(listed), listedEntry)]
              : [
                  ...childrenOf(files, listed).map((key) =>
                    listLine(path.posix.basename(key), files.get(key) as MemoryEntry),
                  ),
                  ...extra,
                ];
          return sendData(Buffer.from(lines.map((l) => `${l}\r\n`).join('')));
        }
        case 'SIZE':
          if (options.size === false) return reply('502 SIZE not implemented');
          if (entry?.type !== 'file') return reply('550 Could not get file size');
          return reply(`213 ${entry.data.length}`);
        case 'RETR':
          if (entry?.type !== 'file') {
            data?.server.close();
            data = undefined;
            return reply('550 Failed to open file');
          }
          return sendData(entry.data);
        case 'STOR': {
          if (files.get(path.posix.dirname(target))?.type !== 'dir') {
            data?.server.close();
            data = undefined;
            return reply('553 Could not create file');
          }
          const received = await receiveData();
          if (!received) return;
          addFile(files, target, received);
          return reply('226 Transfer complete');
        }
        case 'DELE':
          if (entry?.type !== 'file') return reply('550 Delete operation failed');
          files.delete(target);
          return reply('250 Delete operation successful');
        case 'RNFR':
          if (!entry) return reply('550 RNFR command failed');
          renameFrom = target;
          return reply('350 Ready for RNTO');
        case 'RNTO': {
          const from = renameFrom;
          renameFrom = undefined;
          if (!from) return reply('503 RNFR required first');
          if (files.get(path.posix.dirname(target))?.type !== 'dir' || files.has(target))
            return reply('550 Rename failed');
          for (const key of [...files.keys()]) {
            if (key === from || key.startsWith(`${from}/`)) {
              files.set(target + key.slice(from.length), files.get(key) as MemoryEntry);
              files.delete(key);
            }
          }
          return reply('250 Rename successful');
        }
        case 'MKD':
          if (entry || files.get(path.posix.dirname(target))?.type !== 'dir')
            return reply('550 Create directory operation failed');
          addDir(files, target);
          return reply(`257 "${target}" created`);
        case 'RMD':
          if (entry?.type !== 'dir' || childrenOf(files, target).length)
            return reply('550 Remove directory operation failed');
          files.delete(target);
          return reply('250 Remove directory operation successful');
        default:
          return reply('502 Command not implemented');
      }
    };

    reply('220 Test FTP server');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let eol = buffer.indexOf('\r\n'); eol >= 0; eol = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        queue = queue.then(() => handle(line)).catch(() => reply('451 Local error'));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    files,
    commands,
    get connections() {
      return counts.connections;
    },
    get dataConnections() {
      return counts.dataConnections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        for (const d of dataServers) d.close();
        server.close(() => resolve());
      }),
  };
}
