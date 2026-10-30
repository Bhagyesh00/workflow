/**
 * Single-call chains: Basic LLM Chain, Information Extractor, Text Classifier and Sentiment
 * Analysis. Each item is one model call (plus one retry when structured output fails to parse).
 */
import {
  type AiChatMessage,
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
  getOutputParser,
  getPrompt,
  promptTextProperty,
  promptTypeProperty,
} from '../../shared/ai-inputs';
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

/** Per-item loop with continue-on-fail handling shared by the chains. */
async function eachItem(
  ctx: ExecuteContext,
  outputs: number,
  run: (item: Item, index: number) => Promise<Array<{ output: number; item: Item }>>,
): Promise<Item[][]> {
  const items = ctx.getInputData();
  const out: Item[][] = Array.from({ length: Math.max(1, outputs) }, () => []);
  for (let i = 0; i < items.length; i++) {
    try {
      for (const r of await run(items[i], i)) out[r.output].push(r.item);
    } catch (error) {
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

export const ChainLlmNode: NodeType = {
  description: {
    name: 'ai.chainLlm',
    displayName: 'Basic LLM Chain',
    description: 'Sends a prompt (and optional fixed messages) to a chat model',
    icon: 'lucide:link',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Basic LLM Chain' },
    inputs: [
      'main',
      MODEL_INPUT,
      { type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 },
    ],
    outputs: ['main'],
    categories: ['AI', 'Chains'],
    alias: ['prompt', 'llm', 'completion', 'generate'],
    properties: [
      promptTypeProperty,
      promptTextProperty,
      {
        displayName: 'Chat Messages',
        name: 'messages',
        type: 'fixedCollection',
        default: {},
        typeOptions: { multipleValues: true, sortable: true },
        placeholder: 'Add message',
        description: 'Messages placed before the prompt (instructions, examples)',
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
              },
              {
                displayName: 'Message',
                name: 'message',
                type: 'string',
                default: '',
                typeOptions: { rows: 3 },
              },
            ],
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    return eachItem(ctx, 1, async (item, i) => {
      const prompt = getPrompt(ctx, i, item);
      const model = await getChatModel(ctx, i);
      const parser = await getOutputParser(ctx, i);
      const fixed: AiChatMessage[] = collectionList<{ type: string; message: string }>(
        ctx.getNodeParameter('messages', i, {}),
        'messageValues',
      )
        .filter((m) => m.message)
        .map((m) => ({
          role: (['system', 'user', 'assistant'].includes(m.type) ? m.type : 'user') as AiChatMessage['role'],
          content: String(m.message),
        }));
      const messages = withFormatInstructions([...fixed, { role: 'user', content: prompt }], parser);
      const result = await completeWithParser(model, messages, parser, {
        node: ctx.getNode(),
        itemIndex: i,
        signal: ctx.signal,
      });
      return [
        {
          output: 0,
          item: {
            json: parser ? { output: result.output as DataObject[string] } : { text: result.text },
            pairedItem: { item: i },
          },
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
    return eachItem(ctx, categories.length + (hasOther ? 1 : 0), async (item, i) => {
      const text = inputText(ctx, 'inputText', i);
      const options = ctx.getNodeParameter('options', i, {}) as DataObject;
      const multi = Boolean(options.multiClass);
      const schema: JsonSchema = {
        type: 'object',
        properties: Object.fromEntries(
          categories.map((c) => [
            c.category,
            {
              type: 'boolean',
              description: `Whether the text belongs to "${c.category}"${c.description ? `: ${c.description}` : ''}`,
            },
          ]),
        ),
        required: categories.map((c) => c.category),
      };
      const parser = structuredParser(schema);
      const system = fillTemplate(String(options.systemPromptTemplate ?? CLASSIFIER_PROMPT), {
        categories: categories.map((c) => c.category).join(', '),
        multiple: multi ? 'one or more' : 'exactly one',
      });
      const descriptions = categories
        .filter((c) => c.description)
        .map((c) => `- ${c.category}: ${c.description}`)
        .join('\n');
      const model = await getChatModel(ctx, i);
      const result = await completeWithParser(
        model,
        withFormatInstructions(
          [
            { role: 'system', content: descriptions ? `${system}\n\nCategories:\n${descriptions}` : system },
            { role: 'user', content: text },
          ],
          parser,
        ),
        parser,
        { node: ctx.getNode(), itemIndex: i, signal: ctx.signal },
      );
      const flags = result.output as Record<string, boolean>;
      let matched = categories
        .map((c, index) => (flags[c.category] === true ? index : -1))
        .filter((x) => x >= 0);
      if (!multi) matched = matched.slice(0, 1);
      if (!matched.length) return hasOther ? [{ output: categories.length, item: passItem(item, i) }] : [];
      return matched.map((output) => ({ output, item: passItem(item, i) }));
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
        { node: ctx.getNode(), itemIndex: i, signal: ctx.signal },
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
