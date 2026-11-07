/** Cohere Chat Model sub-node. Stub: L16 fills it. */
import type { NodeType } from '@workflow/workflow';
import { modelDescription } from './model-options';

export const LmChatCohereNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatCohere',
      displayName: 'Cohere Chat Model',
      description: 'Command models through the Cohere v2 chat API',
      icon: 'simple:cohere',
      alias: ['cohere', 'command', 'llm'],
      credential: 'cohereApi',
      defaultsName: 'Cohere Chat Model',
    },
    [],
  ),
  async supplyData() {
    throw new Error('not implemented (L16)');
  },
};
