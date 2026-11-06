/** Stub: final name and display name; L19 writes the fields. */
import type { CredentialType } from '@workflow/workflow';

export const rabbitmq: CredentialType = {
  name: 'rabbitmq',
  displayName: 'RabbitMQ',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  // one final field until the lane: descriptions.test.ts wants every credential type to have one
  properties: [{ displayName: 'Hostname', name: 'hostname', type: 'string', default: '' }],
};
