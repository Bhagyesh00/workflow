/**
 * P6-73 (L2): the workspace's Git connection, as n8n's source control preferences. Connect takes a repository URL
 * (`parseRemoteUrl`), an SSH key pair or an HTTPS user and token, a branch and `initRepo`, and lists the branches to
 * prove it (on failure it disconnects and keeps the key). The private key and the token are stored only through
 * `ctx.cipher.encrypt` (binding `{ tenantId, credentialId: 'sourceControl:<tenantId>' }`) and decrypted only inside
 * `withRemote` for one operation; never returned, logged or audited. GET narrows by scope: the full answer with
 * `publicKey` for `sourceControl:manage`, connected, branch, colour and read-only for a user with pushable projects,
 * only `branchReadOnly` for others. `branchReadOnly` calls `setReadOnly` (L7). 412 `source_control_not_connected`
 * where n8n's middleware gives it.
 * stub (L2): the constructor passes, every method throws.
 */
import type { SourceControlPreferences } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SourceControlSettingsRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import type { GitRemote } from './git-repo';

/** POST and PATCH `/source-control/preferences` (n8n's preferences body; every field optional on PATCH) */
export interface SourceControlPreferencesInput {
  repositoryUrl?: string;
  connectionType?: 'ssh' | 'https';
  branchName?: string;
  branchReadOnly?: boolean;
  branchColor?: string;
  /** push a first commit on an empty repository */
  initRepo?: boolean;
  keyGeneratorType?: 'ed25519' | 'rsa';
  httpsUsername?: string;
  /** the HTTPS token (write only) */
  httpsPassword?: string;
}

/** POST `/source-control/disconnect` */
export interface SourceControlDisconnectInput {
  keepKeyPair?: boolean;
}

/** GET `/source-control/get-branches` (n8n's answer) */
export interface SourceControlBranches {
  branches: string[];
  currentBranch: string;
}

export class SourceControlSettingsService {
  /** stub (L2): passes (the context builds it in every test) */
  constructor(readonly deps: ServiceDeps) {}

  /** stub (L2) */
  preferencesFor(_auth: AuthContext): Promise<SourceControlPreferences> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2) */
  connect(_auth: AuthContext, _input: SourceControlPreferencesInput): Promise<SourceControlPreferences> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2) */
  patch(_auth: AuthContext, _input: SourceControlPreferencesInput): Promise<SourceControlPreferences> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2) */
  disconnect(_auth: AuthContext, _input: SourceControlDisconnectInput): Promise<SourceControlPreferences> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): `type` defaults to `config.sourceControl.defaultKeyType` */
  generateKeyPair(_auth: AuthContext, _type?: 'ed25519' | 'rsa'): Promise<SourceControlPreferences> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2) */
  listBranches(_auth: AuthContext): Promise<SourceControlBranches> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): the connected row, else 412 `source_control_not_connected` */
  requireConnected(_tenantId: string): Promise<SourceControlSettingsRow> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): decrypts the key or token for `fn` only */
  withRemote<T>(
    _tenantId: string,
    _fn: (remote: GitRemote, settings: SourceControlSettingsRow) => Promise<T>,
  ): Promise<T> {
    throw new Error('not implemented (L2)');
  }
}
