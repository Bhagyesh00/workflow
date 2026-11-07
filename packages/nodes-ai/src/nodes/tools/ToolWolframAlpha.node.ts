/** Wolfram|Alpha tool: answers from the Wolfram|Alpha LLM API. Stub: L25 fills it. */
import type { NodeType } from '@workflow/workflow';

export const ToolWolframAlphaNode: NodeType = {
  description: {
    name: 'ai.toolWolframAlpha',
    displayName: 'Wolfram|Alpha',
    description: 'Answers math, science and data questions with Wolfram|Alpha',
    icon: 'simple:wolfram',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Wolfram|Alpha' },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],
    categories: ['AI', 'Tools'],
    credentials: [{ name: 'wolframAlphaApi', required: true }],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L25)');
  },
};
