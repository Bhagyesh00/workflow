/**
 * P6-74 (L3): the files of a Git work folder, n8n's layout (pretty JSON, 2 spaces). `parseFile` reads one file by
 * its path (`parseManagedPath`), checks its size again and parses it with one zod schema per kind; unknown keys are
 * dropped and a wrong shape is refused. The shapes below are the contract between export (serialize.ts), status and
 * pull (L4); L3 writes the schemas to them.
 * stub (L3): `parseFile` throws; the types are final.
 */
import type {
  Connections,
  DataObject,
  StickyNote,
  WorkflowNode,
  WorkflowNodeGroup,
  WorkflowSettings,
} from '@workflow/workflow';

/** who owns a file's resource: a member's personal project by email, or a team project (n8n's owner shape) */
export type FileOwner =
  | { type: 'personal'; personalEmail: string }
  | { type: 'team'; teamId: string; teamName: string };

/** `workflows/<id>.json`; no pinData, no staticData */
export interface WorkflowFile {
  id: string;
  name: string;
  description: string | null;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  triggerCount: number;
  versionId: string;
  owner: FileOwner | null;
  parentFolderId: string | null;
  isArchived: boolean;
  nodeGroups?: WorkflowNodeGroup[];
  /** ours, not n8n's */
  stickyNotes?: StickyNote[];
}

/** `credential_stubs/<id>.json`; `data` passed through `sanitizeCredentialData` */
export interface CredentialStubFile {
  id: string;
  name: string;
  type: string;
  isGlobal: boolean;
  isResolvable: boolean;
  owner: FileOwner | null;
  data: DataObject;
}

/** one entry of `variable_stubs.json` (and of a project file's variable stubs); `value` is always empty */
export interface VariableStub {
  id: string;
  key: string;
  type: string;
  value: string;
  projectId?: string | null;
}

/** `tags.json` */
export interface TagsFile {
  tags: Array<{ id: string; name: string }>;
  mappings: Array<{ workflowId: string; tagId: string }>;
}

/** `folders.json` */
export interface FoldersFile {
  folders: Array<{
    id: string;
    name: string;
    parentFolderId: string | null;
    homeProjectId: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

/** `datatables/<id>.json`: the schema only, no rows */
export interface DataTableFile {
  id: string;
  name: string;
  projectId: string;
  columns: Array<{ id: string; name: string; type: string; index: number }>;
}

/** `projects/<id>.json`: team projects only */
export interface ProjectFile {
  id: string;
  name: string;
  type: 'team';
  icon: { type: 'icon' | 'emoji'; value: string } | null;
  description: string | null;
  owner: FileOwner;
  variableStubs?: VariableStub[];
}

/** one parsed file, by kind (`type` as `SourceControlledFileType`) */
export type ParsedFile =
  | { type: 'workflow'; path: string; id: string; data: WorkflowFile }
  | { type: 'credential'; path: string; id: string; data: CredentialStubFile }
  | { type: 'variables'; path: string; data: VariableStub[] }
  | { type: 'tags'; path: string; data: TagsFile }
  | { type: 'folders'; path: string; data: FoldersFile }
  | { type: 'datatable'; path: string; id: string; data: DataTableFile }
  | { type: 'project'; path: string; id: string; data: ProjectFile };

/** stub (L3): throws until L3 writes the schemas */
export function parseFile(_path: string, _bytes: Uint8Array): ParsedFile {
  throw new Error('not implemented (L3)');
}
