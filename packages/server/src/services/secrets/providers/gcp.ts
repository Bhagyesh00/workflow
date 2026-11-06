/** GCP Secret Manager (P4-08). Stub until L11: settings form and client. */
import { ApiError } from '../../../http/errors';
import type { SecretProviderType } from '../types';

export const gcpSecretProviderType: SecretProviderType = {
  name: 'gcpSecretsManager',
  displayName: 'GCP Secret Manager',
  properties: [],
  create() {
    throw new ApiError(501, 'not_built', 'not built');
  },
};
