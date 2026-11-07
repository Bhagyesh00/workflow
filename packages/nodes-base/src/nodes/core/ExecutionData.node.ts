/**
 * Execution Data (P5-61, n8n "Execution Data"): saves key and value pairs of each item as the execution's
 * highlighted data (`ctx.setCustomData`, the engine's caps), so executions can be filtered by them, and
 * passes its input through. Stub from C0: lane L6 writes it.
 */
import type { Item, NodeType } from '@workflow/workflow';

/** the engine's caps (`setCustomData`): ten keys, keys cut to 50 characters, values to 255 */
const MAX_KEYS = 10;
const MAX_KEY_LENGTH = 50;
const MAX_VALUE_LENGTH = 255;

export const ExecutionDataNode: NodeType = {
  description: {
    name: 'core.executionData',
    displayName: 'Execution Data',
    description: 'Saves data on the execution so you can filter executions by it',
    icon: 'lucide:highlighter',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Execution Data' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['highlighted data', 'custom data', 'execution data', 'save data', 'tag'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'save',
        noDataExpression: true,
        options: [{ name: 'Save Highlighted Data', value: 'save', action: 'Save highlighted data' }],
      },
      {
        displayName: 'Data to Save',
        name: 'dataToSave',
        type: 'fixedCollection',
        default: { values: [{ key: '', value: '' }] },
        placeholder: 'Add item',
        description: 'Keys and values saved on the execution. Up to 10 keys; keys are cut to 50 characters and values to 255.',
        typeOptions: { multipleValues: true },
        displayOptions: { show: { operation: ['save'] } },
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              { displayName: 'Key', name: 'key', type: 'string', default: '', placeholder: 'orderId' },
              { displayName: 'Value', name: 'value', type: 'string', default: '', placeholder: '1042' },
            ],
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const skipped = new Set<string>();
    const cut = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const rows = ctx.getNodeParameter('dataToSave.values', i, []) as Array<{ key?: unknown; value?: unknown }>;
      for (const row of Array.isArray(rows) ? rows : []) {
        const key = String(row?.key ?? '').trim();
        if (!key) continue;
        const value = row.value === undefined || row.value === null ? '' : String(row.value);
        try {
          ctx.setCustomData(key, value);
        } catch {
          skipped.add(key.slice(0, MAX_KEY_LENGTH));
          continue;
        }
        if (key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) cut.add(key.slice(0, MAX_KEY_LENGTH));
      }
    }
    ctx.addExecutionHints(
      ...[...skipped].map((key) => ({
        message: `The key '${key}' was not saved: an execution keeps at most ${MAX_KEYS} keys of highlighted data`,
        level: 'warning' as const,
      })),
      ...[...cut].map((key) => ({
        message: `The key '${key}' was cut: keys keep ${MAX_KEY_LENGTH} characters and values ${MAX_VALUE_LENGTH}`,
        level: 'info' as const,
      })),
    );
    const out: Item[] = items.map((item, i) => ({ ...item, pairedItem: { item: i } }));
    return [out];
  },
};
