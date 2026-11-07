/** Mistral Cloud Chat Model sub-node. Stub: L15 fills it. */
import type { NodeType } from '@workflow/workflow';
import { modelDescription } from './model-options';

export const LmChatMistralCloudNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatMistralCloud',
      displayName: 'Mistral Cloud Chat Model',
      description: 'Mistral and Magistral models through the Mistral API',
      icon: 'simple:mistralai',
      alias: ['mistral', 'magistral', 'llm'],
      credential: 'mistralCloudApi',
      defaultsName: 'Mistral Cloud Chat Model',
    },
    [],
  ),
  async supplyData() {
    throw new Error('not implemented (L15)');
  },
};
