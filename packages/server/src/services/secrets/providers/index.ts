/** The six provider types (P4-08). Final: L11 fills each file, not this list. */
import type { SecretProviderType } from '../types';
import { awsSecretProviderType } from './aws';
import { azureSecretProviderType } from './azure';
import { gcpSecretProviderType } from './gcp';
import { infisicalSecretProviderType } from './infisical';
import { onePasswordSecretProviderType } from './one-password';
import { vaultSecretProviderType } from './vault';

export const SECRET_PROVIDER_TYPES: SecretProviderType[] = [
  awsSecretProviderType,
  gcpSecretProviderType,
  azureSecretProviderType,
  vaultSecretProviderType,
  onePasswordSecretProviderType,
  infisicalSecretProviderType,
];
