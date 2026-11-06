/** Azure Key Vault (P4-08). Stub until L11: settings form and client. */
import { ApiError } from '../../../http/errors';
import type { SecretProviderType } from '../types';

export const azureSecretProviderType: SecretProviderType = {
  name: 'azureKeyVault',
  displayName: 'Azure Key Vault',
  properties: [],
  create() {
    throw new ApiError(501, 'not_built', 'not built');
  },
};
