/** Stub of Data Table: final name and description; L5 (P4-04) builds it. */
import type { NodeType } from '@workflow/workflow';

export const DataTableNode: NodeType = {
  description: {
    name: 'core.dataTable',
    displayName: 'Data Table',
    description:
      'Insert, get, update, upsert and delete rows, and create, list, rename, clear and delete tables',
    icon: 'lucide:table',
    iconColor: '#2277cc',
    group: ['input', 'transform'],
    version: 1,
    defaults: { name: 'Data Table' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data & Storage'],
    // n8n's codex list (it repeats "table"; once is enough here)
    alias: [
      'data',
      'table',
      'knowledge',
      'data table',
      'sheet',
      'database',
      'data base',
      'mysql',
      'postgres',
      'postgresql',
      'airtable',
      'supabase',
      'noco',
      'notion',
    ],
    usableAsTool: true,
    properties: [],
  },

  async execute() {
    throw new Error('Not built yet');
  },
};
