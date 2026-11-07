/** Model Selector sub-node: picks one of its connected chat models per item. Stub: L8 fills it. */
import type { NodeType } from '@workflow/workflow';

export const ModelSelectorNode: NodeType = {
  description: {
    name: 'ai.modelSelector',
    displayName: 'Model Selector',
    description: 'Chooses one of the connected chat models by rules on the current item',
    icon: 'lucide:shuffle',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Model Selector' },
    inputs: `={{ Array.from({ length: Math.min(10, Math.max(2, Number($parameter.numberInputs ?? 2))) }, (_, i) => ({ type: 'ai_languageModel', displayName: 'Model ' + (i + 1), required: true, maxConnections: 1 })) }}`,
    outputs: ['ai_languageModel'],
    outputNames: ['Model'],
    categories: ['AI', 'Language Models'],
    alias: ['router', 'switch', 'fallback', 'llm'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L8)');
  },
};
