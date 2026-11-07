/**
 * Ollama: message a model on an Ollama server and analyze images, on the native `/api/chat` call
 * (`ollamaAdapter`) with the same 20 options as the Ollama Chat Model node. The Tools port is on for
 * Message a Model once Hide Tools is set to Show. Private hosts need the administrator's allow-list.
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
import { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL, ollamaAdapter } from '../../../providers/ollama';
import { trimSlash } from '../../../shared/chat-model';
import { ollamaOptions, ollamaOptionsConfig } from '../../models/LmChatOllama.node';
import { vendorError } from '../shared/api';
import { readInputFile } from '../shared/binary';
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

const CREDENTIAL = 'ollamaApi';

const TOOLS_CONDITION = `$parameter.resource === 'text' && $parameter.operation === 'message' && $parameter.hideTools === 'show'`;

async function baseUrl(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  const credentials = await ctx.getCredentials(CREDENTIAL, itemIndex);
  return trimSlash(String(credentials.baseUrl || OLLAMA_DEFAULT_BASE_URL));
}

async function listModels(ctx: LoadOptionsContext) {
  const credentials = await ctx.getCredentials(CREDENTIAL);
  const response = (await ctx.helpers.httpRequestWithAuthentication(CREDENTIAL, {
    url: `${trimSlash(String(credentials.baseUrl || OLLAMA_DEFAULT_BASE_URL))}/api/tags`,
  })) as { models?: Array<{ name?: string }> };
  return (response.models ?? [])
    .filter((m): m is { name: string } => typeof m?.name === 'string')
    .map((m) => ({ id: m.name }));
}

const searchModels: (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult> =
  modelListSearch(listModels);

function modelLocator(): NodeProperty {
  return {
    displayName: 'Model',
    name: 'modelId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: OLLAMA_DEFAULT_MODEL },
    required: true,
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: 'Select a model...',
        typeOptions: { searchListMethod: 'modelSearch', searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. llama3.2' },
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

const systemMessageOption: NodeProperty = {
  displayName: 'System Message',
  name: 'system',
  type: 'string',
  default: '',
  typeOptions: { rows: 2 },
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
  messagesProperty({ roles: ['user', 'assistant'] }),
  simplifyProperty(true),
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [systemMessageOption, ...ollamaOptions, maxToolIterationsOption],
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
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    displayOptions: { show: { inputType: ['binary'] } },
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
    options: [systemMessageOption, ...ollamaOptions],
  },
]);

/** one chat turn on the native API; the item is the simplified reply or the raw one */
async function chat(
  ctx: ExecuteContext,
  itemIndex: number,
  messages: ReturnType<typeof toChatMessages>,
  maxIterations: number,
): Promise<Item> {
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const adapter = ollamaAdapter({
    baseUrl: await baseUrl(ctx, itemIndex),
    model: readModel(ctx, itemIndex),
    credentialType: CREDENTIAL,
    ...ollamaOptionsConfig(options),
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
  if (ctx.getNodeParameter('simplify', itemIndex, true) === false) {
    const raw = (result.raw && typeof result.raw === 'object' ? result.raw : {}) as DataObject;
    return { json: raw };
  }
  return { json: { role: 'assistant', content: result.text } };
}

async function executeMessage(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const messages = await readVendorMessages(ctx, itemIndex);
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new NodeOperationError(ctx.getNode(), `The role "${message.role}" is not known`, { itemIndex });
    }
  }
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const iterations = Number(options.maxToolsIterations ?? 15);
  return chat(ctx, itemIndex, toChatMessages(messages), Number.isFinite(iterations) ? iterations : 15);
}

async function executeAnalyze(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const inputType = ctx.getNodeParameter('inputType', itemIndex, 'binary') === 'url' ? 'url' : 'binary';
  const file = await readInputFile(ctx, itemIndex, {
    inputType,
    url: String(ctx.getNodeParameter('url', itemIndex, '')),
    binaryField: String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
  });
  if (!file.mimeType.toLowerCase().startsWith('image/')) {
    throw new NodeOperationError(ctx.getNode(), `The file type "${file.mimeType}" is not an image`, {
      itemIndex,
      description: 'Use a JPEG, PNG, GIF or WebP image.',
    });
  }
  const text = String(ctx.getNodeParameter('text', itemIndex, '')).trim();
  return chat(
    ctx,
    itemIndex,
    [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image', mimeType: file.mimeType, data: Buffer.from(file.bytes).toString('base64') },
        ],
      },
    ],
    1,
  );
}

export const OllamaNode: NodeType = {
  description: {
    name: 'ai.ollama',
    displayName: 'Ollama',
    description: 'Message a model on an Ollama server and analyze images',
    icon: 'simple:ollama',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Ollama' },
    inputs: vendorToolsInput(TOOLS_CONDITION),
    outputs: ['main'],
    credentials: [{ name: CREDENTIAL, required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['llama', 'local model'],
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
