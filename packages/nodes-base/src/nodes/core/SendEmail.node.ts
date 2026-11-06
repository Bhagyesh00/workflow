/** Send Email over SMTP (nodemailer); the guarded transport is in utils/smtp-transport.ts. */
import { type DataObject, NodeOperationError, type NodeType } from '@workflow/workflow';
import { smtpCredentialTest } from '../../credential-tests/smtp';
import {
  SEND_AND_WAIT,
  SEND_AND_WAIT_OPERATION,
  sendAndWaitProperties,
  sendAndWaitWebhooks,
} from '../../utils/send-and-wait/descriptions';
import { emailHtml, emailText } from '../../utils/send-and-wait/pages';
import { sendAndWait } from '../../utils/send-and-wait/wait';
import { sendAndWaitWebhook } from '../../utils/send-and-wait/webhook';
import { createSmtpTransport, type SmtpCredentials } from '../../utils/smtp-transport';
import { fieldList, mapItems } from '../../utils/utilities';

/** strip CR/LF so header values cannot inject extra headers */
function headerValue(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export const SendEmailNode: NodeType = {
  description: {
    name: 'core.sendEmail',
    displayName: 'Send Email',
    description: 'Send an email through an SMTP server',
    icon: 'lucide:mail',
    iconColor: '#00bb88',
    group: ['output'],
    version: 1,
    defaults: { name: 'Send Email' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Communication'],
    alias: ['email', 'smtp', 'mail', 'send', 'notify'],
    usableAsTool: true,
    credentials: [{ name: 'smtp', required: true, testedBy: 'smtpCredentialTest' }],
    webhooks: sendAndWaitWebhooks,
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'send',
        options: [{ name: 'Send', value: 'send', action: 'Send an email' }, SEND_AND_WAIT_OPERATION],
      },
      {
        displayName: 'From Email',
        name: 'fromEmail',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'Ada <ada@example.com>',
      },
      {
        displayName: 'To Email',
        name: 'toEmail',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'info@example.com, Bob <bob@example.com>',
        description: 'Comma-separated recipients',
      },
      { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
      {
        displayName: 'Email Format',
        name: 'emailFormat',
        type: 'options',
        default: 'html',
        displayOptions: { show: { operation: ['send'] } },
        options: [
          { name: 'Text', value: 'text' },
          { name: 'HTML', value: 'html' },
          { name: 'Both', value: 'both', description: 'HTML with a plain text fallback' },
        ],
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '',
        typeOptions: { rows: 5 },
        displayOptions: { show: { operation: ['send'], emailFormat: ['text', 'both'] } },
      },
      {
        displayName: 'HTML',
        name: 'html',
        type: 'string',
        default: '',
        typeOptions: { rows: 5, editor: 'htmlEditor' },
        displayOptions: { show: { operation: ['send'], emailFormat: ['html', 'both'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { operation: ['send'] } },
        options: [
          {
            displayName: 'Attachments',
            name: 'attachments',
            type: 'string',
            default: '',
            placeholder: 'data, invoice',
            description: 'Comma-separated binary properties of the item to attach',
          },
          { displayName: 'CC Email', name: 'ccEmail', type: 'string', default: '' },
          { displayName: 'BCC Email', name: 'bccEmail', type: 'string', default: '' },
          { displayName: 'Reply To', name: 'replyTo', type: 'string', default: '' },
          {
            displayName: 'Ignore SSL Issues (Insecure)',
            name: 'allowUnauthorizedCerts',
            type: 'boolean',
            default: false,
          },
        ],
      },
      ...sendAndWaitProperties({ operation: [SEND_AND_WAIT] }),
    ],
  },

  async execute(ctx) {
    const sendAndWaitOperation = ctx.getNodeParameter('operation', 0, 'send') === SEND_AND_WAIT;
    const creds = await ctx.getCredentials<SmtpCredentials>('smtp');
    const host = String(creds.host ?? '').trim();
    if (!host) throw new NodeOperationError(ctx.getNode(), 'The SMTP credential has no host');
    const transport = await createSmtpTransport(ctx, creds, {
      allowUnauthorizedCerts: Boolean(ctx.getNodeParameter('options.allowUnauthorizedCerts', 0, false)),
    });
    try {
      if (sendAndWaitOperation) {
        return await sendAndWait(ctx, async (message) => {
          const to = headerValue(ctx.getNodeParameter('toEmail', 0, ''));
          if (!to) throw new NodeOperationError(ctx.getNode(), 'Add at least one recipient');
          await transport.sendMail({
            from: headerValue(ctx.getNodeParameter('fromEmail', 0, '')),
            to,
            subject: headerValue(ctx.getNodeParameter('subject', 0, '')),
            text: emailText(message.message, message.buttons),
            html: emailHtml(message.message, message.buttons),
          });
        });
      }
      return [
        await mapItems(ctx, async (i) => {
          const options = ctx.getNodeParameter('options', i, {}) as DataObject;
          const format = ctx.getNodeParameter('emailFormat', i, 'html') as string;
          const attachments = [];
          for (const property of fieldList(options.attachments)) {
            const binary = ctx.helpers.assertBinaryData(i, property);
            attachments.push({
              filename: headerValue(binary.fileName ?? property),
              content: Buffer.from(await ctx.helpers.getBinaryDataBuffer(i, property)),
              contentType: binary.mimeType,
            });
          }
          const to = headerValue(ctx.getNodeParameter('toEmail', i, ''));
          if (!to)
            throw new NodeOperationError(ctx.getNode(), 'Add at least one recipient', { itemIndex: i });
          const info = await transport.sendMail({
            from: headerValue(ctx.getNodeParameter('fromEmail', i, '')),
            to,
            cc: headerValue(options.ccEmail) || undefined,
            bcc: headerValue(options.bccEmail) || undefined,
            replyTo: headerValue(options.replyTo) || undefined,
            subject: headerValue(ctx.getNodeParameter('subject', i, '')),
            text: format !== 'html' ? String(ctx.getNodeParameter('text', i, '') ?? '') : undefined,
            html: format !== 'text' ? String(ctx.getNodeParameter('html', i, '') ?? '') : undefined,
            attachments,
          });
          return {
            messageId: info.messageId,
            accepted: info.accepted as unknown[],
            rejected: info.rejected as unknown[],
            response: info.response,
          };
        }),
      ];
    } finally {
      transport.close();
    }
  },

  webhook: sendAndWaitWebhook,

  methods: {
    credentialTest: { smtpCredentialTest },
  },
};
