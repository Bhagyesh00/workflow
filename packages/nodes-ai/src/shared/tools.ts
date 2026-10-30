/** Building blocks for tool sub-nodes. */
import type { AiTool, DataObject, JsonSchema, NodeProperty, SupplyDataContext } from '@workflow/workflow';
import { schemaFromParameters } from './json-schema';
import { toToolName } from './utils';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** Wrap a function as an `AiTool` that records each call in the AI log. */
export function createTool(
  ctx: SupplyDataContext,
  definition: ToolDefinition,
  run: (args: DataObject, options: { signal?: AbortSignal }) => Promise<unknown>,
): AiTool {
  return {
    kind: 'tool',
    name: toToolName(definition.name),
    description: definition.description,
    parameters: definition.parameters,
    async invoke(args, options = {}) {
      const input = { input: args };
      try {
        const result = await run(args ?? {}, options);
        ctx.logSubNodeRun(input, { response: result as DataObject[keyof DataObject] });
        return result;
      } catch (error) {
        ctx.logSubNodeRun(input, {}, error as Error);
        throw error;
      }
    },
  };
}

/** The tool's name for the model: derived from the node name, which is unique per workflow. */
export function toolNameOf(ctx: SupplyDataContext): string {
  return toToolName(ctx.getNode().name);
}

export const toolDescriptionProperty = (placeholder: string): NodeProperty => ({
  displayName: 'Description',
  name: 'toolDescription',
  type: 'string',
  default: '',
  required: true,
  placeholder,
  typeOptions: { rows: 3 },
  description: 'Explain to the model what the tool does and when to use it',
});

/** "Specify input schema" parameters used by the Code and Workflow tools. */
export const inputSchemaProperties: NodeProperty[] = [
  {
    displayName: 'Specify Input Schema',
    name: 'specifyInputSchema',
    type: 'boolean',
    default: false,
    description: 'Whether the model passes structured arguments instead of a single "query" string',
  },
  {
    displayName: 'Schema Type',
    name: 'schemaType',
    type: 'options',
    default: 'fromJson',
    noDataExpression: true,
    displayOptions: { show: { specifyInputSchema: [true] } },
    options: [
      { name: 'Generate From JSON Example', value: 'fromJson' },
      { name: 'Define Using JSON Schema', value: 'manual' },
    ],
  },
  {
    displayName: 'JSON Example',
    name: 'jsonSchemaExample',
    type: 'json',
    default: '{\n  "some_input": "some_value"\n}',
    typeOptions: { rows: 6 },
    displayOptions: { show: { specifyInputSchema: [true], schemaType: ['fromJson'] } },
  },
  {
    displayName: 'Input Schema',
    name: 'inputSchema',
    type: 'json',
    default:
      '{\n  "type": "object",\n  "properties": {\n    "some_input": { "type": "string", "description": "Some input" }\n  },\n  "required": ["some_input"]\n}',
    typeOptions: { rows: 10 },
    displayOptions: { show: { specifyInputSchema: [true], schemaType: ['manual'] } },
  },
];

export const QUERY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { query: { type: 'string', description: 'The input for the tool' } },
  required: ['query'],
};

export function toolInputSchema(ctx: SupplyDataContext, itemIndex: number): JsonSchema {
  if (!ctx.getNodeParameter('specifyInputSchema', itemIndex, false)) return QUERY_SCHEMA;
  const schema = schemaFromParameters(
    ctx.getNodeParameter('schemaType', itemIndex, 'fromJson') as string,
    ctx.getNodeParameter('jsonSchemaExample', itemIndex, '{}'),
    ctx.getNodeParameter('inputSchema', itemIndex, '{}'),
  );
  if (schema.type !== 'object') {
    throw new Error('The input schema of a tool must describe an object');
  }
  return schema;
}
