/** AWS Secrets Manager (P4-08). Stub until L11: settings form and client. */
import { ApiError } from '../../../http/errors';
import type { SecretProviderType } from '../types';

export const awsSecretProviderType: SecretProviderType = {
  name: 'awsSecretsManager',
  displayName: 'AWS Secrets Manager',
  properties: [],
  create() {
    throw new ApiError(501, 'not_built', 'not built');
  },
};
