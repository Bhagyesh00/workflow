/** Stub: final name and display name; L20 writes the fields. */
import type { CredentialType } from '@workflow/workflow';

export const mqtt: CredentialType = {
  name: 'mqtt',
  displayName: 'MQTT',
  // sends no HTTP requests with the credential: no "Allowed HTTP Request Domains" fields
  hideDomainRestrictionFields: true,
  // one final field until the lane: descriptions.test.ts wants every credential type to have one
  properties: [{ displayName: 'Host', name: 'host', type: 'string', default: '' }],
};
