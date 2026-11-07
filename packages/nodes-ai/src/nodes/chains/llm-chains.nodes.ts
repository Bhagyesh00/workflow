/**
 * Single-call chains: Basic LLM Chain, Information Extractor, Text Classifier and Sentiment
 * Analysis. Each item is one model call (plus one retry when structured output fails to parse).
 */
import {
  type AiChatMessage,
  type AiImagePart,
  type DataObject,
  deepCopy,
  type ExecuteContext,
  type Item,
  type JsonSchema,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import {
  getChatModel,
  getFallbackModel,
  getOutputParser,
  getPrompt,
  promptTextProperty,
  promptTypeProperty,
} from '../../shared/ai-inputs';
import { batchingOption, runInBatches } from '../../shared/batching';
import { schemaFromParameters } from '../../shared/json-schema';
import { completeWithParser, withFormatInstructions } from '../../shared/structured';
import { collectionList, errorMessage, fillTemplate } from '../../shared/utils';
import { structuredParser } from '../output-parsers/output-parsers.nodes';

const MODEL_INPUT = {
  type: 'ai_languageModel' as const,
  displayName: 'Model',
  required: true,
  maxConnections: 1,
};

/** Items per batch when the Batch Processing option is not set. */
const DEFAULT_BATCH_SIZE = 5;

/** The Batch Processing option of the node's `options` collection (read once, from item 0). */
export function batchSettings(ctx: ExecuteContext): { batchSize: number; delayMs: number } {
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const batching = (options.batching ?? {}) as DataObject;
  const size = Number(batching.batchSize ?? DEFAULT_BATCH_SIZE);
  const delay = Number(batching.delayBetweenBatches ?? 0);
  return {
    batchSize: Number.isFinite(size) && size >= 1 ? Math.floor(size) : DEFAULT_BATCH_SIZE,
    delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
  };
}

/**
 * Per-item loop with continue-on-fail handling shared by the chains. Items run in batches (the Batch
 * Processing option, 5 at a time by default); results keep the order of the input items.
 */
async function eachItem(
  ctx: ExecuteContext,
  outputs: number,
  run: (item: Item, index: number) => Promise<Array<{ output: number; item: Item }>>,
): Promise<Item[][]> {
  const items = ctx.getInputData();
  const out: Item[][] = Array.from({ length: Math.max(1, outputs) }, () => []);
  const { batchSize, delayMs } = batchSettings(ctx);
  // without continue-on-fail, a failed item ends the node once its batch is done
  const settled = await runInBatches(
    items.length,
    { batchSize, delayMs, signal: ctx.signal, stopOnFailure: !ctx.continueOnFail() },
    (i) => run(items[i], i),
  );
  for (let i = 0; i < items.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      for (const r of result.value) out[r.output].push(r.item);
      continue;
    }
    const error = result.reason;
    if (ctx.continueOnFail()) {
      out[0].push({
        json: { error: errorMessage(error) },
        error: { message: errorMessage(error) },
        pairedItem: { item: i },
      });
      continue;
    }
    if (error instanceof NodeOperationError) throw error;
    throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex: i, cause: error });
  }
  return out;
}

function inputText(ctx: ExecuteContext, name: string, i: number): string {
  const value = ctx.getNodeParameter(name, i, '');
  const text =
    typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  if (!text.trim())
    throw new NodeOperationError(ctx.getNode(), 'The text to process is empty', {
      itemIndex: i,
      parameter: name,
    });
  return text;
}

/** Item copy for routing nodes (classifier / sentiment): input data unchanged, binary kept by reference. */
function passItem(item: Item, index: number, extra?: DataObject): Item {
  return {
    json: { ...deepCopy(item.json), ...(extra ?? {}) },
    ...(item.binary ? { binary: item.binary } : {}),
    pairedItem: { item: index },
  };
}

// ---------------------------------------------------------------------------------------------
// Basic LLM Chain
// ---------------------------------------------------------------------------------------------

const FALLBACK_INPUT = {
  type: 'ai_languageModel' as const,
  displayName: 'Fallback Model',
  required: true,
  maxConnections: 1,
};
const PARSER_INPUT = {
  type: 'ai_outputParser' as const,
  displayName: 'Output Parser',
  required: true,
  maxConnections: 1,
};

/** The fallback model and output parser ports follow their toggles; the parser is read only when on. */
const CHAIN_LLM_INPUTS = `={{ ['main', ${JSON.stringify(MODEL_INPUT)}, ...($parameter.needsFallback === true ? [${JSON.stringify(FALLBACK_INPUT)}] : []), ...($parameter.hasOutputParser === true ? [${JSON.stringify(PARSER_INPUT)}] : [])] }}`;

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function toBytes(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

/** The Image Resolution option on the part. Auto sends nothing, so it is left out here too. */
function imageMessage(part: AiImagePart, imageDetail: unknown): AiChatMessage {
  const detail = imageDetail === 'low' || imageDetail === 'high' ? imageDetail : undefined;
  return { role: 'user', content: [detail ? { ...part, detail } : part] };
}

function tooLarge(ctx: ExecuteContext, i: number, limit: number): NodeOperationError {
  return new NodeOperationError(ctx.getNode(), `The image is larger than the limit of ${limit} bytes`, {
    itemIndex: i,
    description: 'The instance limit for image input is set by the administrator.',
  });
}

/** An Image (Binary) message: the item's binary property, as base64. */
async function binaryImageMessage(
  ctx: ExecuteContext,
  i: number,
  item: Item,
  key: string,
  imageDetail: unknown,
): Promise<AiChatMessage> {
  const binary = item.binary?.[key];
  if (!binary) {
    throw new NodeOperationError(ctx.getNode(), `The item has no binary property "${key}"`, {
      itemIndex: i,
      parameter: 'binaryImageDataKey',
    });
  }
  if (!binary.mimeType?.startsWith('image/')) {
    throw new NodeOperationError(ctx.getNode(), `The binary property "${key}" is not an image`, {
      itemIndex: i,
      parameter: 'binaryImageDataKey',
    });
  }
  const limit = ctx.helpers.getInstanceLimits().maxImageInputBytes;
  const data = await ctx.helpers.getBinaryDataBuffer(i, key);
  if (data.byteLength > limit) throw tooLarge(ctx, i, limit);
  return imageMessage(
    {
      type: 'image',
      mimeType: binary.mimeType,
      data: Buffer.from(data).toString('base64'),
    },
    imageDetail,
  );
}

/**
 * An Image (URL) message. The image is fetched here, through the guarded HTTP helper, so every provider
 * gets the same base64 part. The size is checked after the read (which the HTTP client bounds), and no
 * model request goes out when it is over `maxImageInputBytes`.
 */
async function urlImageMessage(
  ctx: ExecuteContext,
  i: number,
  url: string,
  imageDetail: unknown,
): Promise<AiChatMessage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NodeOperationError(ctx.getNode(), 'The image URL is not a valid URL', {
      itemIndex: i,
      parameter: 'imageUrl',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NodeOperationError(ctx.getNode(), 'The image URL must start with http:// or https://', {
      itemIndex: i,
      parameter: 'imageUrl',
    });
  }
  const limit = ctx.helpers.getInstanceLimits().maxImageInputBytes;
  const response = (await ctx.helpers.httpRequest({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    returnFullResponse: true,
  })) as { body: unknown; headers?: Record<string, string | string[] | undefined> };
  const bytes = toBytes(response.body);
  if (!bytes) {
    throw new NodeOperationError(ctx.getNode(), 'The image URL did not return image data', { itemIndex: i });
  }
  if (bytes.byteLength > limit) throw tooLarge(ctx, i, limit);
  const header = response.headers?.['content-type'];
  const declared = String(Array.isArray(header) ? header[0] : (header ?? ''))
    .split(';')[0]
    .trim()
    .toLowerCase();
  const mimeType = declared.startsWith('image/')
    ? declared
    : IMAGE_EXTENSIONS[parsed.pathname.split('.').pop()?.toLowerCase() ?? ''];
  if (!mimeType) {
    throw new NodeOperationError(ctx.getNode(), 'The image URL did not return an image', { itemIndex: i });
  }
  return imageMessage({ type: 'image', mimeType, data: Buffer.from(bytes).toString('base64') }, imageDetail);
}

interface MessageValue {
  type?: string;
  messageType?: string;
  message?: string;
  binaryImageDataKey?: string;
  imageUrl?: string;
  imageDetail?: string;
}

/** The fixed messages: text, an image from a binary property, or an image from a URL. */
async function fixedMessages(ctx: ExecuteContext, i: number, item: Item): Promise<AiChatMessage[]> {
  const values = collectionList<MessageValue>(ctx.getNodeParameter('messages', i, {}), 'messageValues');
  const messages: AiChatMessage[] = [];
  for (const m of values) {
    const messageType = m.messageType ?? 'text';
    if (messageType === 'imageBinary') {
      messages.push(
        await binaryImageMessage(ctx, i, item, String(m.binaryImageDataKey || 'data'), m.imageDetail),
      );
    } else if (messageType === 'imageUrl') {
      const url = String(m.imageUrl ?? '').trim();
      if (!url) {
        throw new NodeOperationError(ctx.getNode(), 'The image URL is empty', {
          itemIndex: i,
          parameter: 'imageUrl',
        });
      }
      messages.push(await urlImageMessage(ctx, i, url, m.imageDetail));
    } else if (m.message) {
      messages.push({
        role: (['system', 'user', 'assistant'].includes(String(m.type))
          ? m.type
          : 'user') as AiChatMessage['role'],
        content: String(m.message),
      });
    }
  }
  return messages;
}

/** A text answer is trimmed `{ text }`; a list is `{ data }`; any other parsed value is `{ output }`. */
function chainOutput(value: unknown): DataObject {
  if (typeof value === 'string') return { text: value.trim() };
  if (Array.isArray(value)) return { data: value as DataObject[string] };
  return { output: value as DataObject[string] };
}

export const ChainLlmNode: NodeType = {
  description: {
    name: 'ai.chainLlm',
    displayName: 'Basic LLM Chain',
    description: 'Sends a prompt (and optional fixed messages) to a chat model',
    icon: 'lucide:link',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Basic LLM Chain' },
    inputs: CHAIN_LLM_INPUTS,
    outputs: ['main'],
    categories: ['AI', 'Chains'],
    alias: ['prompt', 'llm', 'completion', 'generate'],
    properties: [
      promptTypeProperty,
      promptTextProperty,
      {
        displayName: 'Require Specific Output Format',
        name: 'hasOutputParser',
        type: 'boolean',
        default: false,
        noDataExpression: true,
        description: 'Whether to add an Output Parser input and parse the answer with it',
      },
      {
        displayName: 'Enable Fallback Model',
        name: 'needsFallback',
        type: 'boolean',
        default: false,
        noDataExpression: true,
        description: 'Whether to add a Fallback Model input that answers when the main model fails',
      },
      {
        displayName: 'Chat Messages',
        name: 'messages',
        type: 'fixedCollection',
        default: {},
        typeOptions: { multipleValues: true, sortable: true },
        placeholder: 'Add message',
        description: 'Messages placed before the prompt (instructions, examples, images)',
        options: [
          {
            displayName: 'Message',
            name: 'messageValues',
            values: [
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'system',
                options: [
                  { name: 'System', value: 'system' },
                  { name: 'User', value: 'user' },
                  { name: 'AI', value: 'assistant' },
                ],
                displayOptions: { show: { messageType: ['text'] } },
              },
              {
                displayName: 'Message Type',
                name: 'messageType',
                type: 'options',
                default: 'text',
                options: [
                  { name: 'Text', value: 'text', description: 'Simple text message' },
                  {
                    name: 'Image (Binary)',
                    value: 'imageBinary',
                    description: 'An image from a binary property of the input item',
                  },
                  { name: 'Image (URL)', value: 'imageUrl', description: 'An image fetched from a URL' },
                ],
              },
              {
                displayName: 'Message',
                name: 'message',
                type: 'string',
                default: '',
                typeOptions: { rows: 3 },
                displayOptions: { show: { messageType: ['text'] } },
              },
              {
                displayName: 'Image Data Field Name',
                name: 'binaryImageDataKey',
                type: 'string',
                default: 'data',
                description: 'The name of the binary property that holds the image',
                displayOptions: { show: { messageType: ['imageBinary'] } },
              },
              {
                displayName: 'Image URL',
                name: 'imageUrl',
                type: 'string',
                default: '',
                placeholder: 'https://example.com/image.png',
                displayOptions: { show: { messageType: ['imageUrl'] } },
              },
              {
                displayName: 'Image Resolution',
                name: 'imageDetail',
                type: 'options',
                default: 'auto',
                options: [
                  { name: 'Auto', value: 'auto' },
                  { name: 'Low', value: 'low' },
                  { name: 'High', value: 'high' },
                ],
                displayOptions: { show: { messageType: ['imageBinary', 'imageUrl'] } },
              },
            ],
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [batchingOption(DEFAULT_BATCH_SIZE)],
      },
    ],
  },
  async execute(ctx) {
    return eachItem(ctx, 1, async (item, i) => {
      const prompt = getPrompt(ctx, i, item);
      const model = await getChatModel(ctx, i);
      const fallback = ctx.getNodeParameter('needsFallback', i, false)
        ? await getFallbackModel(ctx, i)
        : undefined;
      // the parser is read only when its toggle is on: a connection left over from before is ignored
      const parser = ctx.getNodeParameter('hasOutputParser', i, false)
        ? await getOutputParser(ctx, i, true)
        : undefined;
      const fixed = await fixedMessages(ctx, i, item);
      const messages = withFormatInstructions([...fixed, { role: 'user', content: prompt }], parser);
      const result = await completeWithParser(model, messages, parser, {
        node: ctx.getNode(),
        itemIndex: i,
        signal: ctx.signal,
        fallback,
      });
      return [
        {
          output: 0,
          item: { json: chainOutput(parser ? result.output : result.text), pairedItem: { item: i } },
        },
      ];
    });
  },
};

// ---------------------------------------------------------------------------------------------
// Information Extractor
// ---------------------------------------------------------------------------------------------

const EXTRACTOR_PROMPT =
  "You are an expert extraction algorithm. Only extract relevant information from the text. If you do not know the value of an attribute asked to extract, omit the attribute's value.";

interface Attribute {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'date';
  description?: string;
  required?: boolean;
}

export function schemaFromAttributes(attributes: Attribute[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const a of attributes) {
    if (!a.name) continue;
    const type = a.type === 'date' ? 'string' : (a.type ?? 'string');
    const description = [a.description, a.type === 'date' ? 'Date in ISO 8601 format (YYYY-MM-DD)' : '']
      .filter(Boolean)
      .join('. ');
    properties[a.name] = { type, ...(description ? { description } : {}) };
  }
  return {
    type: 'object',
    properties,
    required: attributes.filter((a) => a.name && a.required).map((a) => a.name),
  };
}

export const InformationExtractorNode: NodeType = {
  description: {
    name: 'ai.informationExtractor',
    displayName: 'Information Extractor',
    description: 'Extracts structured fields from text into a validated JSON object',
    icon: 'lucide:scan-text',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Information Extractor' },
    inputs: ['main', MODEL_INPUT],
    outputs: ['main'],
    categories: ['AI', 'Chains'],
    alias: ['extract', 'parse', 'ner', 'entities', 'structured data'],
    properties: [
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '={{ $json.text }}',
        typeOptions: { rows: 2 },
        description: 'The text to extract information from',
      },
      {
        displayName: 'Schema Type',
        name: 'schemaType',
        type: 'options',
        default: 'fromAttributes',
        noDataExpression: true,
        options: [
          { name: 'From Attribute Descriptions', value: 'fromAttributes' },
          { name: 'Generate From JSON Example', value: 'fromJson' },
          { name: 'Define Using JSON Schema', value: 'manual' },
        ],
      },
      {
        displayName: 'Attributes',
        name: 'attributes',
        type: 'fixedCollection',
        default: {},
        typeOptions: { multipleValues: true },
        placeholder: 'Add attribute',
        displayOptions: { show: { schemaType: ['fromAttributes'] } },
        options: [
          {
            displayName: 'Attribute',
            name: 'attributes',
            values: [
              {
                displayName: 'Name',
                name: 'name',
                type: 'string',
                default: '',
                placeholder: 'e.g. company_name',
              },
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'string',
                options: ['string', 'number', 'boolean', 'date'].map((t) => ({ name: t, value: t })),
              },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              { displayName: 'Required', name: 'required', type: 'boolean', default: false },
            ],
          },
        ],
      },
      {
        displayName: 'JSON Example',
        name: 'jsonSchemaExample',
        type: 'json',
        default: '{\n  "company": "Acme",\n  "founded": 1999\n}',
        typeOptions: { rows: 8 },
        displayOptions: { show: { schemaType: ['fromJson'] } },
      },
      {
        displayName: 'Input Schema',
        name: 'inputSchema',
        type: 'json',
        default:
          '{\n  "type": "object",\n  "properties": {\n    "company": { "type": "string" },\n    "founded": { "type": "number" }\n  },\n  "required": ["company"]\n}',
        typeOptions: { rows: 10 },
        displayOptions: { show: { schemaType: ['manual'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'System Prompt Template',
            name: 'systemPromptTemplate',
            type: 'string',
            default: EXTRACTOR_PROMPT,
            typeOptions: { rows: 4 },
          },
          batchingOption(DEFAULT_BATCH_SIZE),
        ],
      },
    ],
  },
  async execute(ctx) {
    return eachItem(ctx, 1, async (_item, i) => {
      const text = inputText(ctx, 'text', i);
      const schemaType = ctx.getNodeParameter('schemaType', i, 'fromAttributes') as string;
      let schema: JsonSchema;
      if (schemaType === 'fromAttributes') {
        const attributes = collectionList<Attribute>(ctx.getNodeParameter('attributes', i, {}), 'attributes');
        if (!attributes.some((a) => a.name)) {
          throw new NodeOperationError(ctx.getNode(), 'Add at least one attribute to extract', {
            itemIndex: i,
          });
        }
        schema = schemaFromAttributes(attributes);
      } else {
        try {
          schema = schemaFromParameters(
            schemaType,
            ctx.getNodeParameter('jsonSchemaExample', i, '{}'),
            ctx.getNodeParameter('inputSchema', i, '{}'),
          );
        } catch (error) {
          throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex: i });
        }
      }
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const parser = structuredParser(schema);
      const model = await getChatModel(ctx, i);
      const messages = withFormatInstructions(
        [
          { role: 'system', content: String(options.systemPromptTemplate ?? EXTRACTOR_PROMPT) },
          { role: 'user', content: text },
        ],
        parser,
      );
      const result = await completeWithParser(model, messages, parser, {
        node: ctx.getNode(),
        itemIndex: i,
        signal: ctx.signal,
      });
      return [
        {
          output: 0,
          item: { json: { output: result.output as DataObject[string] }, pairedItem: { item: i } },
        },
      ];
    });
  },
};

// ---------------------------------------------------------------------------------------------
// Text Classifier
// ---------------------------------------------------------------------------------------------

const CLASSIFIER_PROMPT =
  'Please classify the text provided by the user into {multiple} of the following categories: {categories}. Use the provided formatting instructions below. Do not explain, only output the JSON.';

interface Category {
  category: string;
  description?: string;
}

export const TextClassifierNode: NodeType = {
  description: {
    name: 'ai.textClassifier',
    displayName: 'Text Classifier',
    description: 'Routes each item to the output of the category its text belongs to',
    icon: 'lucide:tags',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Text Classifier' },
    inputs: ['main', MODEL_INPUT],
    outputs:
      "={{ ($parameter.categories?.categories ?? []).map((c) => ({ type: 'main', displayName: c.category })).concat(($parameter.options?.fallback ?? 'discard') === 'other' ? [{ type: 'main', displayName: 'Other' }] : []) }}",
    categories: ['AI', 'Chains'],
    alias: ['classify', 'categorize', 'route', 'intent', 'label'],
    properties: [
      {
        displayName: 'Text to Classify',
        name: 'inputText',
        type: 'string',
        default: '={{ $json.text }}',
        typeOptions: { rows: 2 },
      },
      {
        displayName: 'Categories',
        name: 'categories',
        type: 'fixedCollection',
        default: {},
        typeOptions: { multipleValues: true },
        placeholder: 'Add category',
        description: 'Each category becomes an output',
        options: [
          {
            displayName: 'Category',
            name: 'categories',
            values: [
              { displayName: 'Category', name: 'category', type: 'string', default: '', required: true },
              {
                displayName: 'Description',
                name: 'description',
                type: 'string',
                default: '',
                description: 'Helps the model decide; recommended when categories are similar',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Allow Multiple Classes To Be True',
            name: 'multiClass',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'When No Clear Match',
            name: 'fallback',
            type: 'options',
            default: 'discard',
            options: [
              { name: 'Discard Item', value: 'discard' },
              { name: "Output on Extra, 'Other' Branch", value: 'other' },
            ],
          },
          {
            displayName: 'System Prompt Template',
            name: 'systemPromptTemplate',
            type: 'string',
            default: CLASSIFIER_PROMPT,
            typeOptions: { rows: 4 },
            description: 'Uses {categories} and {multiple}',
          },
          {
            displayName: 'Include Confidence Scores',
            name: 'includeConfidenceScores',
            type: 'boolean',
            default: false,
            description:
              'Whether to add the confidence of each category to the item, under "classification". The scores are estimates from the model, not measured probabilities. Rename a category called "confidence".',
          },
          {
            displayName: 'Auto-Fix Format',
            name: 'enableAutoFixing',
            type: 'boolean',
            default: true,
            description: 'Whether to ask the model once more when its answer does not fit the format',
          },
          batchingOption(DEFAULT_BATCH_SIZE),
        ],
      },
    ],
  },
  async execute(ctx) {
    const categories = collectionList<Category>(
      ctx.getNodeParameter('categories', 0, {}),
      'categories',
    ).filter((c) => c.category);
    if (!categories.length) throw new NodeOperationError(ctx.getNode(), 'Add at least one category');
    const options0 = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const hasOther = options0.fallback === 'other';
    if (
      options0.includeConfidenceScores === true &&
      categories.some((c) => c.category.trim().toLowerCase() === 'confidence')
    ) {
      throw new NodeOperationError(
        ctx.getNode(),
        'The category name "confidence" is reserved when confidence scores are on',
        {
          description:
            'The node reports the scores under that name. Rename the category, or turn off Include Confidence Scores.',
        },
      );
    }
    return eachItem(ctx, categories.length + (hasOther ? 1 : 0), async (item, i) => {
      const text = inputText(ctx, 'inputText', i);
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const multi = Boolean(options.multiClass);
      const scores = options.includeConfidenceScores === true;
      const describe = (c: Category) =>
        `Whether the text belongs to "${c.category}"${c.description ? `: ${c.description}` : ''}`;
      const schema: JsonSchema = {
        type: 'object',
        properties: Object.fromEntries(
          categories.map((c) => [
            c.category,
            scores
              ? {
                  type: 'object',
                  description: describe(c),
                  properties: {
                    match: { type: 'boolean', description: describe(c) },
                    confidence: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                      description: 'How sure you are, from 0 (not at all) to 1 (certain)',
                    },
                  },
                  required: ['match', 'confidence'],
                }
              : { type: 'boolean', description: describe(c) },
          ]),
        ),
        required: categories.map((c) => c.category),
      };
      const parser = structuredParser(schema);
      const system = fillTemplate(String(options.systemPromptTemplate ?? CLASSIFIER_PROMPT), {
        categories: categories.map((c) => c.category).join(', '),
        multiple: multi ? 'one or more' : 'exactly one',
      });
      const rules = [
        multi
          ? 'Categories are not mutually exclusive, and multiple can be true.'
          : 'Categories are mutually exclusive, and only one can be true.',
        hasOther
          ? 'If no categories apply, set every category to false.'
          : 'If there is not a very fitting category, select none of the categories.',
      ].join(' ');
      const descriptions = categories
        .filter((c) => c.description)
        .map((c) => `- ${c.category}: ${c.description}`)
        .join('\n');
      const model = await getChatModel(ctx, i);
      const result = await completeWithParser(
        model,
        withFormatInstructions(
          [
            {
              role: 'system',
              content: `${system}\n${rules}${descriptions ? `\n\nCategories:\n${descriptions}` : ''}`,
            },
            { role: 'user', content: text },
          ],
          parser,
        ),
        parser,
        {
          node: ctx.getNode(),
          itemIndex: i,
          signal: ctx.signal,
          autoFix: options.enableAutoFixing !== false,
        },
      );
      const answer = result.output as Record<string, boolean | { match: boolean; confidence: number }>;
      const flagOf = (name: string) => {
        const value = answer[name];
        return typeof value === 'object' ? value.match === true : value === true;
      };
      const confidenceOf = (name: string): number | null => {
        const value = answer[name];
        return typeof value === 'object' ? value.confidence : null;
      };
      const allScores = (): DataObject =>
        Object.fromEntries(categories.map((c) => [c.category, confidenceOf(c.category)]));
      let matched = categories.map((c, index) => (flagOf(c.category) ? index : -1)).filter((x) => x >= 0);
      if (!multi) matched = matched.slice(0, 1);
      if (!matched.length) {
        if (!hasOther) return [];
        const other = scores
          ? passItem(item, i, { classification: { category: 'Other', scores: allScores() } })
          : passItem(item, i);
        return [{ output: categories.length, item: other }];
      }
      return matched.map((output) => ({
        output,
        item: scores
          ? passItem(item, i, {
              classification: {
                category: categories[output].category,
                confidence: confidenceOf(categories[output].category),
                scores: allScores(),
              },
            })
          : passItem(item, i),
      }));
    });
  },
};

// ---------------------------------------------------------------------------------------------
// Sentiment Analysis
// ---------------------------------------------------------------------------------------------

const DEFAULT_SENTIMENTS = 'Positive, Neutral, Negative';
const SENTIMENT_PROMPT =
  'You are a highly intelligent and accurate sentiment analyzer. Analyze the sentiment of the provided text. Categorize it into one of the following: {categories}. Use the provided formatting instructions. Only output the JSON.';

export function sentimentCategories(value: unknown): string[] {
  return String(value ?? DEFAULT_SENTIMENTS)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

export const SentimentAnalysisNode: NodeType = {
  description: {
    name: 'ai.sentimentAnalysis',
    displayName: 'Sentiment Analysis',
    description: 'Scores the sentiment of text and routes items by sentiment category',
    icon: 'lucide:smile-plus',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Sentiment Analysis' },
    inputs: ['main', MODEL_INPUT],
    outputs: `={{ String($parameter.options?.categories ?? '${DEFAULT_SENTIMENTS}').split(',').map((c) => c.trim()).filter((c) => c).map((c) => ({ type: 'main', displayName: c })) }}`,
    categories: ['AI', 'Chains'],
    alias: ['sentiment', 'emotion', 'tone', 'feedback'],
    properties: [
      {
        displayName: 'Text to Analyze',
        name: 'inputText',
        type: 'string',
        default: '={{ $json.text }}',
        typeOptions: { rows: 2 },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Sentiment Categories',
            name: 'categories',
            type: 'string',
            default: DEFAULT_SENTIMENTS,
            description: 'Comma-separated; each category becomes an output',
          },
          {
            displayName: 'Include Detailed Results',
            name: 'includeDetailedResults',
            type: 'boolean',
            default: false,
            description: 'Whether to add sentiment strength and confidence scores (0 to 1)',
          },
          {
            displayName: 'System Prompt Template',
            name: 'systemPromptTemplate',
            type: 'string',
            default: SENTIMENT_PROMPT,
            typeOptions: { rows: 4 },
            description: 'Uses {categories}',
          },
          {
            displayName: 'Auto-Fix Format',
            name: 'enableAutoFixing',
            type: 'boolean',
            default: true,
            description: 'Whether to ask the model once more when its answer does not fit the format',
          },
          batchingOption(DEFAULT_BATCH_SIZE),
        ],
      },
    ],
  },
  async execute(ctx) {
    const categories = sentimentCategories((ctx.getNodeParameter('options', 0, {}) as DataObject).categories);
    if (!categories.length)
      throw new NodeOperationError(ctx.getNode(), 'Add at least one sentiment category');
    return eachItem(ctx, categories.length, async (item, i) => {
      const text = inputText(ctx, 'inputText', i);
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const detailed = Boolean(options.includeDetailedResults);
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          sentiment: { type: 'string', enum: categories, description: 'The sentiment category' },
          ...(detailed
            ? {
                strength: {
                  type: 'number',
                  description: 'Strength of the sentiment, 0 (weak) to 1 (strong)',
                },
                confidence: { type: 'number', description: 'Confidence in the classification, 0 to 1' },
              }
            : {}),
        },
        required: detailed ? ['sentiment', 'strength', 'confidence'] : ['sentiment'],
      };
      // the model may change the letter case of a category; map it back before validation
      const parser = structuredParser(schema, (value) => {
        const v = value as { sentiment?: unknown };
        if (!v || typeof v !== 'object' || typeof v.sentiment !== 'string') return value;
        const match = categories.find((c) => c.toLowerCase() === String(v.sentiment).trim().toLowerCase());
        return match ? { ...v, sentiment: match } : value;
      });
      const model = await getChatModel(ctx, i);
      const result = await completeWithParser(
        model,
        withFormatInstructions(
          [
            {
              role: 'system',
              content: fillTemplate(String(options.systemPromptTemplate ?? SENTIMENT_PROMPT), {
                categories: categories.join(', '),
              }),
            },
            { role: 'user', content: text },
          ],
          parser,
        ),
        parser,
        {
          node: ctx.getNode(),
          itemIndex: i,
          signal: ctx.signal,
          autoFix: options.enableAutoFixing !== false,
        },
      );
      const parsed = result.output as { sentiment: string; strength?: number; confidence?: number };
      const output = categories.indexOf(parsed.sentiment);
      const sentimentAnalysis: DataObject = { category: categories[output] };
      if (detailed) {
        sentimentAnalysis.strength = parsed.strength;
        sentimentAnalysis.confidence = parsed.confidence;
      }
      return [{ output, item: passItem(item, i, { sentimentAnalysis }) }];
    });
  },
};

export const llmChainNodes: NodeType[] = [
  ChainLlmNode,
  InformationExtractorNode,
  TextClassifierNode,
  SentimentAnalysisNode,
];
