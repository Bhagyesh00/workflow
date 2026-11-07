/** Workflow Retriever: runs a sub-workflow and returns its output items as documents. */
import {
  type AiDocument,
  type AiRetriever,
  type DataObject,
  isResourceLocatorValue,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { parseJsonParameter } from '../../shared/json-schema';
import { collectionList, errorMessage } from '../../shared/utils';
import { searchWorkflows } from '../tools/workflow-inputs';

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** One Workflow Value as the type the user picked; the engine has already evaluated expressions. */
function coerce(name: string, type: string, value: unknown): unknown {
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
      if (!Number.isFinite(n)) throw new Error(`Workflow value "${name}" is not a number`);
      return n;
    }
    case 'boolean':
      return value === true || String(value).trim().toLowerCase() === 'true';
    case 'array':
    case 'object': {
      const parsed = parseJsonParameter(value, `Workflow value "${name}"`);
      const isArray = Array.isArray(parsed);
      const ok = type === 'array' ? isArray : !!parsed && typeof parsed === 'object' && !isArray;
      if (!ok) throw new Error(`Workflow value "${name}" is not ${type === 'array' ? 'an array' : 'an object'}`);
      return parsed;
    }
    default:
      if (value === undefined || value === null) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** `- "key": "value"` lines; a nested object goes one level deeper (two spaces). */
function formatJson(value: DataObject, depth = 0): string {
  const pad = '  '.repeat(depth);
  return Object.entries(value)
    .map(([key, v]) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? `${pad}- ${JSON.stringify(key)}:\n${formatJson(v as DataObject, depth + 1)}`
        : `${pad}- ${JSON.stringify(key)}: ${JSON.stringify(v ?? null)}`,
    )
    .join('\n');
}

export const RetrieverWorkflowNode: NodeType = {
  description: {
    name: 'ai.retrieverWorkflow',
    displayName: 'Workflow Retriever',
    description: 'Runs a sub-workflow and returns its output items as documents',
    icon: 'lucide:workflow',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Workflow Retriever' },
    inputs: [],
    outputs: ['ai_retriever'],
    outputNames: ['Retriever'],
    categories: ['AI', 'Retrievers'],
    alias: ['rag', 'search', 'sub-workflow'],
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'database',
        options: [
          { name: 'Workflow From This Workspace', value: 'database' },
          { name: 'Define Below (JSON)', value: 'parameter' },
        ],
      },
      {
        displayName: 'Workflow',
        name: 'workflowId',
        type: 'resourceLocator',
        default: { __rl: true, mode: 'list', value: '' },
        required: true,
        modes: [
          {
            displayName: 'From List',
            name: 'list',
            type: 'list',
            placeholder: 'Select a workflow...',
            typeOptions: { searchListMethod: 'searchWorkflows', searchable: true },
          },
          { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Workflow ID' },
        ],
        displayOptions: { show: { source: ['database'] } },
      },
      {
        displayName: 'Workflow JSON',
        name: 'workflowJson',
        type: 'json',
        default: '{\n  "name": "Retriever workflow",\n  "nodes": [],\n  "connections": {}\n}',
        typeOptions: { rows: 10 },
        displayOptions: { show: { source: ['parameter'] } },
      },
      {
        displayName: 'Workflow Values',
        name: 'fields',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add Value',
        default: {},
        description: 'Values sent to the workflow together with the query',
        options: [
          {
            name: 'values',
            displayName: 'Values',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'string',
                options: [
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' },
                  { name: 'Boolean', value: 'boolean' },
                  { name: 'Array', value: 'array' },
                  { name: 'Object', value: 'object' },
                ],
              },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const source = String(ctx.getNodeParameter('source', itemIndex, 'database')) === 'parameter' ? 'parameter' : 'database';
    let workflow: DataObject | undefined;
    let fixed: DataObject = {};
    try {
      if (source === 'parameter')
        workflow = parseJsonParameter(
          ctx.getNodeParameter('workflowJson', itemIndex, '{}'),
          'Workflow JSON',
        ) as DataObject;
      const rows = collectionList<DataObject>(ctx.getNodeParameter('fields', itemIndex, {}), 'values');
      for (const row of rows) {
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        if (RESERVED.has(name)) throw new Error(`"${name}" is not allowed as a workflow value name`);
        fixed = { ...fixed, [name]: coerce(name, String(row.type ?? 'string'), row.value) as never };
      }
    } catch (error) {
      throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex });
    }
    const rawId = ctx.getNodeParameter('workflowId', itemIndex, '') as unknown;
    const workflowId = String((isResourceLocatorValue(rawId) ? rawId.value : rawId) ?? '').trim();
    if (source === 'database' && !workflowId)
      throw new NodeOperationError(ctx.getNode(), 'Select a workflow', { itemIndex });

    const retriever: AiRetriever = {
      kind: 'retriever',
      async retrieve(query) {
        try {
          const result = await ctx.executeWorkflow(
            source === 'parameter'
              ? { source: 'parameter', workflow: workflow as never }
              : { source: 'database', workflowId },
            [{ json: { ...fixed, query } }],
          );
          const items = result.data?.[0] ?? [];
          const documents: AiDocument[] = items.map((item, index) => ({
            pageContent: `### ${index + 1}. Context data:\n${formatJson(item.json)}`,
            metadata: {
              source: 'workflow',
              workflowSource: source,
              workflowId,
              itemIndex: index,
              executionId: result.executionId,
            },
          }));
          ctx.logSubNodeRun({ query }, { documents: documents.length });
          return documents;
        } catch (error) {
          ctx.logSubNodeRun({ query }, {}, error instanceof Error ? error : new Error(errorMessage(error)));
          throw error;
        }
      },
    };
    return { response: retriever };
  },
  methods: { listSearch: { searchWorkflows } },
};
