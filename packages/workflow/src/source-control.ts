/**
 * Source control (Git) contracts shared by the server, the editor and the CLI (Phase 6 S4, P6-72).
 * Isomorphic: no node: import, the editor bundles this file.
 */

/** The kinds of file a work folder holds (n8n's names). */
export type SourceControlledFileType =
  | 'workflow'
  | 'credential'
  | 'variables'
  | 'tags'
  | 'folders'
  | 'datatable'
  | 'project';

export type SourceControlledFileStatus =
  | 'new'
  | 'modified'
  | 'deleted'
  | 'created'
  | 'renamed'
  | 'conflicted'
  | 'unknown';

/** One row of the push or pull status list (n8n's field names). */
export interface SourceControlledFile {
  file: string;
  /** The git id, which is the file name. */
  id: string;
  name: string;
  type: SourceControlledFileType;
  status: SourceControlledFileStatus;
  location: 'local' | 'remote';
  conflict: boolean;
  updatedAt: string;
  pushed?: boolean;
  isLocalPublished?: boolean;
  owner?: { type: 'personal' | 'team'; projectId: string; projectName: string };
  folderPath?: string[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);

/**
 * The only paths a work folder may hold, one fixed rule per type. Ids are lower-case UUIDs; anything else
 * (`../`, an absolute path, a nested folder, a backslash, another extension) is not a managed path.
 */
export const SOURCE_CONTROL_PATHS: Readonly<Record<SourceControlledFileType, RegExp>> = Object.freeze({
  workflow: new RegExp(`^workflows/(${UUID})\\.json$`),
  credential: new RegExp(`^credential_stubs/(${UUID})\\.json$`),
  variables: /^variable_stubs\.json$/,
  tags: /^tags\.json$/,
  folders: /^folders\.json$/,
  datatable: new RegExp(`^datatables/(${UUID})\\.json$`),
  project: new RegExp(`^projects/(${UUID})\\.json$`),
});

const FOLDER_OF: Partial<Record<SourceControlledFileType, string>> = {
  workflow: 'workflows',
  credential: 'credential_stubs',
  datatable: 'datatables',
  project: 'projects',
};

const SINGLE_FILE: Partial<Record<SourceControlledFileType, string>> = {
  variables: 'variable_stubs.json',
  tags: 'tags.json',
  folders: 'folders.json',
};

/**
 * The work folder path of a resource. The single-file types (variables, tags, folders) ignore `id`.
 * Throws when a per-resource type gets an id that is not a lower-case UUID, so no caller can build `../`.
 */
export function pathFor(type: SourceControlledFileType, id?: string): string {
  const single = SINGLE_FILE[type];
  if (single) return single;
  const folder = FOLDER_OF[type];
  if (!folder) throw new Error(`Unknown source control file type: ${String(type)}`);
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`Invalid source control id for ${type}`);
  }
  return `${folder}/${id}.json`;
}

/** The type and id a managed path stands for (id is undefined for the single-file types), or undefined. */
export function parseManagedPath(path: string): { type: SourceControlledFileType; id?: string } | undefined {
  if (typeof path !== 'string') return undefined;
  for (const type of Object.keys(SOURCE_CONTROL_PATHS) as SourceControlledFileType[]) {
    const match = SOURCE_CONTROL_PATHS[type].exec(path);
    if (match) return match[1] === undefined ? { type } : { type, id: match[1] };
  }
  return undefined;
}

/** True when `path` matches one of the seven fixed rules. */
export function isManagedPath(path: string): boolean {
  return parseManagedPath(path) !== undefined;
}

/** Work folder size limits (n8n's package numbers): 300 MiB in all, 5 MiB per file, 5000 files. */
export const SOURCE_CONTROL_LIMITS = Object.freeze({
  totalBytes: 314572800,
  fileBytes: 5242880,
  files: 5000,
} as const);

export const SOURCE_CONTROL_DEFAULTS = Object.freeze({
  branchName: 'main',
  branchColor: '#5296D6',
  commitMessage: 'Updated Workfolder',
} as const);

/** The connection settings as the API answers them. No secret field: the private key and token never leave the server. */
export interface SourceControlPreferences {
  connected: boolean;
  repositoryUrl?: string;
  branchName: string;
  branchReadOnly: boolean;
  branchColor: string;
  connectionType?: 'ssh' | 'https';
  keyGeneratorType?: 'ed25519' | 'rsa';
  publicKey?: string;
  httpsUsername?: string;
}

export interface PushWorkFolderBody {
  force?: boolean;
  commitMessage?: string;
  fileNames: Array<{ id: string; type: SourceControlledFileType }>;
}

export interface PullWorkFolderBody {
  force?: boolean;
  autoPublish?: 'none' | 'all' | 'published';
}

export interface PushResult {
  files: SourceControlledFile[];
  commit: string;
}

export interface PullResult {
  files: SourceControlledFile[];
  publishingErrors: Array<{ id: string; name: string; message: string }>;
  contentImportPolicy: Array<{ id: string; name: string; violations: string[] }>;
}
