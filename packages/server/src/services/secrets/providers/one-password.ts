/** 1Password Connect (P4-08). Stub until L11: settings form and client. */
import { ApiError } from '../../../http/errors';
import type { SecretProviderType } from '../types';

export const onePasswordSecretProviderType: SecretProviderType = {
  name: 'onepassword',
  displayName: '1Password Connect',
  properties: [],
  create() {
    throw new ApiError(501, 'not_built', 'not built');
  },
};
