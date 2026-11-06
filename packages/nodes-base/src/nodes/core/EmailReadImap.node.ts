/**
 * Email Trigger (IMAP), n8n v2.2 behaviour on imapflow. Listens through IDLE, catches up on mail that came
 * in while inactive, and starts one run per 20 mails. A dropped connection goes to emitError, and the
 * trigger runtime restarts the node.
 */
import type { DataObject, Item, NodeType, TriggerContext, TriggerResponse } from '@workflow/workflow';
import type { ImapFlow, SearchObject } from 'imapflow';
import { DateTime } from 'luxon';
import {
  connectImapClient,
  createImapClient,
  type ImapCredentials,
  imapCredentialTest,
  imapErrorCode,
  rawItem,
  resolvedItem,
  simpleItem,
  UnreadableMail,
} from '../../utils/imap-mail';
import { allOf, parseCustomRules } from '../../utils/imap-search';

const BATCH_SIZE = 20;
const CLOSED_TEXT = 'IMAP connection closed unexpectedly';
/** the longest delay setInterval can hold */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Settings {
  mailbox: string;
  markAsRead: boolean;
  format: string;
  downloadAttachments: boolean;
  attachmentPrefix: string;
  rules: SearchObject;
  reconnectMs?: number;
  onlyNew: boolean;
}

function readSettings(ctx: TriggerContext): Settings {
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const reconnectMinutes = Number(options.forceReconnect);
  return {
    mailbox: String(ctx.getNodeParameter('mailbox', 0, 'INBOX')),
    markAsRead: ctx.getNodeParameter('postProcessAction', 0, 'read') === 'read',
    format: String(ctx.getNodeParameter('format', 0, 'simple')),
    downloadAttachments: ctx.getNodeParameter('downloadAttachments', 0, false) === true,
    attachmentPrefix: String(ctx.getNodeParameter('dataPropertyAttachmentsPrefixName', 0, 'attachment_')),
    rules: parseCustomRules(options.customEmailConfig ?? '["UNSEEN"]'),
    reconnectMs: reconnectMinutes > 0 ? Math.min(reconnectMinutes * 60_000, MAX_TIMER_MS) : undefined,
    onlyNew: options.trackLastMessageId !== false,
  };
}

/** today in the workflow's time zone, at midnight UTC: an IMAP date has no time */
function activationDay(ctx: TriggerContext): Date {
  const zoned = DateTime.now().setZone(ctx.getTimezone());
  const day = zoned.isValid ? zoned : DateTime.now();
  return new Date(Date.UTC(day.year, day.month - 1, day.day));
}

/** one open mailbox and the work on it; only one piece of work runs at a time */
class MailboxWatcher {
  private client?: ImapFlow;
  private stopped = false;
  private running = false;
  private rerun = false;
  private reconnectDue = false;
  private timer?: NodeJS.Timeout;
  private readonly cursor: DataObject;
  private readonly maxMailBytes: number;
  private readonly firstDay: Date;

  constructor(
    private readonly ctx: TriggerContext,
    private readonly credentials: ImapCredentials,
    private readonly settings: Settings,
  ) {
    this.cursor = ctx.getWorkflowStaticData('node');
    if (!settings.onlyNew) delete this.cursor.lastMessageUid;
    this.maxMailBytes = ctx.helpers.getInstanceLimits().maxRemoteFileBytes;
    this.firstDay = activationDay(ctx);
  }

  async start(): Promise<void> {
    this.client = await this.open();
    if (this.settings.reconnectMs) {
      this.timer = setInterval(() => {
        this.reconnectDue = true;
        void this.work();
      }, this.settings.reconnectMs);
    }
    // no arrival event fires for mail that came in while inactive. After the host has the response:
    // a failure found here goes to emitError, and that must not race the end of the start.
    setImmediate(() => void this.work());
  }

  /** returns at once, whatever the server does: an unreachable server must not hold up a deactivation */
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    const client = this.client;
    this.client = undefined;
    client?.close();
  }

  private async open(): Promise<ImapFlow> {
    const client = await createImapClient(this.ctx, this.credentials, this.maxMailBytes);
    client.on('error', (error: unknown) => {
      if (client !== this.client) return;
      this.ctx.logger.debug(`IMAP connection experienced an error${imapErrorCode(error)}`);
      this.fail(new Error(`IMAP connection failed${imapErrorCode(error)}`));
    });
    client.on('close', () => {
      if (client === this.client) this.fail(new Error(CLOSED_TEXT));
    });
    client.on('exists', () => {
      if (client === this.client) void this.work();
    });
    await connectImapClient(client);
    try {
      await client.mailboxOpen(this.settings.mailbox);
    } catch (error) {
      client.close();
      throw new Error(`Couldn't open the mailbox "${this.settings.mailbox}"${imapErrorCode(error)}`);
    }
    return client;
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stop();
    this.ctx.emitError(error);
  }

  private async work(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        if (this.reconnectDue) await this.reconnect();
        await this.readNewMail();
      } while (!this.stopped && (this.rerun || this.reconnectDue));
    } catch (error) {
      this.fail(this.workFailure(error));
    } finally {
      this.running = false;
    }
  }

  /** the old connection goes first, as some servers limit connections per account */
  private async reconnect(): Promise<void> {
    this.reconnectDue = false;
    this.ctx.logger.debug('Forcing reconnect to IMAP server');
    const old = this.client;
    this.client = undefined;
    old?.close();
    try {
      const next = await this.open();
      if (this.stopped) next.close();
      else this.client = next;
    } catch (error) {
      // open() throws only our own texts and the guard's
      this.fail(error as Error);
    }
  }

  /** a failed command, in our words: the text of its error can be what the server wrote */
  private workFailure(error: unknown): Error {
    if (error instanceof ImapSearchRefused) return error;
    const code = imapErrorCode(error);
    if (!this.client?.usable && (!code || code.includes('NoConnection'))) return new Error(CLOSED_TEXT);
    return new Error(`Couldn't read new mail from the IMAP server${code}`);
  }

  private async readNewMail(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    const lock = await client.getMailboxLock(this.settings.mailbox);
    try {
      for (;;) {
        const uids = await this.search(client);
        if (uids.length === 0 || this.stopped) return;
        await this.readBatch(client, uids.slice(0, BATCH_SIZE));
        if (uids.length <= BATCH_SIZE || this.stopped) return;
      }
    } finally {
      lock.release();
    }
  }

  /** UIDs to read, oldest first. The server answers n:* with the highest UID even when it is below n. */
  private async search(client: ImapFlow): Promise<number[]> {
    const last = this.lastUid();
    let extra: SearchObject = {};
    if (last !== undefined) extra = { uid: `${last + 1}:*` };
    else if (this.settings.onlyNew) extra = { since: this.firstDay };
    const found = await client.search(allOf([this.settings.rules, extra]), { uid: true });
    if (!Array.isArray(found)) throw new ImapSearchRefused();
    return found.filter((uid) => last === undefined || uid > last).sort((a, b) => a - b);
  }

  private lastUid(): number | undefined {
    const value = this.cursor.lastMessageUid;
    return typeof value === 'number' ? value : undefined;
  }

  /** \Seen and the cursor are set after the mails are read and before the run starts, as in n8n */
  private async readBatch(client: ImapFlow, uids: number[]): Promise<void> {
    const sizes = new Map<number, number | undefined>();
    for (const message of await client.fetchAll(uids.join(','), { uid: true, size: true }, { uid: true })) {
      sizes.set(message.uid, message.size);
    }
    const items: Item[] = [];
    const read: number[] = [];
    for (const uid of uids) {
      if (this.stopped) return;
      const item = await this.readMail(client, uid, sizes.get(uid));
      if (item) {
        items.push(item);
        read.push(uid);
      }
    }
    if (this.stopped) return;
    if (this.settings.markAsRead && read.length > 0) {
      const marked = await client.messageFlagsAdd(read.join(','), ['\\Seen'], { uid: true });
      if (!marked) this.ctx.logger.warn('The IMAP server refused to mark the emails as read');
    }
    this.cursor.lastMessageUid = Math.max(this.lastUid() ?? 0, ...uids);
    this.ctx.logger.debug(`Process ${items.length} new emails in node "EmailReadImap"`);
    if (items.length > 0 && !this.stopped) this.ctx.emit([items]);
  }

  /** undefined: skipped with a warning. It stays unread, and the cursor moves past it, as in n8n. */
  private async readMail(client: ImapFlow, uid: number, size: number | undefined): Promise<Item | undefined> {
    const skip = (reason: string) => {
      this.ctx.logger.warn(`Skipping email UID ${uid}: ${reason}`);
      return undefined;
    };
    if (size !== undefined && size > this.maxMailBytes) {
      return skip(`${size} bytes is over the limit of ${this.maxMailBytes} bytes for one mail`);
    }
    const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!message || !message.source) return skip('message source missing');
    try {
      return await this.toItem(message.source, uid);
    } catch (error) {
      if (error instanceof UnreadableMail) return skip(error.message);
      throw error;
    }
  }

  private toItem(source: Buffer, uid: number): Promise<Item> | Item {
    const { format, attachmentPrefix, downloadAttachments } = this.settings;
    if (format === 'raw') return rawItem(source);
    if (format === 'resolved') return resolvedItem(this.ctx, source, uid, attachmentPrefix);
    return simpleItem(this.ctx, source, uid, downloadAttachments ? attachmentPrefix : undefined);
  }
}

class ImapSearchRefused extends Error {
  constructor() {
    super('The IMAP server refused the search. Check the custom email rules.');
  }
}

export const EmailReadImapNode: NodeType = {
  description: {
    name: 'core.emailReadImap',
    displayName: 'Email Trigger (IMAP)',
    description: 'Starts a run on new mail as simple, resolved or raw items',
    icon: 'lucide:inbox',
    iconColor: '#44aa22',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Email Trigger (IMAP)' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Communication', 'Triggers'],
    alias: ['email', 'imap', 'mail', 'inbox', 'mailbox'],
    credentials: [{ name: 'imap', required: true, testedBy: 'imapCredentialTest' }],
    properties: [
      { displayName: 'Mailbox Name', name: 'mailbox', type: 'string', default: 'INBOX' },
      {
        displayName: 'Action',
        name: 'postProcessAction',
        type: 'options',
        default: 'read',
        options: [
          { name: 'Mark as Read', value: 'read' },
          { name: 'Nothing', value: 'nothing' },
        ],
        description: 'What to do with a mail once it has been read. With Nothing it stays unread.',
      },
      {
        displayName: 'Download Attachments',
        name: 'downloadAttachments',
        type: 'boolean',
        default: false,
        displayOptions: { show: { format: ['simple'] } },
        description: 'Whether to save attachments as binary data. Turn this on only when needed.',
      },
      {
        displayName: 'Format',
        name: 'format',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'RAW', value: 'raw', description: 'Only the text of the mail body, as it travels' },
          {
            name: 'Resolved',
            value: 'resolved',
            description: 'The whole parsed mail, with every attachment as binary data',
          },
          {
            name: 'Simple',
            value: 'simple',
            description: 'Text, HTML and headers, and attachments when Download Attachments is on',
          },
        ],
        description: 'The form of each item',
      },
      {
        displayName: 'Property Prefix Name',
        name: 'dataPropertyAttachmentsPrefixName',
        type: 'string',
        default: 'attachment_',
        displayOptions: { show: { format: ['resolved'] } },
        description: 'Prefix of the binary properties for attachments; the number starts at 0',
      },
      {
        displayName: 'Property Prefix Name',
        name: 'dataPropertyAttachmentsPrefixName',
        type: 'string',
        default: 'attachment_',
        displayOptions: { show: { format: ['simple'], downloadAttachments: [true] } },
        description: 'Prefix of the binary properties for attachments; the number starts at 0',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Custom Email Rules',
            name: 'customEmailConfig',
            type: 'string',
            default: '["UNSEEN"]',
            description:
              'A JSON array of IMAP search rules, such as ["UNSEEN", ["FROM", "a@example.com"], ["SINCE", "May 20, 2024"]]',
          },
          {
            displayName: 'Force Reconnect Every Minutes',
            name: 'forceReconnect',
            type: 'number',
            default: 60,
            description:
              'Only for servers that limit how long a connection may live. A lost connection is restored without it.',
          },
          {
            displayName: 'Fetch Only New Emails',
            name: 'trackLastMessageId',
            type: 'boolean',
            default: true,
            description:
              'Whether to read only mail newer than the last one read. Turned off, each start reads all mail the rules match.',
          },
        ],
      },
    ],
  },

  methods: {
    credentialTest: { imapCredentialTest },
  },

  async trigger(ctx): Promise<TriggerResponse> {
    const settings = readSettings(ctx);
    const credentials = await ctx.getCredentials<ImapCredentials>('imap');
    const watcher = new MailboxWatcher(ctx, credentials, settings);
    await watcher.start();
    return {
      closeFunction: async () => watcher.stop(),
    };
  },
};
