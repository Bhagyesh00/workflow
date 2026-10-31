/** Small core nodes: Manual Trigger, No Op, Code, Edit Fields (Set), Respond to Webhook. */
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  type Item,
  isPlainObject,
  NodeOperationError,
  type NodeType,
  setByPath,
} from '@workflow/workflow';

/** pass-through output: point each item at its own position in this node's input, not at upstream pairing */
export function pairToInput(items: Item[]): Item[] {
  return items.map((item, i) => ({ ...item, pairedItem: { item: i } }));
}

export const ManualTriggerNode: NodeType = {
  description: {
    name: 'core.manualTrigger',
    displayName: 'Manual Trigger',
    description: "Runs the flow when you click 'Execute workflow'",
    icon: 'lucide:mouse-pointer-click',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'When clicking ‘Execute workflow’' },
    inputs: [],
    outputs: ['main'],
    maxNodes: 1,
    categories: ['Core', 'Triggers'],
    properties: [
      {
        displayName: 'This node is where the workflow starts when you click "Execute workflow".',
        name: 'notice',
        type: 'notice',
        default: '',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    return [items.length ? items : [{ json: {} }]];
  },
};

export const NoOpNode: NodeType = {
  description: {
    name: 'core.noOp',
    displayName: 'No Operation, do nothing',
    description: 'Passes data through unchanged',
    icon: 'lucide:arrow-right',
    group: ['organization'],
    version: 1,
    defaults: { name: 'No Operation, do nothing' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Flow'],
    alias: ['nothing', 'pass through', 'placeholder', 'noop', 'empty'],
    properties: [],
  },
  async execute(ctx) {
    return [pairToInput(ctx.getInputData())];
  },
};

export const CodeNode: NodeType = {
  description: {
    name: 'core.code',
    displayName: 'Code',
    description: 'Run custom JavaScript in a secure sandbox',
    icon: 'lucide:code',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Code' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['javascript', 'js', 'script', 'function', 'custom'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'runOnceForAllItems',
        noDataExpression: true,
        options: [
          {
            name: 'Run Once for All Items',
            value: 'runOnceForAllItems',
            description: 'Code runs once; use items / $input.all()',
          },
          {
            name: 'Run Once for Each Item',
            value: 'runOnceForEachItem',
            description: 'Code runs per item; use $json',
          },
        ],
      },
      {
        displayName: 'JavaScript',
        name: 'jsCode',
        type: 'code',
        noDataExpression: true,
        typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'javaScript', rows: 12 },
        default:
          '// Loop over input items and add a new field called "myNewField" to the JSON of each one\nreturn $input.all().map((item) => ({\n  json: { ...item.json, myNewField: 1 },\n}));\n',
        displayOptions: { show: { mode: ['runOnceForAllItems'] } },
      },
      {
        displayName: 'JavaScript',
        name: 'jsCode',
        type: 'code',
        noDataExpression: true,
        typeOptions: { editor: 'codeNodeEditor', editorLanguage: 'javaScript', rows: 12 },
        default:
          '// Add a new field called "myNewField" to the JSON of the item\nreturn { ...$json, myNewField: 1 };\n',
        displayOptions: { show: { mode: ['runOnceForEachItem'] } },
      },
    ],
  },
  async execute(ctx) {
    const mode = ctx.getNodeParameter('mode', 0) as 'runOnceForAllItems' | 'runOnceForEachItem';
    const code = ctx.getNodeParameter('jsCode', 0, '', { rawExpressions: true }) as string;
    try {
      return [(await ctx.runCode({ code, mode })) as Item[]];
    } catch (error) {
      if (ctx.continueOnFail()) {
        return [
          [{ json: { error: (error as Error).message }, error: { message: (error as Error).message } }],
        ];
      }
      const line = (error as { lineNumber?: number }).lineNumber;
      throw new NodeOperationError(ctx.getNode(), (error as Error).message, {
        description: line ? `Error at line ${line}` : undefined,
        cause: error,
      });
    }
  },
};

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

interface Assignment {
  id?: string;
  name: string;
  value: unknown;
  type?: FieldType;
}

export function convertFieldValue(
  value: unknown,
  type: FieldType | undefined,
  name: string,
  ctx: ExecuteContext,
  itemIndex: number,
  ignoreErrors: boolean,
): unknown {
  if (!type || value === null || value === undefined) return value;
  const fail = (expected: string) => {
    if (ignoreErrors) return value;
    throw new NodeOperationError(
      ctx.getNode(),
      `"${name}" expects a ${expected} but got ${JSON.stringify(value)}`,
      {
        itemIndex,
      },
    );
  };
  switch (type) {
    case 'string':
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return value === '' || Number.isNaN(n) ? fail('number') : n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (['true', '1', 'yes'].includes(String(value).toLowerCase())) return true;
      if (['false', '0', 'no', ''].includes(String(value).toLowerCase())) return false;
      return fail('boolean');
    case 'array':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* fall through */
        }
      }
      return fail('array');
    case 'object':
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
          /* fall through */
        }
      }
      return fail('object');
    default:
      return value;
  }
}

export const SetNode: NodeType = {
  description: {
    name: 'core.set',
    displayName: 'Edit Fields (Set)',
    description: 'Add, change or remove item fields',
    icon: 'lucide:pen',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Edit Fields' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['set', 'json', 'fields', 'map', 'transform'],
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'manual',
        noDataExpression: true,
        options: [
          { name: 'Manual Mapping', value: 'manual', description: 'Edit fields one by one' },
          { name: 'JSON', value: 'raw', description: 'Write the output as JSON' },
        ],
      },
      {
        displayName: 'Fields to Set',
        name: 'assignments',
        type: 'assignmentCollection',
        default: { assignments: [] },
        displayOptions: { show: { mode: ['manual'] } },
      },
      {
        displayName: 'JSON Output',
        name: 'jsonOutput',
        type: 'json',
        default: '{\n  "my_field_1": "value",\n  "my_field_2": 1\n}',
        typeOptions: { rows: 6 },
        displayOptions: { show: { mode: ['raw'] } },
      },
      {
        displayName: 'Include Other Input Fields',
        name: 'includeOtherFields',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Support Dot Notation',
            name: 'dotNotation',
            type: 'boolean',
            default: true,
            description: 'Whether "a.b" sets a nested field instead of a field literally named "a.b"',
          },
          {
            displayName: 'Ignore Type Conversion Errors',
            name: 'ignoreConversionErrors',
            type: 'boolean',
            default: false,
          },
          { displayName: 'Include Binary Data', name: 'includeBinary', type: 'boolean', default: true },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const mode = ctx.getNodeParameter('mode', i) as string;
        const include = ctx.getNodeParameter('includeOtherFields', i) as boolean;
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const dotNotation = options.dotNotation !== false;
        const json: DataObject = include ? deepCopy(items[i].json) : {};
        if (mode === 'raw') {
          const raw = ctx.getNodeParameter('jsonOutput', i);
          let parsed: unknown = raw;
          if (typeof raw === 'string') {
            try {
              parsed = JSON.parse(raw);
            } catch (e) {
              throw new NodeOperationError(
                ctx.getNode(),
                `JSON Output is not valid JSON: ${(e as Error).message}`,
                {
                  itemIndex: i,
                },
              );
            }
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new NodeOperationError(ctx.getNode(), 'JSON Output must be an object', { itemIndex: i });
          }
          Object.assign(json, parsed);
        } else {
          const { assignments = [] } = ctx.getNodeParameter('assignments', i, {}) as {
            assignments?: Assignment[];
          };
          for (const a of assignments) {
            if (!a.name) continue;
            // copy so a later dotted assignment can extend an object taken from the (frozen) input data
            const raw = convertFieldValue(
              a.value,
              a.type,
              a.name,
              ctx,
              i,
              Boolean(options.ignoreConversionErrors),
            );
            // class instances (luxon dates, Buffers) stay as they are; only plain data is copied
            const value = isPlainObject(raw) || Array.isArray(raw) ? deepCopy(raw) : raw;
            if (dotNotation) setByPath(json, a.name, value);
            else json[a.name] = value;
          }
        }
        const item: Item = { json, pairedItem: { item: i } };
        if (options.includeBinary !== false && items[i].binary) item.binary = items[i].binary;
        out.push(item);
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({
            json: { error: (error as Error).message },
            error: { message: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        throw error;
      }
    }
    return [out];
  },
};

export const RespondToWebhookNode: NodeType = {
  description: {
    name: 'core.respondToWebhook',
    displayName: 'Respond to Webhook',
    description: 'Return data to the caller of a Webhook trigger',
    icon: 'lucide:reply',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Respond to Webhook' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Flow'],
    alias: ['response', 'reply', 'http response', 'return', 'api response'],
    properties: [
      {
        displayName: 'Respond With',
        name: 'respondWith',
        type: 'options',
        default: 'firstIncomingItem',
        options: [
          { name: 'All Incoming Items', value: 'allIncomingItems' },
          { name: 'First Incoming Item', value: 'firstIncomingItem' },
          { name: 'JSON', value: 'json' },
          { name: 'Text', value: 'text' },
          { name: 'Binary File', value: 'binary' },
          { name: 'Redirect', value: 'redirect' },
          { name: 'No Data', value: 'noData' },
        ],
      },
      {
        displayName: 'Response Body',
        name: 'responseBody',
        type: 'json',
        default: '{\n  "myField": "value"\n}',
        displayOptions: { show: { respondWith: ['json'] } },
      },
      {
        displayName: 'Response Body',
        name: 'responseText',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: { show: { respondWith: ['text'] } },
      },
      {
        displayName: 'Redirect URL',
        name: 'redirectURL',
        type: 'string',
        default: '',
        displayOptions: { show: { respondWith: ['redirect'] } },
      },
      {
        displayName: 'Binary Property',
        name: 'binaryProperty',
        type: 'string',
        default: 'data',
        displayOptions: { show: { respondWith: ['binary'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          { displayName: 'Response Code', name: 'responseCode', type: 'number', default: 200 },
          { displayName: 'Response Headers', name: 'responseHeaders', type: 'json', default: '{}' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const respondWith = ctx.getNodeParameter('respondWith', 0) as string;
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    let headers: Record<string, string> = {};
    if (options.responseHeaders) {
      const h =
        typeof options.responseHeaders === 'string'
          ? JSON.parse(options.responseHeaders)
          : options.responseHeaders;
      headers = Object.fromEntries(
        Object.entries(h as DataObject).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
    }
    let statusCode = Number(options.responseCode ?? 200);
    let body: unknown;
    switch (respondWith) {
      case 'allIncomingItems':
        body = items.map((i) => i.json);
        break;
      case 'firstIncomingItem':
        body = items[0]?.json ?? {};
        break;
      case 'json': {
        const raw = ctx.getNodeParameter('responseBody', 0);
        body = typeof raw === 'string' ? JSON.parse(raw) : raw;
        break;
      }
      case 'text':
        body = String(ctx.getNodeParameter('responseText', 0) ?? '');
        headers['content-type'] ??= 'text/plain; charset=utf-8';
        break;
      case 'redirect':
        statusCode = options.responseCode ? statusCode : 307;
        headers.location = String(ctx.getNodeParameter('redirectURL', 0));
        break;
      case 'binary': {
        const prop = ctx.getNodeParameter('binaryProperty', 0) as string;
        const binary = ctx.helpers.assertBinaryData(0, prop);
        const data = await ctx.helpers.getBinaryDataBuffer(0, prop);
        ctx.sendResponse({
          statusCode,
          headers,
          binary: { data, mimeType: binary.mimeType, fileName: binary.fileName },
        });
        return [pairToInput(items)];
      }
      default:
        body = undefined;
    }
    ctx.sendResponse({ statusCode, headers, body });
    return [pairToInput(items)];
  },
};
