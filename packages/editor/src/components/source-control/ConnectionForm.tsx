/**
 * P6-76 (L6): the connect form of Settings > Environments: connection type (SSH or HTTPS), repository URL,
 * key type, the public key with copy and regenerate, the HTTPS user and token (write-only), Connect.
 */
import type { ReactNode } from 'react';
import type { SourceControlPreferences } from '../../api/types';

export interface ConnectionFormProps {
  /** GET /source-control/preferences (the public key, key type and last URL, while not connected) */
  preferences: SourceControlPreferences;
  /** the answer of a connect that listed the branches */
  onConnected(preferences: SourceControlPreferences): void;
}

/** stub (L6): renders nothing until L6 draws it */
export function ConnectionForm(_props: ConnectionFormProps): ReactNode {
  return null;
}
