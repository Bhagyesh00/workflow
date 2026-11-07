/**
 * The parameters every vendor message operation shares (Messages, Simplify Output, Max Tool Calls
 * Iterations) and the per-item loop with continue-on-fail.
 */
import type {
  AiChatMessage,
  AiContentPart,
  DataObject,
  ExecuteContext,
  Item,
  NodeOutput,
  NodeProperty,
} from '@workflow/workflow';
import { errorMessage, redactSecrets } from '../../../shared/utils';
import { readBinaryFields, readInputFile, type VendorFile } from './binary';
import { VENDOR_WAIT_TOOL } from './tool-loop';

export interface VendorMessage {
  role: string;
  content: string;
  attachments?: VendorFile[];
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** The Messages fixed collection: a role from `roles` and the content, plus attachments when asked. */
export function messagesProperty(options: { roles: string[]; attachments?: boolean }): NodeProperty {
  const values: NodeProperty[] = [
    {
      displayName: 'Role',
      name: 'role',
      type: 'options',
      default: options.roles[0] ?? 'user',
      options: options.roles.map((role) => ({ name: titleCase(role), value: role })),
    },
    {
      displayName: 'Prompt',
      name: 'content',
      type: 'string',
      default: '',
      typeOptions: { rows: 2 },
    },
  ];
  if (options.attachments) {
    values.push(
      {
        displayName: 'Attachment URLs',
        name: 'attachmentUrls',
        type: 'string',
        default: '',
        placeholder: 'https://example.com/a.png, https://example.com/b.pdf',
        description: 'Comma separated links of files to send with this message',
      },
      {
        displayName: 'Attachment Binary Fields',
        name: 'attachmentFields',
        type: 'string',
        default: '',
        placeholder: 'data, data2',
        description: 'Comma separated names of binary fields of the input item to send with this message',
      },
    );
  }
  return {
    displayName: 'Messages',
    name: 'messages',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add message',
    typeOptions: { multipleValues: true },
    options: [{ displayName: 'Message', name: 'values', values }],
  };
}

/** The Simplify Output switch (default true). */
export function simplifyProperty(defaultValue = true): NodeProperty {
  return {
    displayName: 'Simplify Output',
    name: 'simplify',
    type: 'boolean',
    default: defaultValue,
    description: 'Whether to return a simplified version of the response instead of the raw data',
  };
}

/** The option that caps model calls in the tool loop. */
export const maxToolIterationsOption: NodeProperty = {
  displayName: 'Max Tool Calls Iterations',
  name: 'maxToolsIterations',
  type: 'number',
  default: 15,
  typeOptions: { minValue: 0 },
  description: 'Model calls allowed in one run when the model calls tools',
};

/** The item's Messages, with attachments read from their binary fields or URLs. */
export async function readVendorMessages(ctx: ExecuteContext, itemIndex: number): Promise<VendorMessage[]> {
  const collection = ctx.getNodeParameter('messages', itemIndex, {}) as {
    values?: Array<{ role?: string; content?: string; attachmentUrls?: string; attachmentFields?: string }>;
  };
  const messages: VendorMessage[] = [];
  for (const entry of collection?.values ?? []) {
    const attachments: VendorFile[] = [];
    const urls = (entry.attachmentUrls ?? '')
      .split(/[,\n]/)
      .map((url) => url.trim())
      .filter(Boolean);
    for (const url of urls) attachments.push(await readInputFile(ctx, itemIndex, { inputType: 'url', url }));
    if ((entry.attachmentFields ?? '').trim()) {
      attachments.push(...(await readBinaryFields(ctx, itemIndex, entry.attachmentFields!)));
    }
    messages.push({
      role: entry.role ?? 'user',
      content: entry.content ?? '',
      ...(attachments.length ? { attachments } : {}),
    });
  }
  return messages;
}

/** Run `run` for every input item; with continue-on-fail a failed item gives `{ error }` instead. */
export async function eachVendorItem(
  ctx: ExecuteContext,
  run: (itemIndex: number) => Promise<Item | Item[]>,
): Promise<NodeOutput> {
  const count = ctx.getInputData().length;
  const out: Item[] = [];
  for (let itemIndex = 0; itemIndex < count; itemIndex++) {
    try {
      const result = await run(itemIndex);
      for (const item of Array.isArray(result) ? result : [result]) {
        out.push(item.pairedItem === undefined ? { ...item, pairedItem: { item: itemIndex } } : item);
      }
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      // a stop, and a refusal that is a setup problem, are never turned into an item
      if (ctx.signal?.aborted || code === VENDOR_WAIT_TOOL || !ctx.continueOnFail()) {
        throw error;
      }
      out.push({
        json: { error: redactSecrets(errorMessage(error)) } as DataObject,
        pairedItem: { item: itemIndex },
      });
    }
  }
  return [out];
}

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/x-yaml', 'application/csv']);

/** One file as the part the model takes: an image, a PDF or other file, or a text file as text. */
export function fileToPart(file: VendorFile): AiContentPart {
  const mime = file.mimeType;
  if (mime.startsWith('image/')) {
    return { type: 'image', mimeType: mime, data: Buffer.from(file.bytes).toString('base64') };
  }
  if (mime.startsWith('text/') || TEXT_TYPES.has(mime) || mime.endsWith('+json') || mime.endsWith('+xml')) {
    return {
      type: 'text',
      text: `File: ${file.fileName ?? 'file'}\nContent:\n${Buffer.from(file.bytes).toString('utf8')}`,
    };
  }
  return {
    type: 'file',
    mimeType: mime,
    data: Buffer.from(file.bytes).toString('base64'),
    ...(file.fileName ? { fileName: file.fileName } : {}),
  };
}

/** The messages as chat messages for `runVendorChat`; `model` counts as `assistant`. */
export function toChatMessages(messages: VendorMessage[]): AiChatMessage[] {
  return messages.map((message) => {
    const role: AiChatMessage['role'] =
      message.role === 'model' ? 'assistant' : (message.role as AiChatMessage['role']);
    if (!message.attachments?.length) return { role, content: message.content };
    return {
      role,
      content: [{ type: 'text', text: message.content }, ...message.attachments.map(fileToPart)],
    };
  });
}
