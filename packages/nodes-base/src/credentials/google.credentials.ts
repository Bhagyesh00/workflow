/**
 * The Google service account credential, with the field names of n8n (`inpersonate` is its spelling).
 * Stub of the shared-contracts step: the properties are final, L1 fills `authenticate`.
 */
import type { CredentialType } from '@workflow/workflow';

export const googleApi: CredentialType = {
  name: 'googleApi',
  displayName: 'Google Service Account API',
  properties: [
    {
      displayName: 'Region',
      name: 'region',
      type: 'string',
      default: 'global',
      placeholder: 'us-central1',
    },
    {
      displayName: 'Service Account Email',
      name: 'email',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'name@project.iam.gserviceaccount.com',
    },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true, rows: 4 },
    },
    {
      displayName: 'Impersonate a User',
      name: 'inpersonate',
      type: 'boolean',
      default: false,
    },
    {
      displayName: 'Email',
      name: 'delegatedEmail',
      type: 'string',
      default: '',
      description: 'The user the service account acts for',
      displayOptions: { show: { inpersonate: [true] } },
    },
    {
      displayName: 'Scope(s)',
      name: 'scopes',
      type: 'string',
      default: '',
      description: 'Space-separated Google API scopes',
    },
  ],
  authenticate: async () => {
    throw new Error('not implemented (L1)');
  },
};
