/**
 * Moonshot Kimi: message a Kimi model and analyze images on the OpenAI-shaped chat API, at the base URL
 * of the credential's region. Attachments go as image parts. The Tools port is on for Message a Model
 * once Hide Tools is set to Show.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { openAiAdapter } from '../../../providers/openai';
import { trimSlash } from '../../../shared/chat-model';
import { vendorError } from '../shared/api';
import { readBinaryFields, readInputFile, type VendorFile } from '../shared/binary';
import {
  eachVendorItem,
  maxToolIterationsOption,
  messagesProperty,
  readVendorMessages,
  simplifyProperty,
  toChatMessages,
} from '../shared/messages';
import { modelListSearch } from '../shared/model-lists';
import { runVendorChat, VENDOR_WAIT_TOOL, vendorToolsInput } from '../shared/tool-loop';

const CREDENTIAL = 'moonshotApi';
const DEFAULT_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k2-0905-preview';

const TOOLS_CONDITION = `$parameter.resource === 'text' && $parameter.operation === 'message' && $parameter.hideTools === 'show'`;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

async function baseUrl(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  const credentials = await ctx.getCredentials(CREDENTIAL, itemIndex);
  return trimSlash(String(credentials.url || DEFAULT_URL));
}

async function listModels(ctx: LoadOptionsContext) {
  const credentials = await ctx.getCredentials(CREDENTIAL);
  const response = (await ctx.helpers.httpRequestWithAuthentication(CREDENTIAL, {
    url: `${trimSlash(String(credentials.url || DEFAULT_URL))}/models`,
  })) as { data?: Array<{ id?: string }> };
  return (response.data ?? [])
    .filter((m): m is { id: string } => typeof m?.id === 'string')
    .map((m) => ({ id: m.id }));
}

const searchModels: (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult> =
  modelListSearch(listModels);

function modelLocator(): NodeProperty {
  return {
    displayName: 'Model',
    name: 'modelId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: DEFAULT_MODEL },
    required: true,
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: 'Select a model...',
        typeOptions: { searchListMethod: 'modelSearch', searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. kimi-k2-0905-preview' },
    ],
  };
}

function readModel(ctx: ExecuteContext, itemIndex: number): string {
  const raw = ctx.getNodeParameter('modelId', itemIndex, '') as unknown;
  const value = raw && typeof raw === 'object' ? (raw as { value?: unknown }).value : raw;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new NodeOperationError(ctx.getNode(), 'Choose a model', { itemIndex });
  return text;
}

function forOperation(resource: string, operation: string, properties: NodeProperty[]): NodeProperty[] {
  return properties.map((property) => ({
    ...property,
    displayOptions: {
      ...property.displayOptions,
      show: { ...property.displayOptions?.show, resource: [resource], operation: [operation] },
    },
  }));
}

const mergedOption: NodeProperty = {
  displayName: 'Include Merged Response',
  name: 'includeMergedResponse',
  type: 'boolean',
  default: false,
  description: 'Whether to add one string that joins all text parts of the reply',
};

const maxTokensOption: NodeProperty = {
  displayName: 'Max Tokens',
  name: 'maxTokens',
  type: 'number',
  default: 1024,
  typeOptions: { minValue: 1 },
};

const messageProperties = forOperation('text', 'message', [
  {
    displayName: 'Hide Tools',
    name: 'hideTools',
    type: 'options',
    default: 'hide',
    noDataExpression: true,
    description: 'Whether the node takes tools on its Tools input',
    options: [
      { name: 'Hide', value: 'hide' },
      { name: 'Show', value: 'show' },
    ],
  },
  modelLocator(),
  messagesProperty({ roles: ['user', 'assistant'], attachments: true }),
  simplifyProperty(true),
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Frequency Penalty',
        name: 'frequencyPenalty',
        type: 'number',
        default: 0,
        typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
      },
      mergedOption,
      maxTokensOption,
      maxToolIterationsOption,
      {
        displayName: 'System Message',
        name: 'system',
        type: 'string',
        default: '',
        typeOptions: { rows: 2 },
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 0.7,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
      },
    ],
  },
]);

const analyzeProperties = forOperation('image', 'analyze', [
  modelLocator(),
  {
    displayName: 'Text Input',
    name: 'text',
    type: 'string',
    default: "What's in this image?",
    typeOptions: { rows: 2 },
  },
  {
    displayName: 'Input Type',
    name: 'inputType',
    type: 'options',
    default: 'binary',
    options: [
      { name: 'Binary File', value: 'binary' },
      { name: 'Image URL', value: 'url' },
    ],
  },
  {
    displayName: 'Input Data Field Name(s)',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    displayOptions: { show: { inputType: ['binary'] } },
    description: 'Comma separated names of the binary fields that hold the images',
  },
  {
    displayName: 'URL',
    name: 'url',
    type: 'string',
    default: '',
    displayOptions: { show: { inputType: ['url'] } },
    placeholder: 'https://example.com/photo.png',
  },
  simplifyProperty(true),
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [mergedOption, maxTokensOption],
  },
]);

async function chat(
  ctx: ExecuteContext,
  itemIndex: number,
  messages: ReturnType<typeof toChatMessages>,
  maxIterations: number,
): Promise<Item> {
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const adapter = openAiAdapter({
    baseUrl: await baseUrl(ctx, itemIndex),
    model: readModel(ctx, itemIndex),
    credentialType: CREDENTIAL,
    provider: 'moonshot',
    maxTokensField: 'max_tokens',
    responseFormatMode: 'none',
    streamUsage: false,
    temperature: num(options.temperature),
    frequencyPenalty: num(options.frequencyPenalty),
    maxTokens: num(options.maxTokens) ?? 1024,
  });
  const system = typeof options.system === 'string' && options.system.trim() ? options.system : undefined;
  let result: Awaited<ReturnType<typeof runVendorChat>>;
  try {
    result = await runVendorChat(ctx, itemIndex, adapter, {
      messages,
      system,
      maxIterations,
      useTools: ctx.getNodeParameter('hideTools', itemIndex, 'hide') === 'show',
    });
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code === VENDOR_WAIT_TOOL) throw error;
    throw vendorError(ctx, error, itemIndex);
  }
  const merged = options.includeMergedResponse === true ? { merged_response: result.text } : {};
  if (ctx.getNodeParameter('simplify', itemIndex, true) === false) {
    const raw = (result.raw && typeof result.raw === 'object' ? result.raw : {}) as DataObject;
    return { json: { ...raw, ...merged } };
  }
  return { json: { output: result.text, ...merged } };
}

/** attachments are images or text files; Kimi takes nothing else through this node */
function checkAttachments(ctx: ExecuteContext, itemIndex: number, files: VendorFile[] | undefined): void {
  for (const file of files ?? []) {
    const mime = file.mimeType.toLowerCase();
    if (!mime.startsWith('image/') && !mime.startsWith('text/')) {
      throw new NodeOperationError(ctx.getNode(), `The file type "${mime}" cannot be sent to Kimi`, {
        itemIndex,
        description: 'Attach images or text files.',
      });
    }
  }
}

async function executeMessage(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const messages = await readVendorMessages(ctx, itemIndex);
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new NodeOperationError(ctx.getNode(), `The role "${message.role}" is not known`, { itemIndex });
    }
    checkAttachments(ctx, itemIndex, message.attachments);
  }
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const iterations = Number(options.maxToolsIterations ?? 15);
  return chat(ctx, itemIndex, toChatMessages(messages), Number.isFinite(iterations) ? iterations : 15);
}

async function executeAnalyze(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const inputType = ctx.getNodeParameter('inputType', itemIndex, 'binary') === 'url' ? 'url' : 'binary';
  const files =
    inputType === 'url'
      ? [
          await readInputFile(ctx, itemIndex, {
            inputType,
            url: String(ctx.getNodeParameter('url', itemIndex, '')),
          }),
        ]
      : await readBinaryFields(
          ctx,
          itemIndex,
          String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
        );
  for (const file of files) {
    if (!file.mimeType.toLowerCase().startsWith('image/')) {
      throw new NodeOperationError(ctx.getNode(), `The file type "${file.mimeType}" is not an image`, {
        itemIndex,
        description: 'Use a JPEG, PNG, GIF or WebP image.',
      });
    }
  }
  const text = String(ctx.getNodeParameter('text', itemIndex, '')).trim();
  return chat(ctx, itemIndex, toChatMessages([{ role: 'user', content: text, attachments: files }]), 1);
}

export const MoonshotNode: NodeType = {
  description: {
    name: 'ai.moonshot',
    displayName: 'Moonshot Kimi',
    description: 'Message a Kimi model and analyze images',
    icon: 'simple:moonshot',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Moonshot Kimi' },
    inputs: vendorToolsInput(TOOLS_CONDITION),
    outputs: ['main'],
    credentials: [{ name: CREDENTIAL, required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['kimi'],
    usableAsTool: true,
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'text',
        options: [
          { name: 'Text', value: 'text' },
          { name: 'Image', value: 'image' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['text'] } },
        default: 'message',
        options: [{ name: 'Message a Model', value: 'message', action: 'Message a model' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['image'] } },
        default: 'analyze',
        options: [{ name: 'Analyze Image', value: 'analyze', action: 'Analyze an image' }],
      },
      ...messageProperties,
      ...analyzeProperties,
    ],
  },
  methods: { listSearch: { modelSearch: searchModels } },

  async execute(ctx) {
    return eachVendorItem(ctx, async (itemIndex) => {
      const resource = String(ctx.getNodeParameter('resource', itemIndex, 'text'));
      const operation = String(ctx.getNodeParameter('operation', itemIndex, ''));
      if (resource === 'text' && operation === 'message') return executeMessage(ctx, itemIndex);
      if (resource === 'image' && operation === 'analyze') return executeAnalyze(ctx, itemIndex);
      throw new NodeOperationError(ctx.getNode(), `The operation "${resource}.${operation}" is not known`, {
        itemIndex,
      });
    });
  },
};
