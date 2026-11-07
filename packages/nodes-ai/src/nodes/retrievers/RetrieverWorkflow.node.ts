/** Workflow Retriever (stub, filled by L17): runs a sub-workflow and returns its output items as documents. */
import type { NodeType } from '@workflow/workflow';

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
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L17)');
  },
};
