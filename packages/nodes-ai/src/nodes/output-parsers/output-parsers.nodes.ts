/**
 * Output parser sub-nodes: structured (JSON schema), item list and auto-fixing (asks its own
 * model to repair output that the wrapped parser rejects).
 */
import {
  type AiOutputParser,
  type DataObject,
  type JsonSchema,
  NodeOperationError,
  type NodeType,
  type NodeTypeDescription,
} from '@workflow/workflow';
import { getChatModel, getOutputParser } from '../../shared/ai-inputs';
import { formatSchemaErrors, schemaFromParameters, validateJsonSchema } from '../../shared/json-schema';
import { errorMessage, extractJson, fillTemplate, messageText } from '../../shared/utils';

function parserDescription(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon' | 'properties'> & {
    inputs?: NodeTypeDescription['inputs'];
  },
): NodeTypeDescription {
  return {
    ...base,
    group: ['transform'],
    version: 1,
    defaults: { name: base.displayName },
    inputs: base.inputs ?? [],
    outputs: ['ai_outputParser'],
    outputNames: ['Output Parser'],
    categories: ['AI', 'Output Parsers'],
    alias: ['json', 'schema', 'format', 'structured'],
  };
}

export function structuredParser(schema: JsonSchema): AiOutputParser {
  const schemaText = JSON.stringify(schema);
  return {
    kind: 'outputParser',
    schema,
    getFormatInstructions: () =>
      `Respond only with a JSON value that matches this JSON schema, with no extra text:\n\`\`\`json\n${schemaText}\n\`\`\``,
    async parse(text) {
      const value = extractJson(text);
      const errors = validateJsonSchema(value, schema);
      if (errors.length)
        throw new Error(`The output does not match the schema: ${formatSchemaErrors(errors)}`);
      return value;
    },
  };
}

export const OutputParserStructuredNode: NodeType = {
  description: parserDescription({
    name: 'ai.outputParserStructured',
    displayName: 'Structured Output Parser',
    description: 'Makes the model return JSON in a defined shape, validated against a schema',
    icon: 'lucide:braces',
    properties: [
      {
        displayName: 'Schema Type',
        name: 'schemaType',
        type: 'options',
        default: 'fromJson',
        noDataExpression: true,
        options: [
          {
            name: 'Generate From JSON Example',
            value: 'fromJson',
            description: 'Every field in the example is required',
          },
          { name: 'Define Using JSON Schema', value: 'manual' },
        ],
      },
      {
        displayName: 'JSON Example',
        name: 'jsonSchemaExample',
        type: 'json',
        default: '{\n  "state": "California",\n  "cities": ["Los Angeles", "San Francisco", "San Diego"]\n}',
        typeOptions: { rows: 8 },
        displayOptions: { show: { schemaType: ['fromJson'] } },
      },
      {
        displayName: 'Input Schema',
        name: 'inputSchema',
        type: 'json',
        default:
          '{\n  "type": "object",\n  "properties": {\n    "state": { "type": "string" },\n    "cities": { "type": "array", "items": { "type": "string" } }\n  },\n  "required": ["state", "cities"]\n}',
        typeOptions: { rows: 12 },
        displayOptions: { show: { schemaType: ['manual'] } },
      },
    ],
  }),
  async supplyData(ctx, itemIndex) {
    let schema: JsonSchema;
    try {
      schema = schemaFromParameters(
        ctx.getNodeParameter('schemaType', itemIndex, 'fromJson') as string,
        ctx.getNodeParameter('jsonSchemaExample', itemIndex, '{}'),
        ctx.getNodeParameter('inputSchema', itemIndex, '{}'),
      );
    } catch (error) {
      throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex });
    }
    const parser = structuredParser(schema);
    return {
      response: {
        ...parser,
        async parse(text: string) {
          try {
            const value = await parser.parse(text);
            ctx.logSubNodeRun({ text }, { output: value as DataObject[string] });
            return value;
          } catch (error) {
            ctx.logSubNodeRun({ text }, {}, error as Error);
            throw error;
          }
        },
      } satisfies AiOutputParser,
    };
  },
};

/** Lines -> list items; bullets and numbering are removed. */
export function parseItemList(text: string, separator: string, limit?: number): string[] {
  const parts = (separator === '\\n' || separator === '\n' ? text.split(/\r?\n/) : text.split(separator))
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
        .trim(),
    )
    .filter(Boolean);
  return limit && limit > 0 ? parts.slice(0, limit) : parts;
}

export const OutputParserItemListNode: NodeType = {
  description: parserDescription({
    name: 'ai.outputParserItemList',
    displayName: 'Item List Output Parser',
    description: 'Returns the answer as a list of separate items',
    icon: 'lucide:list',
    properties: [
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Number of Items',
            name: 'numberOfItems',
            type: 'number',
            default: -1,
            description: 'Maximum items to return (-1 = any)',
          },
          {
            displayName: 'Separator',
            name: 'separator',
            type: 'string',
            default: '\\n',
            description: 'Separator between items (\\n = new line)',
          },
        ],
      },
    ],
  }),
  async supplyData(ctx, itemIndex) {
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const limit = Number(options.numberOfItems ?? -1);
    const separator = String(options.separator ?? '\\n');
    const parser: AiOutputParser = {
      kind: 'outputParser',
      getFormatInstructions: () =>
        `Your response must be a list of ${limit > 0 ? `at most ${limit} ` : ''}items, ${
          separator === '\\n' ? 'one per line' : `separated by "${separator}"`
        }, with no numbering, bullets or other text.`,
      async parse(text) {
        const list = parseItemList(text, separator, limit);
        ctx.logSubNodeRun({ text }, { output: list });
        return list;
      },
    };
    return { response: parser };
  },
};

const FIX_PROMPT = `Instructions:
--------------
{instructions}
--------------
Completion:
--------------
{completion}
--------------

Above, the completion did not satisfy the constraints given in the instructions.
Error:
--------------
{error}
--------------

Please try again. Respond only with an answer that satisfies the constraints laid out in the instructions.`;

export const OutputParserAutofixingNode: NodeType = {
  description: parserDescription({
    name: 'ai.outputParserAutofixing',
    displayName: 'Auto-fixing Output Parser',
    description: 'When the wrapped parser rejects the output, asks a model to repair it',
    icon: 'lucide:wrench',
    inputs: [
      { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 },
      { type: 'ai_outputParser', displayName: 'Output Parser', required: true, maxConnections: 1 },
    ],
    properties: [
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Fixing Prompt',
            name: 'prompt',
            type: 'string',
            default: FIX_PROMPT,
            typeOptions: { rows: 10 },
            description: 'Uses {instructions}, {completion} and {error}',
          },
        ],
      },
    ],
  }),
  async supplyData(ctx, itemIndex) {
    const model = await getChatModel(ctx, itemIndex);
    const inner = (await getOutputParser(ctx, itemIndex, true))!;
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const template = String(options.prompt ?? FIX_PROMPT);
    const parser: AiOutputParser = {
      kind: 'outputParser',
      schema: inner.schema,
      getFormatInstructions: () => inner.getFormatInstructions(),
      async parse(text) {
        try {
          return await inner.parse(text);
        } catch (error) {
          const prompt = fillTemplate(template, {
            instructions: inner.getFormatInstructions(),
            completion: text,
            error: errorMessage(error),
          });
          const response = await model.chat({
            messages: [{ role: 'user', content: prompt }],
            responseFormat: inner.schema ? { type: 'json', schema: inner.schema } : undefined,
            signal: ctx.signal,
          });
          const fixed = messageText(response.message.content);
          ctx.logSubNodeRun({ text, error: errorMessage(error) }, { fixed });
          return inner.parse(fixed);
        }
      },
    };
    return { response: parser };
  },
};

export const outputParserNodes: NodeType[] = [
  OutputParserStructuredNode,
  OutputParserItemListNode,
  OutputParserAutofixingNode,
];
