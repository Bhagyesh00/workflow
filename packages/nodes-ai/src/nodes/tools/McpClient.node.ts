/**
 * MCP Client: a normal (main in, main out) node that calls one tool of an MCP server per item. Every call goes
 * through `createMcpConnection`, so the SSRF policy, the credential's allowed domains and the redirect rule of
 * the MCP Client Tool apply. It has NO `usableAsTool`: its tool variant would be named `ai.mcpClientTool`, the
 * existing MCP Client Tool sub-node.
 *
 * One session per execution of the node; one `tools/call` per item. The tool's text is data, never run.
 */
import {
  type BinaryData,
  type DataObject,
  type ExecuteContext,
  type Item,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeType,
  type ResourceMapperField,
  type ResourceMapperFields,
  type ResourceMapperValue,
  type WorkflowNode,
} from '@workflow/workflow';
import { parseJsonParameter } from '../../shared/json-schema';
import type { McpClient, McpTool, McpToolResult } from '../../shared/mcp-client';
import { createMcpConnection, mcpConnectFailure } from '../../shared/mcp-connect';
import { MCP_CLIENT_CREDENTIALS, MCP_CLIENT_PROPERTIES } from '../../shared/mcp-description';

type Transport = 'httpStreamable' | 'sse';

const DEFAULT_TIMEOUT = 60_000;

/** the value of a resource locator, a plain string, or '' */
function toolName(value: unknown): string {
  const raw = value && typeof value === 'object' ? (value as { value?: unknown }).value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function transportOf(value: unknown): Transport {
  return value === 'sse' ? 'sse' : 'httpStreamable';
}

function fieldType(schema: DataObject): ResourceMapperField['type'] {
  if (Array.isArray(schema.enum)) return 'options';
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'string';
}

/** The fields of a tool's input JSON Schema, one per top-level property. */
export function toolSchemaFields(tool: McpTool | undefined): ResourceMapperField[] {
  const schema = (tool?.inputSchema ?? {}) as DataObject;
  const properties = (
    schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  ) as Record<string, DataObject>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).map(([id, raw]) => {
    const property = raw && typeof raw === 'object' ? raw : {};
    const type = fieldType(property);
    return {
      id,
      displayName: typeof property.title === 'string' && property.title ? property.title : id,
      required: required.has(id),
      defaultMatch: false,
      display: true,
      canBeUsedToMatch: false,
      type,
      ...(type === 'options'
        ? {
            options: (property.enum as unknown[]).map((v) => ({
              name: String(v),
              value: typeof v === 'number' || typeof v === 'boolean' ? v : String(v),
            })),
          }
        : {}),
    };
  });
}

/** A mapped value as the tool's schema asks for it: text typed into a number, boolean, array or object field. */
function coerce(value: unknown, type: ResourceMapperField['type']): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (type === 'number') {
    const n = Number(text);
    return text !== '' && Number.isFinite(n) ? n : value;
  }
  if (type === 'boolean') {
    if (text.toLowerCase() === 'true') return true;
    if (text.toLowerCase() === 'false') return false;
    return value;
  }
  if (type === 'array' || type === 'object') {
    try {
      return JSON.parse(text);
    } catch {
      return value;
    }
  }
  return value;
}

function mappedArguments(raw: unknown): DataObject {
  const mapped = (raw ?? {}) as Partial<ResourceMapperValue>;
  const values = (mapped.value ?? {}) as DataObject;
  const types = new Map((mapped.schema ?? []).map((f) => [f.id, f] as const));
  const args: DataObject = {};
  for (const [key, value] of Object.entries(values)) {
    const field = types.get(key);
    if (field?.removed || value === undefined || value === null) continue;
    if (value === '' && field?.type !== 'string' && !field?.required) continue;
    args[key] = coerce(value, field?.type) as DataObject[string];
  }
  return args;
}

function jsonArguments(raw: unknown, node: WorkflowNode, itemIndex: number): DataObject {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' || text === undefined || text === null) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonParameter(text, 'The JSON input');
  } catch (error) {
    throw new NodeOperationError(node, (error as Error).message, { itemIndex, parameter: 'jsonInput' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NodeOperationError(node, 'The JSON input must be an object of tool arguments', {
      itemIndex,
      parameter: 'jsonInput',
    });
  }
  return parsed as DataObject;
}

function extensionOf(mimeType: string): string {
  const subtype = (mimeType.split('/')[1] ?? '').split(';')[0].split('+')[0].trim().toLowerCase();
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'mpeg') return 'mp3';
  if (subtype === 'x-wav' || subtype === 'wave') return 'wav';
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : 'bin';
}

function parsedText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function resultText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n')
    .trim();
}

async function toItem(
  ctx: ExecuteContext,
  result: McpToolResult,
  convertToBinary: boolean,
  itemIndex: number,
): Promise<Item> {
  const content: unknown[] = [];
  const binary: Record<string, BinaryData> = {};
  let count = 0;
  for (const part of result.content ?? []) {
    if (part.type === 'text') {
      content.push(parsedText(String(part.text ?? '')));
    } else if (
      convertToBinary &&
      (part.type === 'image' || part.type === 'audio') &&
      typeof part.data === 'string'
    ) {
      const mimeType = String(part.mimeType ?? (part.type === 'image' ? 'image/png' : 'audio/mpeg'));
      const key = `data_${count}`;
      binary[key] = await ctx.helpers.prepareBinaryData(
        Buffer.from(part.data, 'base64'),
        `${key}.${extensionOf(mimeType)}`,
        mimeType,
      );
      count++;
    } else {
      content.push(part);
    }
  }
  const json: DataObject = { content: content as DataObject[string] };
  if (result.structuredContent !== undefined) json.structuredContent = result.structuredContent as never;
  return {
    json,
    ...(count ? { binary } : {}),
    pairedItem: { item: itemIndex },
  };
}

function failureIssues(error: unknown): string[] {
  const description = (error as { description?: unknown } | undefined)?.description;
  return typeof description === 'string' && description
    ? description.split('\n').filter((line) => line.trim())
    : [];
}

async function connectForLoad(ctx: LoadOptionsContext): Promise<McpClient | undefined> {
  const endpoint = String(ctx.getCurrentNodeParameter('endpointUrl') ?? '').trim();
  if (!endpoint) return undefined;
  return createMcpConnection(ctx, {
    endpointUrl: endpoint,
    serverTransport: transportOf(ctx.getCurrentNodeParameter('serverTransport')),
    authentication: String(ctx.getCurrentNodeParameter('authentication') ?? 'none'),
    timeoutMs: 30_000,
  });
}

export const McpClientNode: NodeType = {
  description: {
    name: 'ai.mcpClient',
    displayName: 'MCP Client',
    description: 'Call a tool of a Model Context Protocol server',
    icon: 'lucide:plug',
    group: ['transform'],
    version: 1,
    defaults: { name: 'MCP Client' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['AI', 'Tools'],
    alias: ['mcp', 'model context protocol', 'call tool'],
    credentials: MCP_CLIENT_CREDENTIALS,
    properties: [
      ...MCP_CLIENT_PROPERTIES,
      {
        displayName: 'Tool',
        name: 'tool',
        type: 'resourceLocator',
        default: { __rl: true, mode: 'list', value: '' },
        required: true,
        description: 'The tool of the MCP server to call',
        modes: [
          {
            displayName: 'From List',
            name: 'list',
            type: 'list',
            placeholder: 'Select a tool...',
            typeOptions: { searchListMethod: 'searchTools', searchable: true },
          },
          { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Tool name' },
        ],
      },
      {
        displayName: 'Input Mode',
        name: 'inputMode',
        type: 'options',
        default: 'manual',
        noDataExpression: true,
        options: [
          { name: 'Manual', value: 'manual', description: 'Map the fields of the tool one by one' },
          { name: 'JSON', value: 'json', description: 'Give all the arguments as one JSON object' },
        ],
      },
      {
        displayName: 'Parameters',
        name: 'toolParameters',
        type: 'resourceMapper',
        default: {
          mappingMode: 'defineBelow',
          value: null,
          matchingColumns: [],
          schema: [],
          attemptToConvertTypes: false,
          convertFieldsToString: false,
        },
        noDataExpression: true,
        typeOptions: {
          loadOptionsDependsOn: ['tool.value', 'endpointUrl', 'serverTransport', 'authentication'],
          resourceMapper: {
            resourceMapperMethod: 'getToolFields',
            mode: 'map',
            valuesLabel: 'Parameters',
            fieldWords: { singular: 'parameter', plural: 'parameters' },
            addAllFields: true,
            multiKeyMatch: false,
            supportAutoMap: false,
            noFieldsError: 'This tool takes no parameters',
          },
        },
        displayOptions: { show: { inputMode: ['manual'] } },
      },
      {
        displayName: 'JSON',
        name: 'jsonInput',
        type: 'json',
        default: '{\n  \n}',
        typeOptions: { rows: 5 },
        description: 'The arguments of the tool as a JSON object',
        displayOptions: { show: { inputMode: ['json'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Convert to Binary',
            name: 'convertToBinary',
            type: 'boolean',
            default: true,
            description: 'Whether to put images and audio of the result into binary data',
          },
          {
            displayName: 'Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: DEFAULT_TIMEOUT,
            description: 'How long to wait for the server to connect and to answer, in milliseconds',
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const timeout = Number(options.timeout ?? DEFAULT_TIMEOUT);
    // one session for the whole run of this node, opened for the first item. A failure to connect fails the
    // whole node, also with continue on fail (as n8n, which connects before its item loop)
    let session: Promise<McpClient> | undefined;
    let connectError: NodeOperationError | undefined;
    const connect = (itemIndex: number): Promise<McpClient> => {
      session ??= (async () => {
        try {
          return await createMcpConnection(ctx, {
            endpointUrl: String(ctx.getNodeParameter('endpointUrl', itemIndex, '')).trim(),
            serverTransport: transportOf(ctx.getNodeParameter('serverTransport', itemIndex, 'httpStreamable')),
            authentication: String(ctx.getNodeParameter('authentication', itemIndex, 'none')),
            timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT,
            itemIndex,
          });
        } catch (error) {
          const { message, description } = mcpConnectFailure(error);
          connectError = new NodeOperationError(ctx.getNode(), message, {
            itemIndex,
            description,
            cause: error,
          });
          throw connectError;
        }
      })();
      return session;
    };

    const out: Item[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        try {
          const name = toolName(ctx.getNodeParameter('tool', i, ''));
          if (!name) throw new NodeOperationError(ctx.getNode(), 'Choose a tool', { itemIndex: i });
          const mode = String(ctx.getNodeParameter('inputMode', i, 'manual'));
          const args =
            mode === 'json'
              ? jsonArguments(ctx.getNodeParameter('jsonInput', i, ''), ctx.getNode(), i)
              : mappedArguments(ctx.getNodeParameter('toolParameters', i, null));
          const convertToBinary =
            (ctx.getNodeParameter('options', i, {}) as DataObject).convertToBinary !== false;
          const client = await connect(i);
          let result: McpToolResult;
          try {
            result = await client.callTool(name, args);
          } catch (error) {
            throw new NodeOperationError(ctx.getNode(), (error as Error).message, {
              itemIndex: i,
              cause: error,
            });
          }
          if (result.isError) {
            throw new NodeOperationError(
              ctx.getNode(),
              resultText(result) || `Tool "${name}" returned an error`,
              { itemIndex: i },
            );
          }
          out.push(await toItem(ctx, result, convertToBinary, i));
        } catch (error) {
          if (!ctx.continueOnFail() || error === connectError) {
            if (error instanceof NodeOperationError) throw error;
            throw new NodeOperationError(ctx.getNode(), (error as Error).message, {
              itemIndex: i,
              cause: error,
            });
          }
          const message = (error as Error).message;
          out.push({
            json: { error: { message, issues: failureIssues(error) } },
            error: { message },
            pairedItem: { item: i },
          });
        }
      }
    } finally {
      if (session) await (await session.catch(() => undefined))?.close().catch(() => undefined);
    }
    return [out];
  },

  methods: {
    listSearch: {
      async searchTools(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
        const client = await connectForLoad(ctx);
        if (!client) return { results: [] };
        try {
          const needle = (filter ?? '').trim().toLowerCase();
          const tools = await client.listTools();
          return {
            results: tools
              .filter(
                (t) =>
                  !needle ||
                  t.name.toLowerCase().includes(needle) ||
                  (t.description ?? '').toLowerCase().includes(needle),
              )
              .map((t) => ({ name: t.name, value: t.name })),
          };
        } finally {
          await client.close().catch(() => undefined);
        }
      },
    },
    resourceMapping: {
      async getToolFields(ctx: LoadOptionsContext): Promise<ResourceMapperFields> {
        const name = toolName(ctx.getCurrentNodeParameter('tool'));
        if (!name) return { fields: [], emptyFieldsNotice: 'Choose a tool first' };
        const client = await connectForLoad(ctx);
        if (!client) return { fields: [], emptyFieldsNotice: 'Set the endpoint first' };
        try {
          const tool = (await client.listTools()).find((t) => t.name === name);
          if (!tool) return { fields: [], emptyFieldsNotice: `The server has no tool "${name}"` };
          const fields = toolSchemaFields(tool);
          return fields.length ? { fields } : { fields, emptyFieldsNotice: 'This tool takes no parameters' };
        } finally {
          await client.close().catch(() => undefined);
        }
      },
    },
  },
};
