/**
 * Google Vertex AI credential. Stub: L14 fills the properties and `authenticate`. No `test`: the node
 * tests it through `methods.credentialTest`, as n8n.
 */
import type { CredentialType } from '@workflow/workflow';

export const googleVertexAiApi: CredentialType = {
  name: 'googleVertexAiApi',
  displayName: 'Google Vertex AI',
  icon: 'simple:googlecloud',
  properties: [],
  authenticate: async () => {
    throw new Error('not implemented (L14)');
  },
};
