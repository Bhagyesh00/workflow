/** RFC 5322 / MIME helpers for building and reading Gmail messages. */
import { randomBytes } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';

export interface MimeAttachment {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
}

export interface MimeMessage {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
}

/** strip CR/LF so values can never start a new header */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047 encoded-word for non-ASCII header text */
export function encodeHeader(value: string): string {
  const safe = headerSafe(value);
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

function wrap76(base64: string): string {
  return base64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function encodeFileName(name: string): string {
  const safe = headerSafe(name).replace(/"/g, '');
  return /^[\x20-\x7e]*$/.test(safe) ? `"${safe}"` : `"${encodeHeader(safe)}"`;
}

function textPart(mimeType: string, content: string): string {
  return [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(content, 'utf8').toString('base64')),
  ].join('\r\n');
}

function boundary(): string {
  return `----=_Part_${randomBytes(12).toString('hex')}`;
}

/** Build a complete MIME message (CRLF line endings) ready for base64url encoding. */
export function buildMimeMessage(message: MimeMessage): string {
  const headers: string[] = ['MIME-Version: 1.0'];
  const add = (name: string, value: string | undefined, encode = false) => {
    if (value === undefined || value === '') return;
    headers.push(`${name}: ${encode ? encodeHeader(value) : headerSafe(value)}`);
  };
  add('From', message.from, false);
  add('To', message.to);
  add('Cc', message.cc);
  add('Bcc', message.bcc);
  add('Reply-To', message.replyTo);
  add('Subject', message.subject ?? '', true);
  add('In-Reply-To', message.inReplyTo);
  add('References', message.references);

  const bodies: string[] = [];
  if (message.text !== undefined && message.html !== undefined) {
    const alt = boundary();
    bodies.push(
      [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        '',
        `--${alt}`,
        textPart('text/plain', message.text),
        `--${alt}`,
        textPart('text/html', message.html),
        `--${alt}--`,
      ].join('\r\n'),
    );
  } else if (message.html !== undefined) bodies.push(textPart('text/html', message.html));
  else bodies.push(textPart('text/plain', message.text ?? ''));

  const attachments = message.attachments ?? [];
  if (!attachments.length) return `${headers.join('\r\n')}\r\n${bodies[0]}`;

  const mixed = boundary();
  const parts = [
    bodies[0],
    ...attachments.map((a) =>
      [
        `Content-Type: ${headerSafe(a.mimeType)}; name=${encodeFileName(a.fileName)}`,
        `Content-Disposition: attachment; filename=${encodeFileName(a.fileName)}`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(Buffer.from(a.data).toString('base64')),
      ].join('\r\n'),
    ),
  ];
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    ...parts.flatMap((p) => [`--${mixed}`, p]),
    `--${mixed}--`,
  ].join('\r\n');
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailAttachmentRef {
  fileName: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/** Flatten a Gmail API message (format=full or metadata) into readable fields. */
export function simplifyGmailMessage(
  message: DataObject,
): DataObject & { attachments: GmailAttachmentRef[] } {
  const payload = (message.payload ?? {}) as GmailPart;
  const header = (name: string) =>
    payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  let text: string | undefined;
  let html: string | undefined;
  const attachments: GmailAttachmentRef[] = [];
  const walk = (part: GmailPart) => {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        fileName: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    } else if (part.body?.data && part.mimeType === 'text/plain' && text === undefined) {
      text = decodeBase64Url(part.body.data).toString('utf8');
    } else if (part.body?.data && part.mimeType === 'text/html' && html === undefined) {
      html = decodeBase64Url(part.body.data).toString('utf8');
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    snippet: message.snippet,
    internalDate: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined,
    sizeEstimate: message.sizeEstimate,
    from: header('From'),
    to: header('To'),
    cc: header('Cc'),
    replyTo: header('Reply-To'),
    subject: header('Subject'),
    date: header('Date'),
    messageId: header('Message-ID') ?? header('Message-Id'),
    text,
    html,
    attachments,
  };
}
