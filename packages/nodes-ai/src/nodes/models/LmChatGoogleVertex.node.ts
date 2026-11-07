/** Google Vertex Chat Model sub-node. Stub: L14 fills it. */
import type { NodeType } from '@workflow/workflow';
import { modelDescription } from './model-options';

export const LmChatGoogleVertexNode: NodeType = {
  description: {
    ...modelDescription(
      {
        name: 'ai.lmChatGoogleVertex',
        displayName: 'Google Vertex Chat Model',
        description: 'Gemini models on Google Cloud Vertex AI',
        icon: 'simple:googlecloud',
        alias: ['vertex', 'google', 'gemini', 'llm'],
        credential: 'googleApi',
        defaultsName: 'Google Vertex Chat Model',
      },
      [],
    ),
    credentials: [
      { name: 'googleApi', required: true, displayOptions: { show: { authentication: ['googleApi'] } } },
      {
        name: 'googleVertexAiApi',
        required: true,
        displayOptions: { show: { authentication: ['googleVertexAiApi'] } },
      },
    ],
  },
  async supplyData() {
    throw new Error('not implemented (L14)');
  },
};
