/**
 * Google Gemini Text > Message a Model: the Messages, the built-in tools (Google Search, Google Maps, URL
 * Context, File Search, Code Execution), generation options, JSON output and the tool loop for tools
 * connected to the node.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { geminiAdapter } from '../../../providers/gemini';
import type { ChatAdapter } from '../../../shared/chat-model';
import {
  maxToolIterationsOption,
  readVendorMessages,
  simplifyProperty,
  toChatMessages,
} from '../shared/messages';
import { vendorError } from '../shared/api';
import { runVendorChat, VENDOR_WAIT_TOOL } from '../shared/tool-loop';
import { normalizeStoreName } from './file-search';
import { geminiHost, modelProperty, readModelId, replyItems } from './operations';

export const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';

const only = { show: { resource: ['text'], operation: ['message'] } };

const num = (value: unknown): number | undefined => {
  if (value === '' || value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** the parameters of Text > Message a Model */
export const messageProperties: NodeProperty[] = [
  modelProperty({
    resource: 'text',
    operations: ['message'],
    searchMethod: 'textModels',
    defaultModel: DEFAULT_TEXT_MODEL,
  }),
  {
    displayName: 'Messages',
    name: 'messages',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add message',
    typeOptions: { multipleValues: true },
    displayOptions: only,
    options: [
      {
        displayName: 'Message',
        name: 'values',
        values: [
          {
            displayName: 'Role',
            name: 'role',
            type: 'options',
            default: 'user',
            options: [
              { name: 'User', value: 'user' },
              { name: 'Model', value: 'model' },
            ],
          },
          { displayName: 'Prompt', name: 'content', type: 'string', default: '', typeOptions: { rows: 2 } },
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
        ],
      },
    ],
  },
  { ...simplifyProperty(), displayOptions: only },
  {
    displayName: 'Output Content as JSON',
    name: 'jsonOutput',
    type: 'boolean',
    default: false,
    description: 'Whether to ask the model for a JSON answer',
    displayOptions: only,
  },
  {
    displayName: 'Built-in Tools',
    name: 'builtInTools',
    type: 'collection',
    default: {},
    placeholder: 'Add built-in tool',
    displayOptions: only,
    options: [
      {
        displayName: 'Google Search',
        name: 'googleSearch',
        type: 'boolean',
        default: true,
        description: 'Whether the model may search the web',
      },
      {
        displayName: 'Google Maps',
        name: 'googleMaps',
        type: 'boolean',
        default: true,
        description: 'Whether the model may look up places',
      },
      {
        displayName: 'Maps Latitude',
        name: 'mapsLatitude',
        type: 'string',
        default: '',
        description: 'The latitude the place lookups start from. Needs the longitude too.',
      },
      {
        displayName: 'Maps Longitude',
        name: 'mapsLongitude',
        type: 'string',
        default: '',
        description: 'The longitude the place lookups start from. Needs the latitude too.',
      },
      {
        displayName: 'URL Context',
        name: 'urlContext',
        type: 'boolean',
        default: true,
        description: 'Whether the model may read the links in the prompt',
      },
      {
        displayName: 'File Search Stores',
        name: 'fileSearchStores',
        type: 'string',
        default: '',
        placeholder: 'fileSearchStores/my-store-abc123',
        description: 'Names of file search stores the model may search, separated by commas',
      },
      {
        displayName: 'File Search Metadata Filter',
        name: 'fileSearchFilter',
        type: 'string',
        default: '',
        description: 'A filter on the document metadata of the stores, such as author="Ada"',
      },
      {
        displayName: 'Code Execution',
        name: 'codeExecution',
        type: 'boolean',
        default: true,
        description: 'Whether the model may write and run code',
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: only,
    options: [
      {
        displayName: 'Include Merged Response',
        name: 'includeMergedResponse',
        type: 'boolean',
        default: false,
        description: 'Whether to add one string with all text parts of the answer to each candidate',
      },
      {
        displayName: 'System Message',
        name: 'systemMessage',
        type: 'string',
        default: '',
        typeOptions: { rows: 3 },
      },
      {
        displayName: 'Frequency Penalty',
        name: 'frequencyPenalty',
        type: 'number',
        default: 0,
        typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
      },
      {
        displayName: 'Presence Penalty',
        name: 'presencePenalty',
        type: 'number',
        default: 0,
        typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
      },
      {
        displayName: 'Max Tokens',
        name: 'maxOutputTokens',
        type: 'number',
        default: 1024,
        typeOptions: { minValue: 1 },
      },
      {
        displayName: 'Number of Completions',
        name: 'candidateCount',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1, maxValue: 8 },
        description: 'How many answers the model writes. Each is an output item when Simplify Output is on.',
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
      },
      {
        displayName: 'Top P',
        name: 'topP',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
      },
      { displayName: 'Top K', name: 'topK', type: 'number', default: 1, typeOptions: { minValue: 1 } },
      {
        displayName: 'Thinking Budget',
        name: 'thinkingBudget',
        type: 'number',
        default: -1,
        typeOptions: { minValue: -1 },
        description: 'Tokens the model may spend thinking. -1 lets the model decide, 0 turns thinking off.',
      },
      maxToolIterationsOption,
    ],
  },
];

/** the built-in tool entries of a request, and the coordinates the Maps lookups start from */
function readBuiltInTools(ctx: ExecuteContext, itemIndex: number) {
  const tools = ctx.getNodeParameter('builtInTools', itemIndex, {}) as DataObject;
  const entries: DataObject[] = [];
  if (tools.googleSearch === true) entries.push({ googleSearch: {} });
  if (tools.googleMaps === true) entries.push({ googleMaps: {} });
  if (tools.urlContext === true) entries.push({ urlContext: {} });
  if (tools.codeExecution === true) entries.push({ codeExecution: {} });
  const stores = String(tools.fileSearchStores ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeStoreName(ctx, itemIndex, s));
  if (stores.length) {
    const filter = String(tools.fileSearchFilter ?? '').trim();
    entries.push({
      fileSearch: { fileSearchStoreNames: stores, ...(filter ? { metadataFilter: filter } : {}) },
    });
  }
  const latitude = num(tools.mapsLatitude);
  const longitude = num(tools.mapsLongitude);
  return {
    entries,
    latLng:
      tools.googleMaps === true && latitude !== undefined && longitude !== undefined
        ? { latitude, longitude }
        : undefined,
  };
}

/** Text > Message a Model */
export async function textMessage(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const model = readModelId(ctx, itemIndex, DEFAULT_TEXT_MODEL);
  const messages = toChatMessages(await readVendorMessages(ctx, itemIndex));
  if (!messages.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one message', { itemIndex });
  }
  const json = ctx.getNodeParameter('jsonOutput', itemIndex, false) === true;
  const builtIn = readBuiltInTools(ctx, itemIndex);
  const frequencyPenalty = num(options.frequencyPenalty);
  const presencePenalty = num(options.presencePenalty);
  const candidateCount = num(options.candidateCount);

  const base = geminiAdapter({
    host: await geminiHost(ctx, itemIndex),
    model,
    temperature: num(options.temperature),
    topP: num(options.topP),
    topK: num(options.topK),
    maxTokens: num(options.maxOutputTokens),
    thinkingBudget: num(options.thinkingBudget),
  });
  // the adapter has no slot for built-in tools, penalties or several answers: add them to its body
  const adapter: ChatAdapter = {
    ...base,
    buildRequest: (request, stream) => {
      const built = base.buildRequest(request, stream);
      const body = (built.body ?? {}) as DataObject;
      if (builtIn.entries.length) {
        body.tools = [...((body.tools as DataObject[] | undefined) ?? []), ...builtIn.entries];
        if (builtIn.latLng) {
          body.toolConfig = {
            ...((body.toolConfig as DataObject | undefined) ?? {}),
            retrievalConfig: { latLng: builtIn.latLng },
          };
        }
      }
      const generationConfig = (body.generationConfig as DataObject | undefined) ?? {};
      if (frequencyPenalty !== undefined) generationConfig.frequencyPenalty = frequencyPenalty;
      if (presencePenalty !== undefined) generationConfig.presencePenalty = presencePenalty;
      if (candidateCount !== undefined && candidateCount > 1)
        generationConfig.candidateCount = candidateCount;
      // JSON mode cannot be combined with tools on the API
      if (json && !body.tools) generationConfig.responseMimeType = 'application/json';
      if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
      return { ...built, body };
    },
  };

  const system = String(options.systemMessage ?? '').trim();
  let result: Awaited<ReturnType<typeof runVendorChat>>;
  try {
    result = await runVendorChat(ctx, itemIndex, adapter, {
      messages,
      ...(system ? { system } : {}),
      maxIterations: num(options.maxToolsIterations) ?? 15,
    });
  } catch (error) {
    // a refusal to start (a tool that waits) keeps its code; any other failure loses key-shaped text
    if ((error as { code?: string } | undefined)?.code === VENDOR_WAIT_TOOL) throw error;
    throw vendorError(ctx, error, itemIndex);
  }

  return replyItems(
    result.raw,
    itemIndex,
    ctx.getNodeParameter('simplify', itemIndex, true) !== false,
    options.includeMergedResponse === true,
  );
}
