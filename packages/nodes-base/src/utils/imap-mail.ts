/**
 * The one seam around imapflow and mailparser: the guarded IMAP client, the credential test, and one
 * mail source as the Simple, Resolved or RAW item. The socket connects only to the addresses the SSRF
 * guard checked: `tls.lookup` reaches imapflow's net.connect and tls.connect alike.
 */
import type {
  BinaryData,
  CredentialTestContext,
  DataObject,
  Item,
  NodeCredentialTestResult,
  NodeHelpers,
} from '@workflow/workflow';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { type Attachment, type ParsedMail, type SimpleParserOptions, simpleParser } from 'mailparser';
import type { GuardedConnectContext } from './broker-connect';

const CONNECTION_TIMEOUT_MS = 30_000;
/** new mail is heard through IDLE, which starts this long after the last command */
const AUTO_IDLE_DELAY_MS = 1000;
/** restarted before imapflow's 5 minute socket timeout, and how often a server without IDLE is polled */
const MAX_IDLE_TIME_MS = 4 * 60_000;
/** the longest line, such as the answer to a search of a large mailbox */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** a credential test reads no mail, only the list of mailboxes */
const CREDENTIAL_TEST_LITERAL_BYTES = 1024 * 1024;
/** HTML longer than this is not turned into text: the conversion would hold up the event loop */
const MAX_HTML_TO_TEXT_CHARS = 8 * 1024 * 1024;

/** headers of a Simple item that go on the item itself; the others go under `metadata` */
const TOP_LEVEL_HEADERS = new Set(['cc', 'date', 'from', 'subject', 'to']);

export interface ImapCredentials extends DataObject {
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  allowUnauthorizedCerts?: boolean;
}

interface FailedImapCall {
  authenticationFailed?: boolean;
  code?: unknown;
}

/** the error's code when it is a plain name; never any text the server wrote */
export function imapErrorCode(error: unknown): string {
  const { code } = (error ?? {}) as FailedImapCall;
  return typeof code === 'string' && /^[\w-]+$/.test(code) ? ` (${code})` : '';
}

/** why a connection or login failed, in our words: server text can hold anything */
function connectFailure(error: unknown): Error {
  if ((error as FailedImapCall | undefined)?.authenticationFailed) {
    return new Error('IMAP refused the username or password');
  }
  return new Error(`Couldn't connect to the IMAP server${imapErrorCode(error)}`);
}

/**
 * A client that has not connected yet. It goes through the guard first, so a refused host gets no socket,
 * and `maxMailBytes` bounds what a hostile server can make it hold in memory.
 */
export async function createImapClient(
  ctx: GuardedConnectContext,
  credentials: ImapCredentials,
  maxMailBytes: number,
): Promise<ImapFlow> {
  const host = String(credentials.host ?? '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Enter the IMAP host');
  const { lookup } = await ctx.helpers.resolveAllowedHost(host);
  const options: ImapFlowOptions = {
    host,
    port: Number(credentials.port) || 993,
    secure: credentials.secure !== false,
    auth: { user: String(credentials.user ?? ''), pass: String(credentials.password ?? '') },
    tls: { lookup, rejectUnauthorized: credentials.allowUnauthorizedCerts !== true },
    // imapflow's logger would write what the server says; none of it belongs in our logs
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    autoIdleDelay: AUTO_IDLE_DELAY_MS,
    maxIdleTime: MAX_IDLE_TIME_MS,
    disableCompression: true,
    maxLiteralSize: maxMailBytes,
    maxLineLength: MAX_LINE_BYTES,
    maxResponseSize: maxMailBytes + MAX_LINE_BYTES,
  };
  return new ImapFlow(options);
}

/** connect and log in; on a failure the client is closed and the error is ours */
export async function connectImapClient(client: ImapFlow): Promise<void> {
  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw connectFailure(error);
  }
}

/** n8n's test: connect, list the mailboxes, close. No text of the server reaches the answer. */
export async function imapCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let client: ImapFlow | undefined;
  const abort = () => client?.close();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    client = await createImapClient(ctx, credential.data as ImapCredentials, CREDENTIAL_TEST_LITERAL_BYTES);
    // an 'error' event with no listener would throw; the failed call below answers the test
    client.on('error', () => undefined);
    await connectImapClient(client);
    try {
      await client.list();
    } catch (error) {
      return { status: 'Error', message: `Couldn't list the IMAP mailboxes${imapErrorCode(error)}` };
    }
    return { status: 'OK', message: 'Connection successful!' };
  } catch (error) {
    // our own texts only: a credential field, the guard, or connectFailure
    return { status: 'Error', message: (error as Error).message };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    client?.close();
  }
}

/** the mail itself cannot be read: the node skips it. A failing binary store is not this. */
export class UnreadableMail extends Error {
  constructor() {
    super('message could not be parsed');
  }
}

async function parseMail(source: Buffer, options: SimpleParserOptions): Promise<ParsedMail> {
  try {
    return await simpleParser(source, options);
  } catch {
    throw new UnreadableMail();
  }
}

/** the header's value on one line, without its name */
function rawHeaderValue(line: string): string {
  return line
    .slice(line.indexOf(':') + 1)
    .replace(/\r?\n[ \t]+/g, ' ')
    .trim();
}

/** mailparser leaves headers it does not know encoded; through it as a Subject they come out decoded */
async function decodeWords(value: string): Promise<string> {
  if (!value.includes('=?')) return value;
  const { subject } = await parseMail(Buffer.from(`Subject: ${value}\r\n\r\n`), {});
  return subject ?? value;
}

/** the first value of a header, decoded */
async function simpleHeaderValue(mail: ParsedMail, key: string, line: string): Promise<string> {
  const parsed = mail.headers.get(key);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof first === 'string') return key === 'subject' ? first : decodeWords(first);
  if (first && typeof first === 'object' && 'text' in first) return String(first.text);
  // the Date header stays as written, as in n8n
  return key === 'date' ? rawHeaderValue(line) : decodeWords(rawHeaderValue(line));
}

type MailHelpers = { helpers: Pick<NodeHelpers, 'prepareBinaryData'> };

async function attachmentBinaries(
  ctx: MailHelpers,
  attachments: Attachment[],
  prefix: string,
): Promise<Record<string, BinaryData> | undefined> {
  if (attachments.length === 0) return undefined;
  const binary: Record<string, BinaryData> = {};
  for (const [index, attachment] of attachments.entries()) {
    binary[`${prefix}${index}`] = await ctx.helpers.prepareBinaryData(
      attachment.content,
      attachment.filename,
      attachment.contentType,
    );
  }
  return binary;
}

/** text and html of the mail, the first value of each header; `attachmentPrefix` set: attachments too */
export async function simpleItem(
  ctx: MailHelpers,
  source: Buffer,
  uid: number,
  attachmentPrefix?: string,
): Promise<Item> {
  const mail = await parseMail(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    keepCidLinks: true,
    checksumAlgo: false,
  });
  const metadata: DataObject = {};
  const json: DataObject = {
    textHtml: mail.html || '',
    textPlain: mail.text ?? '',
    metadata,
    attributes: { uid },
  };
  const taken = new Set<string>();
  for (const { key, line } of mail.headerLines) {
    if (key === '__proto__' || taken.has(key)) continue;
    taken.add(key);
    const value = await simpleHeaderValue(mail, key, line);
    if (!value) continue;
    if (TOP_LEVEL_HEADERS.has(key)) json[key] = value;
    else metadata[key] = value;
  }
  const item: Item = { json };
  if (attachmentPrefix !== undefined) {
    // inline parts are part of the body, as in n8n
    const files = mail.attachments.filter((a) => a.contentDisposition === 'attachment');
    const binary = await attachmentBinaries(ctx, files, attachmentPrefix);
    if (binary) item.binary = binary;
  }
  return item;
}

/** the whole parsed mail: headers as raw lines, values safe for JSON, every attachment as a binary */
export async function resolvedItem(
  ctx: MailHelpers,
  source: Buffer,
  uid: number,
  attachmentPrefix: string,
): Promise<Item> {
  const mail = await parseMail(source, {
    maxHtmlLengthToParse: MAX_HTML_TO_TEXT_CHARS,
    checksumAlgo: false,
  });
  const { attachments, headerLines, headers: _headers, textConversionError: _error, ...fields } = mail;
  const headers = Object.fromEntries(
    headerLines.filter(({ key }) => key !== '__proto__').map(({ key, line }) => [key, line]),
  );
  const item: Item = {
    json: JSON.parse(JSON.stringify({ ...fields, headers, attributes: { uid } })) as DataObject,
  };
  const binary = await attachmentBinaries(ctx, attachments, attachmentPrefix);
  if (binary) item.binary = binary;
  return item;
}

/** the mail's body as it travels, without its headers */
export function rawItem(source: Buffer): Item {
  const crlf = source.indexOf('\r\n\r\n');
  const lf = source.indexOf('\n\n');
  let start = source.length;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) start = crlf + 4;
  else if (lf >= 0) start = lf + 2;
  return { json: { raw: source.subarray(start).toString('utf8') } };
}
