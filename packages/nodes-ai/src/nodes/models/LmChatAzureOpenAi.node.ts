/** Microsoft Foundry Chat Model sub-node. Stub: L13 fills it. */
import type { NodeType } from '@workflow/workflow';
import { modelDescription } from './model-options';

export const LmChatAzureOpenAiNode: NodeType = {
  description: {
    ...modelDescription(
      {
        name: 'ai.lmChatAzureOpenAi',
        displayName: 'Microsoft Foundry Chat Model',
        description: 'Chat deployments on Microsoft Foundry and Azure OpenAI',
        icon: 'simple:microsoftazure',
        alias: ['azure', 'azure openai', 'foundry', 'microsoft', 'llm'],
        credential: 'azureOpenAiApi',
        defaultsName: 'Microsoft Foundry Chat Model',
      },
      [],
    ),
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
  },
  async supplyData() {
    throw new Error('not implemented (L13)');
  },
};
