/**
 * Microsoft Foundry and Azure OpenAI credentials. Stubs: L13 fills the properties and `authenticate`.
 * No `test`, as n8n.
 */
import type { CredentialType } from '@workflow/workflow';

export const azureOpenAiApi: CredentialType = {
  name: 'azureOpenAiApi',
  displayName: 'Microsoft Foundry and Azure OpenAI',
  icon: 'simple:microsoftazure',
  properties: [],
  authenticate: async () => {
    throw new Error('not implemented (L13)');
  },
};

export const azureEntraCognitiveServicesOAuth2Api: CredentialType = {
  name: 'azureEntraCognitiveServicesOAuth2Api',
  displayName: 'Microsoft Foundry and Azure OpenAI (Entra ID)',
  icon: 'simple:microsoftazure',
  properties: [],
  authenticate: async () => {
    throw new Error('not implemented (L13)');
  },
};
