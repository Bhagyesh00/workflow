/**
 * P6-74 (L3): the files of a Git work folder, n8n's layout (pretty JSON, 2 spaces). `parseFile` reads one file by
 * its path (`parseManagedPath`), checks its size again and parses it with one zod schema per kind; unknown keys are
 * dropped and a wrong shape is refused. The shapes below are the contract between export (serialize.ts), status and
 * pull (L4); L3 writes the schemas to them.
 */
import {
  type Connections,
  type DataObject,
  parseManagedPath,
  SOURCE_CONTROL_LIMITS,
  type StickyNote,
  type WorkflowNode,
  type WorkflowNodeGroup,
  type WorkflowSettings,
} from '@workflow/workflow';
import { z } from 'zod';
import {
  connectionsSchema,
  nodeGroupSchema,
  nodeSchema,
  settingsSchema,
  stickyNoteSchema,
} from '../../http/schemas';
import { SourceControlFormatError, sanitizeCredentialData } from './serialize';

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

export { SourceControlFormatError };

const gitId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const emailText = z.string().min(1).max(320);

const ownerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('personal'), personalEmail: emailText }),
  z.object({ type: z.literal('team'), teamId: gitId, teamName: z.string().max(255) }),
]);

const dataObjectSchema = z.record(z.string(), z.unknown());

const workflowFileSchema = z.object({
  id: gitId,
  name: z.string().min(1).max(128),
  description: z.string().max(65_536).nullable().default(null),
  nodes: z.array(nodeSchema).max(2000),
  connections: connectionsSchema.default({}),
  settings: settingsSchema.optional(),
  triggerCount: z.number().int().min(0).default(0),
  versionId: z.string().min(1).max(64),
  owner: ownerSchema.nullable().default(null),
  parentFolderId: gitId.nullable().default(null),
  isArchived: z.boolean().default(false),
  nodeGroups: z.array(nodeGroupSchema).max(1000).optional(),
  stickyNotes: z.array(stickyNoteSchema).max(1000).optional(),
});

const credentialStubSchema = z.object({
  id: gitId,
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(256),
  isGlobal: z.boolean().default(false),
  isResolvable: z.boolean().default(false),
  owner: ownerSchema.nullable().default(null),
  data: dataObjectSchema.default({}),
});

const variableStubSchema = z.object({
  id: gitId,
  key: z.string().min(1).max(255),
  type: z.string().max(64).default('string'),
  // a value in a file is never read: a stub's value is always empty
  value: z
    .string()
    .default('')
    .transform(() => ''),
  projectId: gitId.nullish(),
});

const tagsFileSchema = z.object({
  tags: z.array(z.object({ id: gitId, name: z.string().min(1).max(255) })).max(50_000),
  mappings: z
    .array(z.object({ workflowId: gitId, tagId: gitId }))
    .max(500_000)
    .default([]),
});

const foldersFileSchema = z.object({
  folders: z
    .array(
      z.object({
        id: gitId,
        name: z.string().min(1).max(255),
        parentFolderId: gitId.nullable().default(null),
        homeProjectId: gitId,
        createdAt: z.string().max(64),
        updatedAt: z.string().max(64),
      }),
    )
    .max(50_000),
});

const dataTableFileSchema = z.object({
  id: gitId,
  name: z.string().min(1).max(128),
  projectId: gitId,
  columns: z
    .array(
      z.object({
        id: gitId,
        name: z.string().min(1).max(63),
        type: z.string().min(1).max(32),
        index: z.number().int().min(0),
      }),
    )
    .max(1000),
});

const projectFileSchema = z.object({
  id: gitId,
  name: z.string().min(1).max(255),
  type: z.literal('team'),
  icon: z
    .object({ type: z.enum(['icon', 'emoji']), value: z.string().max(64) })
    .nullable()
    .default(null),
  description: z.string().max(512).nullable().default(null),
  owner: ownerSchema,
  variableStubs: z.array(variableStubSchema).max(10_000).optional(),
});

const variablesFileSchema = z.array(variableStubSchema).max(50_000);

/** the id a per-resource file must carry: the one in its name */
function sameId(path: string, expected: string | undefined, actual: string): void {
  if (expected === undefined || expected !== actual) {
    throw new SourceControlFormatError(`The file ${path} holds another id than its name`);
  }
}

function refuse(path: string, error: z.ZodError): never {
  const first = error.issues[0];
  const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
  throw new SourceControlFormatError(`The file ${path} does not have the expected shape${where}`);
}

/** one schema per kind; unknown keys are dropped (zod objects strip them), a wrong shape throws */
function check<T>(schema: z.ZodType<T>, path: string, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) refuse(path, parsed.error);
  return parsed.data;
}

/**
 * Reads one file by its managed path: size checked again, JSON, then one schema per kind. A credential stub's data
 * passes `sanitizeCredentialData`, so a secret a remote put in a stub never reaches the workspace.
 */
export function parseFile(path: string, bytes: Uint8Array): ParsedFile {
  const managed = parseManagedPath(path);
  if (!managed) throw new SourceControlFormatError(`The path ${path} is not a work folder file`);
  if (bytes.byteLength > SOURCE_CONTROL_LIMITS.fileBytes) {
    throw new SourceControlFormatError(`The file ${path} is over the size limit`);
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SourceControlFormatError(`The file ${path} is not valid JSON`);
  }
  switch (managed.type) {
    case 'workflow': {
      const data = check(workflowFileSchema, path, json);
      sameId(path, managed.id, data.id);
      return { type: 'workflow', path, id: data.id, data: data as unknown as WorkflowFile };
    }
    case 'credential': {
      const data = check(credentialStubSchema, path, json);
      sameId(path, managed.id, data.id);
      return {
        type: 'credential',
        path,
        id: data.id,
        data: { ...data, data: sanitizeCredentialData(data.data as DataObject) } as CredentialStubFile,
      };
    }
    case 'variables':
      return { type: 'variables', path, data: check(variablesFileSchema, path, json) as VariableStub[] };
    case 'tags':
      return { type: 'tags', path, data: check(tagsFileSchema, path, json) };
    case 'folders':
      return { type: 'folders', path, data: check(foldersFileSchema, path, json) };
    case 'datatable': {
      const data = check(dataTableFileSchema, path, json);
      sameId(path, managed.id, data.id);
      return { type: 'datatable', path, id: data.id, data };
    }
    case 'project': {
      const data = check(projectFileSchema, path, json);
      sameId(path, managed.id, data.id);
      return { type: 'project', path, id: data.id, data: data as ProjectFile };
    }
  }
}
