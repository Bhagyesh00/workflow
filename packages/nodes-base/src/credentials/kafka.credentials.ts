/** Stub: final name and display name; L18 writes the fields. */
import type { CredentialType } from '@workflow/workflow';

export const kafka: CredentialType = {
  name: 'kafka',
  displayName: 'Kafka',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  // one final field until the lane: descriptions.test.ts wants every credential type to have one
  properties: [{ displayName: 'Brokers', name: 'brokers', type: 'string', default: '' }],
};

export const schemaRegistryApi: CredentialType = {
  name: 'schemaRegistryApi',
  displayName: 'Schema Registry',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  // one final field until the lane: descriptions.test.ts wants every credential type to have one
  properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '' }],
};
