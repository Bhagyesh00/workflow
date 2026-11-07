/** Embeddings Microsoft Foundry sub-node. Stub: L13 fills it. */
import type { NodeType } from '@workflow/workflow';

export const EmbeddingsAzureOpenAiNode: NodeType = {
  description: {
    name: 'ai.embeddingsAzureOpenAi',
    displayName: 'Embeddings Microsoft Foundry',
    description: 'Turns text into vectors with embedding deployments on Microsoft Foundry and Azure OpenAI',
    icon: 'simple:microsoftazure',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Microsoft Foundry' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [
      {
        name: 'azureOpenAiApi',
        required: true,
        displayOptions: { show: { authentication: ['azureOpenAiApi'] } },
      },
      {
        name: 'azureEntraCognitiveServicesOAuth2Api',
        required: true,
        displayOptions: { show: { authentication: ['azureEntraCognitiveServicesOAuth2Api'] } },
      },
    ],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'azure', 'azure openai', 'foundry'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L13)');
  },
};
