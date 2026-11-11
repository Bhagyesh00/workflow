/**
 * P6-76 (L6): the demo's Git environment routes, the REST paths of the server's routes/source-control.ts and
 * routes/source-control-sync.ts. There is no real remote: a push keeps a copy of each pushed workflow (and the
 * names of pushed credential stubs) in memory, so the status lists what changed since, the remote diff has
 * something to compare with, and a pull brings in a canned remote change besides the conflicts. Rules as the
 * server: `sourceControl:manage` for the connection, no secret ever comes back (a token is dropped, the public
 * key is the only key shown), a protected branch refuses a push, a pull with a conflict is a 409 until forced,
 * and PATCH `/source-control/preferences` with `branchReadOnly` flips `backend.setDemoProtected`, which GET
 * `/settings` answers as `sourceControl.readOnly`. State is per workspace and lives in the registering backend.
 */
import { SOURCE_CONTROL_DEFAULTS, type WorkflowDefinition } from '@workflow/workflow';
import type {
  PullResult,
  PushResult,
  SourceControlledFile,
  SourceControlledFileType,
  SourceControlPreferences,
} from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { copy, HttpError, now } from './mock-http';

const BRANCHES = ['main', 'production', 'staging'];
const SCP_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the rule
const BAD_URL_CHARS = /[\u0000-\u001f\u007f\s]/;

/** what a pull brings in until it has run once: one new workflow and one deletion */
const INCOMING_CREATED = { id: '5e0c2f6a-1b7d-4c1e-9a53-0f2d8b6a7c11', name: 'Remote onboarding flow' };
const INCOMING_DELETED = { id: '9b4d7e21-6a3f-4d58-8c02-3e1f5a9d4b72', name: 'Retired report flow' };

interface RemoteCopy {
  definition: WorkflowDefinition;
  versionId: string;
}

interface TenantState {
  connected: boolean;
  connectionType: 'ssh' | 'https';
  repositoryUrl?: string;
  branchName: string;
  branchColor: string;
  httpsUsername?: string;
  keyGeneratorType: 'ed25519' | 'rsa';
  keyCounter: number;
  remoteWorkflows: Map<string, RemoteCopy>;
  remoteCredentials: Set<string>;
  pulledIncoming: boolean;
}

const bad = (message: string) => new HttpError(400, 'invalid_body', message);

/** the server's remote URL rules, in short: https, http, ssh and `user@host:path`; nothing else, no password inside */
function checkRepositoryUrl(url: string, hasToken: boolean): void {
  const text = url.trim();
  const invalid = bad('The repository URL is not valid. Use https://, ssh:// or user@host:path.');
  if (!text || BAD_URL_CHARS.test(text) || text.startsWith('-') || text.includes('::')) throw invalid;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw invalid;
    }
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) throw invalid;
    if (parsed.password || parsed.username.includes(':'))
      throw bad('Remove the password from the repository URL.');
    if (parsed.protocol === 'http:' && hasToken) throw bad('An access token is never sent over plain http.');
    return;
  }
  if (!SCP_URL.test(text)) throw invalid;
}

export function registerSourceControlRoutes(backend: MockBackend): void {
  const byTenant = new Map<string, TenantState>();
  const freshState = (keyGeneratorType: 'ed25519' | 'rsa', keyCounter: number): TenantState => ({
    connected: false,
    connectionType: 'ssh',
    branchName: SOURCE_CONTROL_DEFAULTS.branchName,
    branchColor: SOURCE_CONTROL_DEFAULTS.branchColor,
    keyGeneratorType,
    keyCounter,
    remoteWorkflows: new Map(),
    remoteCredentials: new Set(),
    pulledIncoming: false,
  });
  const stateOf = (tenantId: string): TenantState => {
    let state = byTenant.get(tenantId);
    if (!state) {
      state = freshState('ed25519', 1);
      byTenant.set(tenantId, state);
    }
    return state;
  };

  const publicKeyOf = (state: TenantState): string =>
    state.keyGeneratorType === 'rsa'
      ? `ssh-rsa AAAAB3NzaC1yc2EDemoKey${String(state.keyCounter).padStart(6, '0')} workflow-demo`
      : `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAADemoKey${String(state.keyCounter).padStart(6, '0')} workflow-demo`;

  const connectedState = (): { tenantId: string; state: TenantState } => {
    const { tenant } = backend.auth();
    const state = stateOf(tenant.id);
    if (!state.connected) throw bad('Source control is not connected');
    return { tenantId: tenant.id, state };
  };

  /** the preferences as the server answers them: no secret, and only `sourceControl:manage` sees the key */
  const preferencesOf = (tenantId: string, manage: boolean): SourceControlPreferences => {
    const state = stateOf(tenantId);
    const base: SourceControlPreferences = {
      connected: state.connected,
      branchName: state.branchName,
      branchReadOnly: backend.isDemoProtected(),
      branchColor: state.branchColor,
    };
    if (!manage) return base;
    return {
      ...base,
      connectionType: state.connectionType,
      keyGeneratorType: state.keyGeneratorType,
      ...(state.repositoryUrl ? { repositoryUrl: state.repositoryUrl } : {}),
      ...(state.connectionType === 'ssh' ? { publicKey: publicKeyOf(state) } : {}),
      ...(state.httpsUsername ? { httpsUsername: state.httpsUsername } : {}),
    };
  };

  const canManage = (): boolean => {
    try {
      backend.requireScope('sourceControl:manage');
      return true;
    } catch {
      return false;
    }
  };

  const canPushGlobally = (): boolean => {
    try {
      backend.requireScope('sourceControl:push');
      return true;
    } catch {
      return false;
    }
  };

  /** the workflows the caller may push: a workspace role with the scope, or the project role on its project */
  const pushableWorkflows = (tenantId: string): StoredWorkflow[] => {
    const global = canPushGlobally();
    return backend.workflows.filter((wf) => {
      if (wf.tenantId !== tenantId || wf.isArchived) return false;
      if (global) return true;
      const project = backend.projects.find((p) => p.id === wf.projectId);
      return project ? backend.projectScopes(project).includes('sourceControl:push') : false;
    });
  };

  const definitionOf = (wf: StoredWorkflow): WorkflowDefinition => ({
    name: wf.name,
    nodes: copy(wf.nodes),
    connections: copy(wf.connections),
    settings: copy(wf.settings ?? {}),
  });

  const row = (
    type: SourceControlledFileType,
    id: string,
    name: string,
    status: SourceControlledFile['status'],
    extra: Partial<SourceControlledFile> = {},
  ): SourceControlledFile => ({
    file: `${type === 'workflow' ? 'workflows' : 'credential_stubs'}/${id}.json`,
    id,
    name,
    type,
    status,
    location: 'local',
    conflict: false,
    updatedAt: now(),
    ...extra,
  });

  const pushStatus = (tenantId: string, state: TenantState): SourceControlledFile[] => {
    const files: SourceControlledFile[] = [];
    for (const wf of pushableWorkflows(tenantId)) {
      const remote = state.remoteWorkflows.get(wf.id);
      if (!remote) files.push(row('workflow', wf.id, wf.name, 'new', { updatedAt: wf.updatedAt }));
      else if (remote.versionId !== wf.versionId)
        files.push(row('workflow', wf.id, wf.name, 'modified', { updatedAt: wf.updatedAt }));
    }
    if (canPushGlobally())
      for (const c of backend.credentials)
        if (c.tenantId === tenantId && !state.remoteCredentials.has(c.id))
          files.push(row('credential', c.id, c.name, 'new', { updatedAt: c.updatedAt }));
    return files;
  };

  /** every modified file is a conflict (n8n's rule); the canned remote change comes until the first pull */
  const pullStatus = (tenantId: string, state: TenantState): SourceControlledFile[] => {
    const files: SourceControlledFile[] = [];
    for (const wf of backend.workflows) {
      if (wf.tenantId !== tenantId) continue;
      const remote = state.remoteWorkflows.get(wf.id);
      if (remote && remote.versionId !== wf.versionId)
        files.push(
          row('workflow', wf.id, wf.name, 'modified', {
            location: 'remote',
            conflict: true,
            updatedAt: wf.updatedAt,
          }),
        );
    }
    if (!state.pulledIncoming) {
      files.push(
        row('workflow', INCOMING_CREATED.id, INCOMING_CREATED.name, 'created', { location: 'remote' }),
      );
      files.push(
        row('workflow', INCOMING_DELETED.id, INCOMING_DELETED.name, 'deleted', { location: 'remote' }),
      );
    }
    return files;
  };

  backend.on('GET', '/source-control/preferences', () => {
    const { tenant } = backend.auth();
    return preferencesOf(tenant.id, canManage());
  });

  backend.on('POST', '/source-control/preferences', ({ body }) => {
    const { tenant } = backend.requireScope('sourceControl:manage');
    const state = stateOf(tenant.id);
    const url = typeof body.repositoryUrl === 'string' ? body.repositoryUrl.trim() : '';
    const type =
      body.connectionType === 'https' || body.connectionType === 'ssh'
        ? body.connectionType
        : /^https?:\/\//i.test(url)
          ? 'https'
          : 'ssh';
    const token = typeof body.httpsPassword === 'string' ? body.httpsPassword : '';
    checkRepositoryUrl(url, type === 'https' && token !== '');
    if (type === 'https') {
      if (!/^https?:\/\//i.test(url)) throw bad('An HTTPS connection needs an https:// repository URL.');
      // a plain http:// remote takes no token at all (it is never sent there); https:// needs one
      if (!token && /^https:\/\//i.test(url))
        throw bad('An access token is required for an HTTPS connection.');
    } else if (/^https?:\/\//i.test(url)) {
      throw bad('An SSH connection needs an ssh:// URL or user@host:path.');
    }
    const branch =
      typeof body.branchName === 'string' && body.branchName ? body.branchName : state.branchName;
    if (!BRANCHES.includes(branch)) throw bad(`Branch ${branch} was not found in the repository`);
    if (body.branchColor !== undefined && !COLOR.test(String(body.branchColor)))
      throw bad('The branch colour must look like #5296D6');
    const keyType = body.keyGeneratorType;
    if (keyType === 'rsa' || keyType === 'ed25519') {
      if (state.keyGeneratorType !== keyType) state.keyCounter += 1;
      state.keyGeneratorType = keyType;
    }
    state.connected = true;
    state.connectionType = type;
    state.repositoryUrl = url;
    state.branchName = branch;
    // the token is used for the connection check and dropped: it is never stored or answered
    state.httpsUsername =
      type === 'https' && typeof body.httpsUsername === 'string' ? body.httpsUsername : undefined;
    if (typeof body.branchColor === 'string') state.branchColor = body.branchColor;
    if (typeof body.branchReadOnly === 'boolean') backend.setDemoProtected(body.branchReadOnly);
    return preferencesOf(tenant.id, true);
  });

  backend.on('PATCH', '/source-control/preferences', ({ body }) => {
    const { tenant } = backend.requireScope('sourceControl:manage');
    const state = stateOf(tenant.id);
    if (!state.connected) throw bad('Source control is not connected');
    if (body.branchName !== undefined) {
      if (typeof body.branchName !== 'string' || !BRANCHES.includes(body.branchName))
        throw bad(`Branch ${String(body.branchName)} was not found in the repository`);
      state.branchName = body.branchName;
    }
    if (body.branchColor !== undefined) {
      if (typeof body.branchColor !== 'string' || !COLOR.test(body.branchColor))
        throw bad('The branch colour must look like #5296D6');
      state.branchColor = body.branchColor;
    }
    if (body.branchReadOnly !== undefined) {
      if (typeof body.branchReadOnly !== 'boolean') throw bad('branchReadOnly must be true or false');
      backend.setDemoProtected(body.branchReadOnly);
    }
    return preferencesOf(tenant.id, true);
  });

  backend.on('POST', '/source-control/disconnect', ({ body }) => {
    const { tenant } = backend.requireScope('sourceControl:manage');
    const state = stateOf(tenant.id);
    const keepKeyPair = body.keepKeyPair === true;
    byTenant.set(
      tenant.id,
      freshState(state.keyGeneratorType, keepKeyPair ? state.keyCounter : state.keyCounter + 1),
    );
    // a disconnect clears the protected switch, as the server
    backend.setDemoProtected(false);
    return preferencesOf(tenant.id, true);
  });

  backend.on('GET', '/source-control/get-branches', () => {
    const { tenant } = backend.requireScope('sourceControl:manage');
    const state = stateOf(tenant.id);
    if (!state.connected) throw bad('Source control is not connected');
    return { branches: [...BRANCHES], currentBranch: state.branchName };
  });

  backend.on('POST', '/source-control/generate-key-pair', ({ body }) => {
    const { tenant } = backend.requireScope('sourceControl:manage');
    const state = stateOf(tenant.id);
    const requested = body.keyGeneratorType;
    if (requested !== undefined && requested !== 'ed25519' && requested !== 'rsa')
      throw bad('keyGeneratorType must be ed25519 or rsa');
    if (requested !== undefined) state.keyGeneratorType = requested;
    state.keyCounter += 1;
    return preferencesOf(tenant.id, true);
  });

  const direction = (query: Record<string, string>): 'push' | 'pull' => {
    if (query.direction !== 'push' && query.direction !== 'pull') throw bad('direction must be push or pull');
    return query.direction;
  };

  const status = ({ query }: { query: Record<string, string> }) => {
    const dir = direction(query);
    if (dir === 'pull') backend.requireScope('sourceControl:pull');
    else backend.requireScopeAnywhere('sourceControl:push');
    const { tenantId, state } = connectedState();
    return dir === 'push' ? pushStatus(tenantId, state) : pullStatus(tenantId, state);
  };
  backend.on('GET', '/source-control/get-status', status);
  backend.on('GET', '/source-control/status', status);

  backend.on('POST', '/source-control/push-workfolder', ({ body }) => {
    backend.requireScopeAnywhere('sourceControl:push');
    const { tenantId, state } = connectedState();
    if (backend.isDemoProtected()) throw bad('Cannot push onto read-only branch.');
    const picked = body.fileNames;
    if (!Array.isArray(picked) || picked.length === 0) throw bad('fileNames must name at least one file');
    const message = typeof body.commitMessage === 'string' ? body.commitMessage.trim() : '';
    if (!message || message.length > 1000) throw bad('commitMessage must be 1 to 1000 characters');
    const changed = pushStatus(tenantId, state);
    const files: SourceControlledFile[] = [];
    for (const name of picked as Array<{ id?: unknown; type?: unknown }>) {
      // the paths come from the server's own status; the client only names (id, type)
      const found = changed.find((f) => f.id === name.id && f.type === name.type);
      if (!found) throw bad('A picked file is not part of the changes');
      files.push({ ...found, pushed: true });
    }
    for (const file of files) {
      if (file.type === 'workflow') {
        const wf = backend.workflows.find((w) => w.id === file.id);
        if (wf) state.remoteWorkflows.set(wf.id, { definition: definitionOf(wf), versionId: wf.versionId });
      } else if (file.type === 'credential') state.remoteCredentials.add(file.id);
    }
    const result: PushResult = { files, commit: newId().replace(/-/g, '').padEnd(40, '0').slice(0, 40) };
    return result;
  });

  backend.on('POST', '/source-control/pull-workfolder', ({ body }) => {
    backend.requireScope('sourceControl:pull');
    const { tenantId, state } = connectedState();
    const files = pullStatus(tenantId, state);
    const force = body.force === true;
    if (!force && files.some((f) => f.conflict))
      throw new HttpError(409, 'conflict', 'There are local changes that a pull would overwrite', { files });
    for (const file of files) {
      if (file.status === 'created' && file.id === INCOMING_CREATED.id) {
        const trigger = {
          id: 't1',
          name: 'Start',
          type: 'core.manualTrigger',
          typeVersion: 1,
          position: [0, 0] as [number, number],
          parameters: {},
        };
        const wf = backend.seedWorkflow({ id: file.id, name: file.name, nodes: [trigger] });
        state.remoteWorkflows.set(wf.id, {
          definition: { name: wf.name, nodes: copy(wf.nodes), connections: {}, settings: {} },
          versionId: wf.versionId,
        });
      } else if (file.status === 'modified') {
        // forced: the remote copy replaces the local workflow
        const wf = backend.workflows.find((w) => w.id === file.id);
        const remote = state.remoteWorkflows.get(file.id);
        if (wf && remote) {
          wf.name = remote.definition.name;
          wf.nodes = copy(remote.definition.nodes);
          wf.connections = copy(remote.definition.connections);
          wf.versionId = newId();
          wf.updatedAt = now();
          remote.versionId = wf.versionId;
        }
      }
    }
    state.pulledIncoming = true;
    const result: PullResult = { files, publishingErrors: [], contentImportPolicy: [] };
    return result;
  });

  backend.on('GET', '/source-control/remote-content/:type/:id', ({ params }) => {
    backend.requireScopeAnywhere('sourceControl:push');
    const { state } = connectedState();
    const found = params[0] === 'workflow' ? state.remoteWorkflows.get(params[1]) : undefined;
    if (!found) throw new HttpError(404, 'not_found', 'Workflow not found in the remote repository');
    // like the server: the answer names the local workflow id
    return { ...copy(found.definition), id: params[1] };
  });
}
