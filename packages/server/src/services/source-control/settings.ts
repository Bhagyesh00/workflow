/**
 * P6-73 (L2): the workspace's Git connection, as n8n's source control preferences. Connect takes a repository URL
 * (`parseRemoteUrl`), an SSH key pair or an HTTPS user and token, a branch and `initRepo`, and lists the branches to
 * prove it (on failure it disconnects and keeps the key). The private key and the token are stored only through
 * `ctx.cipher.encrypt` (binding `{ tenantId, credentialId: 'sourceControl:<tenantId>' }`) and decrypted only inside
 * `withRemote` for one operation; never returned, logged or audited. GET narrows by scope: the full answer with
 * `publicKey` for `sourceControl:manage`, connected, branch, colour and read-only for a user with pushable projects,
 * only `branchReadOnly` for others. `branchReadOnly` calls `setReadOnly` (L7), which needs no connection. 412
 * `source_control_not_connected` where n8n's middleware gives it.
 */
import {
  SOURCE_CONTROL_DEFAULTS,
  SOURCE_CONTROL_LIMITS,
  type SourceControlPreferences,
} from '@workflow/workflow';
import { utils as sshUtils } from 'ssh2';
import type { ServiceDeps } from '../../context';
import type { SourceControlSettingsRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import type { SourceControlSettingsValues } from '../../repositories/source-control';
import { isProtected, setReadOnly } from '../protected';
import { type GitDeps, type GitRemote, GitRemoteError, withRepo } from './git-repo';
import { pushableProjects } from './scope';
import { parseRemoteUrl } from './url';

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

type KeyType = 'ed25519' | 'rsa';

/** n8n: a branch name must start with a letter or a digit (git's own rules are checked again at fetch and push) */
const BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const RSA_BITS = 4096;

/** the fields a PATCH may change; any other field is refused, never ignored */
const PATCH_FIELDS = new Set(['branchName', 'branchColor', 'branchReadOnly']);

const bad = (message: string) => ApiError.badRequest(message);

export class SourceControlSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  private get repo() {
    return this.deps.repos.sourceControl;
  }

  private gitDeps(): GitDeps {
    return { http: this.deps.context().http, limits: SOURCE_CONTROL_LIMITS };
  }

  private binding(tenantId: string) {
    return { tenantId, credentialId: `sourceControl:${tenantId}` };
  }

  private async audit(
    auth: AuthContext,
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.deps.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: `source_control.${action}`,
      resourceType: 'source_control',
      resourceId: auth.tenant.id,
      metadata,
    });
  }

  /** a new key pair of `type`, the private half already encrypted for the row */
  private generateKeys(tenantId: string, type: KeyType): SourceControlSettingsValues {
    const pair =
      type === 'rsa'
        ? sshUtils.generateKeyPairSync('rsa', { bits: RSA_BITS, comment: 'workflow deploy key' })
        : sshUtils.generateKeyPairSync('ed25519', { comment: 'workflow deploy key' });
    return {
      keyType: type,
      publicKey: pair.public.trim(),
      privateKeyEnc: this.deps.context().cipher.encrypt(pair.private, this.binding(tenantId)),
    };
  }

  /** the row with a key pair: makes the first one (the configured type) when the workspace has none yet */
  private async withKeyPair(tenantId: string, row: SourceControlSettingsRow | undefined) {
    if (row?.publicKey && row.privateKeyEnc) return row;
    const type = this.deps.config.sourceControl.defaultKeyType;
    return this.repo.upsert(tenantId, this.generateKeys(tenantId, type));
  }

  /** the answer for `sourceControl:manage`: everything but the secrets */
  private async fullAnswer(tenantId: string): Promise<SourceControlPreferences> {
    const row = await this.withKeyPair(tenantId, await this.repo.get(tenantId));
    return this.answerOf(tenantId, row, true);
  }

  private async answerOf(
    tenantId: string,
    row: SourceControlSettingsRow | undefined,
    full: boolean,
  ): Promise<SourceControlPreferences> {
    const tenant = await this.deps.repos.tenants.get(tenantId);
    const base: SourceControlPreferences = {
      connected: row?.connected === true,
      branchName: row?.branchName ?? SOURCE_CONTROL_DEFAULTS.branchName,
      branchReadOnly: isProtected(tenant?.settings),
      branchColor: row?.branchColor ?? SOURCE_CONTROL_DEFAULTS.branchColor,
    };
    if (!full) return base;
    return {
      ...base,
      connectionType: row?.connectionType ?? 'ssh',
      keyGeneratorType: row?.keyType ?? this.deps.config.sourceControl.defaultKeyType,
      ...(row?.repositoryUrl ? { repositoryUrl: row.repositoryUrl } : {}),
      ...(row?.publicKey ? { publicKey: row.publicKey } : {}),
      ...(row?.httpsUsername ? { httpsUsername: row.httpsUsername } : {}),
    };
  }

  async preferencesFor(auth: AuthContext): Promise<SourceControlPreferences> {
    const tenantId = auth.tenant.id;
    const context = this.deps.context();
    if ((await context.access.scopesForAuth(auth)).has('sourceControl:manage')) {
      return this.fullAnswer(tenantId);
    }
    const row = await this.repo.get(tenantId);
    const pushable = await pushableProjects(this.deps, auth);
    if (pushable === 'all' || pushable.size > 0) return this.answerOf(tenantId, row, false);
    // nothing to push: only the protected flag (the editor locks its screens from it)
    const answer = await this.answerOf(tenantId, undefined, false);
    return { ...answer, connected: false };
  }

  async connect(auth: AuthContext, input: SourceControlPreferencesInput): Promise<SourceControlPreferences> {
    const tenantId = auth.tenant.id;
    const fields = Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (fields.length > 0 && fields.every((key) => key === 'branchReadOnly')) {
      // n8n: the protected switch needs no connection
      await setReadOnly(this.deps, auth, input.branchReadOnly === true);
      await this.audit(auth, 'preferences_updated', { fields, readOnly: input.branchReadOnly === true });
      return this.fullAnswer(tenantId);
    }
    const row = await this.repo.get(tenantId);
    if (row?.connected) {
      throw bad('Source control is connected. Disconnect it before you change the connection.');
    }
    const url = input.repositoryUrl?.trim();
    if (!url) throw bad('A repository URL is required.');
    const parsed = parseRemoteUrl(url);
    const type = input.connectionType ?? (parsed.kind === 'ssh' ? 'ssh' : 'https');
    if (type === 'ssh' && parsed.kind !== 'ssh') {
      throw bad('An SSH connection needs an ssh:// URL or user@host:path.');
    }
    if (type === 'https' && parsed.kind === 'ssh')
      throw bad('An HTTPS connection needs an https:// repository URL.');
    const branch = input.branchName ?? row?.branchName ?? SOURCE_CONTROL_DEFAULTS.branchName;
    this.checkBranch(branch);
    const color = input.branchColor ?? row?.branchColor ?? SOURCE_CONTROL_DEFAULTS.branchColor;
    this.checkColor(color);

    const values: SourceControlSettingsValues = {
      repositoryUrl: url,
      connectionType: type,
      branchName: branch,
      branchColor: color,
      connected: false,
      hostKeyFingerprint: null,
    };
    if (type === 'ssh') {
      const wanted = input.keyGeneratorType;
      const keep = row?.publicKey && row.privateKeyEnc && (!wanted || wanted === row.keyType);
      if (!keep) {
        Object.assign(
          values,
          this.generateKeys(
            tenantId,
            wanted ?? row?.keyType ?? this.deps.config.sourceControl.defaultKeyType,
          ),
        );
      }
      values.httpsUsername = null;
      values.httpsPasswordEnc = null;
    } else {
      const token = input.httpsPassword ?? '';
      if (parsed.kind === 'http' && token) {
        throw bad('A token is never sent over plain http://. Use an https:// repository URL.');
      }
      if (parsed.kind === 'https' && !token)
        throw bad('An access token is required for an HTTPS connection.');
      values.httpsUsername = input.httpsUsername?.trim() || null;
      values.httpsPasswordEnc = token
        ? this.deps.context().cipher.encrypt(token, this.binding(tenantId))
        : null;
    }
    const saved = await this.repo.upsert(tenantId, values);

    try {
      await this.verify(saved, branch, input.initRepo === true);
      await this.repo.upsert(tenantId, { connected: true });
    } catch (error) {
      // n8n: a failed connect disconnects and keeps the key
      await this.repo.clear(tenantId, { keepKeyPair: true });
      throw error instanceof ApiError
        ? error
        : new GitRemoteError('Could not connect to the Git server.', error);
    }
    if (input.branchReadOnly !== undefined) await setReadOnly(this.deps, auth, input.branchReadOnly);
    await this.audit(auth, 'connected', {
      connectionType: type,
      branchName: branch,
      initRepo: input.initRepo === true,
    });
    return this.fullAnswer(tenantId);
  }

  /** lists the branches to prove the connection; an empty repository gets its first commit when `initRepo` */
  private verify(row: SourceControlSettingsRow, branch: string, initRepo: boolean): Promise<void> {
    return this.runRemote(row, (remote) =>
      withRepo(this.gitDeps(), remote, async (session) => {
        const branches = await session.listBranches();
        if (branches.includes(branch)) return;
        if (initRepo && branches.length === 0) {
          const commit = await session.writeCommit({
            parent: null,
            files: new Map(),
            message: 'Initial commit',
            author: { name: 'Workflow', email: 'workflow@localhost' },
          });
          await session.push(branch, commit, { force: false });
          return;
        }
        throw bad(`The branch ${branch} was not found in the repository.`);
      }),
    );
  }

  async patch(auth: AuthContext, input: SourceControlPreferencesInput): Promise<SourceControlPreferences> {
    const tenantId = auth.tenant.id;
    const fields = Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (fields.some((key) => !PATCH_FIELDS.has(key))) {
      throw bad('Only the branch, the branch colour and read-only can be changed while connected.');
    }
    const row = await this.repo.get(tenantId);
    const values: SourceControlSettingsValues = {};
    if (input.branchName !== undefined) {
      this.checkBranch(input.branchName);
      if (row?.connected && input.branchName !== row.branchName) {
        const branches = await this.withRemote(tenantId, (remote) =>
          withRepo(this.gitDeps(), remote, (session) => session.listBranches()),
        );
        if (!branches.includes(input.branchName)) {
          throw bad(`The branch ${input.branchName} was not found in the repository.`);
        }
      }
      values.branchName = input.branchName;
    }
    if (input.branchColor !== undefined) {
      this.checkColor(input.branchColor);
      values.branchColor = input.branchColor;
    }
    if (Object.keys(values).length > 0) await this.repo.upsert(tenantId, values);
    if (input.branchReadOnly !== undefined) await setReadOnly(this.deps, auth, input.branchReadOnly);
    await this.audit(auth, 'preferences_updated', {
      fields,
      ...(input.branchReadOnly !== undefined ? { readOnly: input.branchReadOnly } : {}),
    });
    return this.fullAnswer(tenantId);
  }

  async disconnect(
    auth: AuthContext,
    input: SourceControlDisconnectInput,
  ): Promise<SourceControlPreferences> {
    const tenantId = auth.tenant.id;
    const keepKeyPair = input.keepKeyPair === true;
    await this.repo.clear(tenantId, { keepKeyPair });
    // n8n (source-control.service.ee.ts:196): a disconnect also lifts the protected switch
    await setReadOnly(this.deps, auth, false);
    await this.audit(auth, 'disconnected', { keepKeyPair });
    return this.fullAnswer(tenantId);
  }

  /** `type` defaults to `config.sourceControl.defaultKeyType`; a connected workspace keeps the key its remote knows */
  async generateKeyPair(auth: AuthContext, type?: KeyType): Promise<SourceControlPreferences> {
    const tenantId = auth.tenant.id;
    const row = await this.repo.get(tenantId);
    if (row?.connected) throw bad('Disconnect source control before you generate a new key pair.');
    const keyType = type ?? this.deps.config.sourceControl.defaultKeyType;
    await this.repo.upsert(tenantId, this.generateKeys(tenantId, keyType));
    await this.audit(auth, 'key_generated', { keyType });
    return this.fullAnswer(tenantId);
  }

  async listBranches(auth: AuthContext): Promise<SourceControlBranches> {
    const tenantId = auth.tenant.id;
    const gitDeps = this.gitDeps();
    return this.withRemote(tenantId, async (remote, row) => ({
      branches: await withRepo(gitDeps, remote, (session) => session.listBranches()),
      currentBranch: row.branchName,
    }));
  }

  /** the connected row, else 412 `source_control_not_connected` */
  async requireConnected(tenantId: string): Promise<SourceControlSettingsRow> {
    const row = await this.repo.get(tenantId);
    if (!row?.connected) {
      throw new ApiError(412, 'source_control_not_connected', 'Source control is not connected.');
    }
    return row;
  }

  /** decrypts the key or token for `fn` only */
  async withRemote<T>(
    tenantId: string,
    fn: (remote: GitRemote, settings: SourceControlSettingsRow) => Promise<T>,
  ): Promise<T> {
    return this.runRemote(await this.requireConnected(tenantId), fn);
  }

  private async runRemote<T>(
    row: SourceControlSettingsRow,
    fn: (remote: GitRemote, settings: SourceControlSettingsRow) => Promise<T>,
  ): Promise<T> {
    const tenantId = row.tenantId;
    const cipher = this.deps.context().cipher;
    const url = row.repositoryUrl;
    if (!url) throw new ApiError(412, 'source_control_not_connected', 'Source control is not connected.');
    let remote: GitRemote;
    try {
      if (row.connectionType === 'ssh') {
        if (!row.privateKeyEnc) throw new Error('no key');
        remote = {
          url,
          auth: {
            kind: 'ssh',
            privateKey: cipher.decrypt<string>(row.privateKeyEnc, this.binding(tenantId)),
            hostKey: {
              fingerprint: row.hostKeyFingerprint,
              onFirstSeen: async (fingerprint) => {
                await this.repo.upsert(tenantId, { hostKeyFingerprint: fingerprint });
              },
            },
          },
        };
      } else {
        remote = {
          url,
          auth: {
            kind: 'https',
            username: row.httpsUsername ?? '',
            token: row.httpsPasswordEnc
              ? cipher.decrypt<string>(row.httpsPasswordEnc, this.binding(tenantId))
              : '',
          },
        };
      }
    } catch {
      throw bad('The stored Git credentials could not be read. Disconnect and connect again.');
    }
    return fn(remote, row);
  }

  private checkBranch(branch: string): void {
    if (branch.length > 255 || !BRANCH_NAME.test(branch)) {
      throw bad('The branch name must start with a letter or a digit.');
    }
  }

  private checkColor(color: string): void {
    if (!COLOR.test(color)) throw bad('The branch colour must look like #5296D6.');
  }
}
