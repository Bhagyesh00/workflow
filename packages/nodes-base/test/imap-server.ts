/**
 * An in-process IMAP server for tests: it speaks the wire protocol imapflow uses (greeting, LOGIN, LIST,
 * SELECT, IDLE, UID SEARCH, UID FETCH, UID STORE, STARTTLS), with real flags and a real search evaluator,
 * so the node is tested through the socket and not through a mock of the library.
 */
import net, { type AddressInfo, type Socket } from 'node:net';
import tls, { type TLSSocket } from 'node:tls';

// a self-signed test certificate for broker.test, localhost and 127.0.0.1; it protects nothing
export const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBrDCCAVKgAwIBAgIUPkgVQRJwVDXWjab8SB8jyRvUygwwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLYnJva2VyLnRlc3QwIBcNMjYxMTA2MDgwNDM0WhgPMjEyNjEw
MTMwODA0MzRaMBYxFDASBgNVBAMMC2Jyb2tlci50ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEhvia5vaRKcBFhOzyvJ91dah1jBRvVUJOB6tVAGO8l5CFwB/z
D1gBfxOPV6VFCQlszbSNoGfYyP8eKe1lZjGQd6N8MHowHQYDVR0OBBYEFPLV7Mij
9HOPsm20BUYrHsBoI+EdMB8GA1UdIwQYMBaAFPLV7Mij9HOPsm20BUYrHsBoI+Ed
MA8GA1UdEwEB/wQFMAMBAf8wJwYDVR0RBCAwHoILYnJva2VyLnRlc3SCCWxvY2Fs
aG9zdIcEfwAAATAKBggqhkjOPQQDAgNIADBFAiBdg0KX0skaPfudE/OBdTejd7Rk
NF+K+W+YgeP2Y7jhIAIhAK4MdFhCx/y6UktEA3JHxN589duU9gCzrip6+7XqGqLr
-----END CERTIFICATE-----
`;
export const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgg/sMhjgnYQW2+HpK
62tOMv/dgxN8QIJshqTYzLYJBUmhRANCAASG+Jrm9pEpwEWE7PK8n3V1qHWMFG9V
Qk4Hq1UAY7yXkIXAH/MPWAF/E49XpUUJCWzNtI2gZ9jI/x4p7WVmMZB3
-----END PRIVATE KEY-----
`;

export interface FakeMail {
  uid: number;
  flags: Set<string>;
  source: Buffer;
  internalDate: Date;
  /** what RFC822.SIZE answers when it is not the real size: a server that lies */
  claimedSize?: number;
}

export interface ImapServerOptions {
  user?: string;
  password?: string;
  /** the whole connection is TLS */
  tls?: boolean;
  /** offers STARTTLS on a plain connection */
  startTls?: boolean;
  /** the text of a refused LOGIN */
  loginRefusal?: string;
}

interface Session {
  socket: Socket;
  buffer: string;
  selected?: string;
  idleTag?: string;
  /** EXISTS counts waiting for the next chance to tell the client */
  pendingExists: boolean;
}

type Token = string | Token[];

const SEARCH_FLAGS: Record<string, [string, boolean]> = {
  ANSWERED: ['\\Answered', true],
  UNANSWERED: ['\\Answered', false],
  DELETED: ['\\Deleted', true],
  UNDELETED: ['\\Deleted', false],
  DRAFT: ['\\Draft', true],
  UNDRAFT: ['\\Draft', false],
  FLAGGED: ['\\Flagged', true],
  UNFLAGGED: ['\\Flagged', false],
  SEEN: ['\\Seen', true],
  UNSEEN: ['\\Seen', false],
  RECENT: ['\\Recent', true],
  OLD: ['\\Recent', false],
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** split an IMAP argument string into atoms, quoted strings and parenthesised groups */
function tokenize(text: string): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (c === ' ') {
      i += 1;
    } else if (c === '(') {
      const group: Token[] = [];
      top.push(group);
      stack.push(group);
      i += 1;
    } else if (c === ')') {
      stack.pop();
      i += 1;
    } else if (c === '"') {
      let value = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        value += text[i];
        i += 1;
      }
      i += 1;
      top.push(`"${value}`);
    } else {
      let value = '';
      while (i < text.length && !' ()'.includes(text[i])) {
        value += text[i];
        i += 1;
      }
      top.push(value);
    }
  }
  return root;
}

/** a token's text, without the mark a quoted string carries */
const text = (token: Token | undefined): string => {
  if (typeof token !== 'string') return '';
  return token.startsWith('"') ? token.slice(1) : token;
};

function inSet(set: string, value: number, max: number): boolean {
  return set.split(',').some((range) => {
    const [from, to = from] = range.split(':');
    const low = from === '*' ? max : Number(from);
    const high = to === '*' ? max : Number(to);
    // as RFC 3501 says, n:* with n above the highest value still holds the highest value
    return value >= Math.min(low, high) && value <= Math.max(low, high);
  });
}

function imapDate(token: Token | undefined): number {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text(token));
  if (!match) throw new Error('bad date');
  return Date.UTC(Number(match[3]), MONTHS.indexOf(match[2].toUpperCase()), Number(match[1]));
}

const dayOf = (date: Date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

function headerOf(mail: FakeMail, name: string): string | undefined {
  const head = mail.source
    .toString('latin1')
    .split(/\r?\n\r?\n/)[0]
    .replace(/\r?\n[ \t]+/g, ' ');
  const prefix = `${name.toLowerCase()}:`;
  const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

function bodyOf(mail: FakeMail): string {
  const source = mail.source.toString('latin1');
  const match = /\r?\n\r?\n/.exec(source);
  return match ? source.slice(match.index + match[0].length) : '';
}

export class ImapTestServer {
  readonly user: string;
  readonly password: string;
  /** every command line after the tag */
  readonly commands: string[] = [];
  /** how many connections came in, and how many logged in */
  connections = 0;
  logins = 0;
  /** the SNI name of each TLS connection */
  readonly serverNames: unknown[] = [];
  /** stop answering anything, as a hung server does */
  silent = false;
  /** answer NO to every SEARCH */
  refuseSearch = false;
  port = 0;

  private readonly mailboxes = new Map<string, FakeMail[]>([['INBOX', []]]);
  private readonly sessions = new Set<Session>();
  private readonly server: net.Server;
  private nextUid = 1;

  constructor(private readonly options: ImapServerOptions = {}) {
    this.user = options.user ?? 'mailuser';
    this.password = options.password ?? 'mailpass';
    this.server = options.tls
      ? tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, (socket) => this.accept(socket))
      : net.createServer((socket) => this.accept(socket));
    this.server.on('tlsClientError', () => undefined);
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** cut every connection without a BYE, as a network failure does */
  dropConnections(): void {
    for (const session of this.sessions) session.socket.destroy();
    this.sessions.clear();
  }

  addMailbox(name: string): void {
    if (!this.mailboxes.has(name)) this.mailboxes.set(name, []);
  }

  /** how many connections are open now */
  get openConnections(): number {
    return this.sessions.size;
  }

  /** put a mail in a mailbox; a client idling on it hears at once, any other on its next command */
  addMail(
    source: string | Buffer,
    options: { mailbox?: string; seen?: boolean; date?: Date; claimedSize?: number } = {},
  ): FakeMail {
    const mailbox = options.mailbox ?? 'INBOX';
    this.addMailbox(mailbox);
    const list = this.mailboxes.get(mailbox)!;
    const mail: FakeMail = {
      uid: this.nextUid++,
      flags: new Set(options.seen ? ['\\Seen'] : []),
      source: Buffer.isBuffer(source) ? source : Buffer.from(source),
      internalDate: options.date ?? new Date(),
      claimedSize: options.claimedSize,
    };
    list.push(mail);
    for (const session of this.sessions) {
      if (session.selected !== mailbox) continue;
      if (session.idleTag) session.socket.write(`* ${list.length} EXISTS\r\n`);
      else session.pendingExists = true;
    }
    return mail;
  }

  mail(uid: number, mailbox = 'INBOX'): FakeMail | undefined {
    return this.mailboxes.get(mailbox)?.find((m) => m.uid === uid);
  }

  isSeen(uid: number, mailbox = 'INBOX'): boolean {
    return this.mail(uid, mailbox)?.flags.has('\\Seen') ?? false;
  }

  /** the commands that name `word`, for asserting what went over the wire */
  commandsWith(word: string): string[] {
    return this.commands.filter((c) => c.toUpperCase().includes(word.toUpperCase()));
  }

  private capabilities(session: Session): string {
    const canUpgrade = this.options.startTls && !(session.socket as TLSSocket).encrypted ? ' STARTTLS' : '';
    return `IMAP4rev1 IDLE UIDPLUS${canUpgrade}`;
  }

  private accept(socket: Socket): void {
    this.connections += 1;
    if ((socket as TLSSocket).encrypted)
      this.serverNames.push((socket as TLSSocket & { servername?: unknown }).servername);
    const session: Session = { socket, buffer: '', pendingExists: false };
    this.sessions.add(session);
    this.bind(session);
    if (!this.silent) socket.write('* OK Fake IMAP ready\r\n');
  }

  private bind(session: Session): void {
    session.socket.on('error', () => undefined);
    session.socket.on('close', () => this.sessions.delete(session));
    session.socket.on('data', (chunk: Buffer) => this.receive(session, chunk));
  }

  private receive(session: Session, chunk: Buffer): void {
    if (this.silent) return;
    session.buffer += chunk.toString('latin1');
    for (;;) {
      const end = session.buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = session.buffer.slice(0, end);
      session.buffer = session.buffer.slice(end + 2);
      if (this.handle(session, line) === 'upgraded') return;
    }
  }

  private tellNews(session: Session): void {
    if (!session.pendingExists || !session.selected) return;
    session.pendingExists = false;
    session.socket.write(`* ${this.mailboxes.get(session.selected)!.length} EXISTS\r\n`);
  }

  private handle(session: Session, line: string): 'upgraded' | undefined {
    const { socket } = session;
    if (session.idleTag) {
      if (line.toUpperCase() === 'DONE') {
        socket.write(`${session.idleTag} OK IDLE done\r\n`);
        session.idleTag = undefined;
      }
      return undefined;
    }
    const space = line.indexOf(' ');
    const tag = line.slice(0, space);
    const rest = line.slice(space + 1);
    this.commands.push(rest);
    const [verb] = rest.split(' ');
    const args = rest.slice(verb.length + 1);
    switch (verb.toUpperCase()) {
      case 'CAPABILITY':
        socket.write(`* CAPABILITY ${this.capabilities(session)}\r\n${tag} OK done\r\n`);
        return undefined;
      case 'STARTTLS': {
        socket.write(`${tag} OK Begin TLS\r\n`);
        socket.removeAllListeners('data');
        const secure = new tls.TLSSocket(socket, { isServer: true, cert: TEST_CERT, key: TEST_KEY });
        secure.once('secure', () =>
          this.serverNames.push((secure as TLSSocket & { servername?: unknown }).servername),
        );
        secure.on('error', () => undefined);
        session.socket = secure;
        session.buffer = '';
        secure.on('data', (chunk: Buffer) => this.receive(session, chunk));
        return 'upgraded';
      }
      case 'LOGIN': {
        const [user, password] = tokenize(args).map(text);
        if (user === this.user && password === this.password) {
          this.logins += 1;
          socket.write(`${tag} OK Logged in\r\n`);
        } else {
          socket.write(
            `${tag} NO [AUTHENTICATIONFAILED] ${this.options.loginRefusal ?? 'Invalid credentials'}\r\n`,
          );
        }
        return undefined;
      }
      case 'NOOP':
        this.tellNews(session);
        socket.write(`${tag} OK NOOP done\r\n`);
        return undefined;
      case 'LIST':
      case 'LSUB': {
        const pattern = text(tokenize(args).at(-1));
        if (pattern === '') socket.write('* LIST (\\Noselect) "/" ""\r\n');
        else {
          for (const name of this.mailboxes.keys()) {
            socket.write(`* ${verb.toUpperCase()} (\\HasNoChildren) "/" "${name}"\r\n`);
          }
        }
        socket.write(`${tag} OK done\r\n`);
        return undefined;
      }
      case 'SELECT':
      case 'EXAMINE': {
        const name = text(tokenize(args)[0]);
        const mailbox = this.mailboxes.get(name);
        if (!mailbox) {
          socket.write(`${tag} NO Mailbox does not exist on Fake IMAP\r\n`);
          return undefined;
        }
        session.selected = name;
        socket.write(
          `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)] ok\r\n` +
            `* ${mailbox.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${this.nextUid}] ok\r\n` +
            `${tag} OK [READ-WRITE] selected\r\n`,
        );
        return undefined;
      }
      case 'IDLE':
        this.tellNews(session);
        session.idleTag = tag;
        socket.write('+ idling\r\n');
        return undefined;
      case 'UID':
        this.uidCommand(session, tag, args);
        return undefined;
      case 'LOGOUT':
        socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
        socket.end();
        return undefined;
      default:
        socket.write(`${tag} BAD Unknown command\r\n`);
        return undefined;
    }
  }

  private uidCommand(session: Session, tag: string, args: string): void {
    const { socket } = session;
    const [verb] = args.split(' ');
    const rest = args.slice(verb.length + 1);
    const mails = this.mailboxes.get(session.selected ?? '') ?? [];
    this.tellNews(session);
    switch (verb.toUpperCase()) {
      case 'SEARCH': {
        if (this.refuseSearch) {
          socket.write(`${tag} NO Search refused by Fake IMAP\r\n`);
          return;
        }
        try {
          const tokens = tokenize(rest);
          const hits = mails.filter((mail) => this.matches(tokens, mail, mails));
          socket.write(`* SEARCH${hits.map((m) => ` ${m.uid}`).join('')}\r\n${tag} OK done\r\n`);
        } catch {
          socket.write(`${tag} BAD Search key not understood\r\n`);
        }
        return;
      }
      case 'FETCH': {
        const tokens = tokenize(rest);
        const set = text(tokens[0]);
        const max = mails.at(-1)?.uid ?? 0;
        const wanted = JSON.stringify(tokens.slice(1)).toUpperCase();
        mails.forEach((mail, index) => {
          if (!inSet(set, mail.uid, max)) return;
          const parts = [`UID ${mail.uid}`];
          if (wanted.includes('RFC822.SIZE'))
            parts.push(`RFC822.SIZE ${mail.claimedSize ?? mail.source.length}`);
          const body = wanted.includes('BODY');
          if (body && !wanted.includes('BODY.PEEK')) mail.flags.add('\\Seen');
          if (wanted.includes('FLAGS')) parts.push(`FLAGS (${[...mail.flags].join(' ')})`);
          const head = `* ${index + 1} FETCH (${parts.join(' ')}`;
          if (body) {
            socket.write(`${head} BODY[] {${mail.source.length}}\r\n`);
            socket.write(mail.source);
            socket.write(')\r\n');
          } else socket.write(`${head})\r\n`);
        });
        socket.write(`${tag} OK done\r\n`);
        return;
      }
      case 'STORE': {
        const tokens = tokenize(rest);
        const set = text(tokens[0]);
        const operation = text(tokens[1]).toUpperCase();
        const flags = (tokens[2] as Token[]).map(text);
        const max = mails.at(-1)?.uid ?? 0;
        mails.forEach((mail, index) => {
          if (!inSet(set, mail.uid, max)) return;
          for (const flag of flags) {
            if (operation.startsWith('+')) mail.flags.add(flag);
            else if (operation.startsWith('-')) mail.flags.delete(flag);
          }
          if (!operation.includes('SILENT')) {
            socket.write(`* ${index + 1} FETCH (UID ${mail.uid} FLAGS (${[...mail.flags].join(' ')}))\r\n`);
          }
        });
        socket.write(`${tag} OK done\r\n`);
        return;
      }
      default:
        socket.write(`${tag} BAD Unknown UID command\r\n`);
    }
  }

  /** all keys of `tokens` hold for `mail` */
  private matches(tokens: Token[], mail: FakeMail, mails: FakeMail[]): boolean {
    const queue = [...tokens];
    while (queue.length) {
      if (!this.matchKey(queue, mail, mails)) {
        // the rest must still be well formed, so a bad key is refused even after a miss
        while (queue.length) this.matchKey(queue, mail, mails);
        return false;
      }
    }
    return true;
  }

  private matchKey(queue: Token[], mail: FakeMail, mails: FakeMail[]): boolean {
    const token = queue.shift();
    if (Array.isArray(token)) return this.matches(token, mail, mails);
    const key = text(token).toUpperCase();
    const flag = SEARCH_FLAGS[key];
    if (flag) return mail.flags.has(flag[0]) === flag[1];
    switch (key) {
      case 'ALL':
        return true;
      case 'NEW':
        return mail.flags.has('\\Recent') && !mail.flags.has('\\Seen');
      case 'NOT':
        return !this.matchKey(queue, mail, mails);
      case 'OR': {
        const first = this.matchKey(queue, mail, mails);
        const second = this.matchKey(queue, mail, mails);
        return first || second;
      }
      case 'FROM':
      case 'TO':
      case 'CC':
      case 'BCC':
      case 'SUBJECT': {
        const wanted = text(queue.shift()).toLowerCase();
        return (headerOf(mail, key) ?? '').toLowerCase().includes(wanted);
      }
      case 'HEADER': {
        const name = text(queue.shift());
        const wanted = text(queue.shift()).toLowerCase();
        const value = headerOf(mail, name);
        return value?.toLowerCase().includes(wanted) === true;
      }
      case 'BODY': {
        const wanted = text(queue.shift()).toLowerCase();
        return bodyOf(mail).toLowerCase().includes(wanted);
      }
      case 'TEXT': {
        const wanted = text(queue.shift()).toLowerCase();
        return mail.source.toString('latin1').toLowerCase().includes(wanted);
      }
      case 'LARGER':
        return mail.source.length > Number(text(queue.shift()));
      case 'SMALLER':
        return mail.source.length < Number(text(queue.shift()));
      case 'KEYWORD':
        return mail.flags.has(text(queue.shift()));
      case 'UNKEYWORD':
        return !mail.flags.has(text(queue.shift()));
      case 'UID':
        return inSet(text(queue.shift()), mail.uid, mails.at(-1)?.uid ?? 0);
      case 'SINCE':
        return dayOf(mail.internalDate) >= imapDate(queue.shift());
      case 'BEFORE':
        return dayOf(mail.internalDate) < imapDate(queue.shift());
      case 'ON':
        return dayOf(mail.internalDate) === imapDate(queue.shift());
      case 'SENTSINCE':
      case 'SENTBEFORE':
      case 'SENTON': {
        const wanted = imapDate(queue.shift());
        const sent = dayOf(new Date(headerOf(mail, 'date') ?? 0));
        if (key === 'SENTSINCE') return sent >= wanted;
        return key === 'SENTBEFORE' ? sent < wanted : sent === wanted;
      }
      default:
        if (/^[\d,:*]+$/.test(key)) {
          return inSet(key, mails.indexOf(mail) + 1, mails.length);
        }
        throw new Error(`unknown search key ${key}`);
    }
  }
}
