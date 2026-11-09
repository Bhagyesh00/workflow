/** Zod schemas shared by the REST and public APIs (also used for the OpenAPI document). */
import { GROUP_DESCRIPTION_MAX_LENGTH } from '@workflow/workflow';
import { z } from 'zod';

export const uuid = z.uuid();
export const idParams = z.object({ id: z.uuid() });

const binaryData = z
  .object({
    data: z.string(),
    id: z.string().optional(),
    mimeType: z.string(),
    fileName: z.string().optional(),
    fileExtension: z.string().optional(),
    fileType: z.string().optional(),
    fileSize: z.number().optional(),
    directory: z.string().optional(),
  })
  .loose();

const pairedItem = z.union([
  z.number(),
  z.object({ item: z.number(), input: z.number().optional() }),
  z.array(z.object({ item: z.number(), input: z.number().optional() })),
]);

export const itemSchema = z
  .object({
    json: z.record(z.string(), z.unknown()),
    binary: z.record(z.string(), binaryData).optional(),
    pairedItem: pairedItem.optional(),
    error: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export const nodeSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    type: z.string().min(1).max(256),
    typeVersion: z.number(),
    position: z.tuple([z.number(), z.number()]),
    parameters: z.record(z.string(), z.unknown()).default({}),
    credentials: z.record(z.string(), z.object({ id: z.string().nullable(), name: z.string() })).optional(),
    disabled: z.boolean().optional(),
    notes: z.string().optional(),
    notesInFlow: z.boolean().optional(),
    retryOnFail: z.boolean().optional(),
    maxTries: z.number().int().min(1).max(5).optional(),
    waitBetweenTries: z.number().int().min(0).max(5000).optional(),
    alwaysOutputData: z.boolean().optional(),
    executeOnce: z.boolean().optional(),
    onError: z.enum(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']).optional(),
    webhookId: z.string().max(256).optional(),
    color: z.string().max(64).optional(),
  })
  .loose();

const connection = z.object({ node: z.string(), type: z.string(), index: z.number().int().min(0) });
export const connectionsSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(z.array(connection).nullable())),
);

export const settingsSchema = z
  .object({
    executionOrder: z.literal('v1').optional(),
    timezone: z.string().max(64).optional(),
    errorWorkflow: z.string().max(64).optional(),
    saveDataErrorExecution: z.enum(['all', 'none']).optional(),
    saveDataSuccessExecution: z.enum(['all', 'none']).optional(),
    saveManualExecutions: z.boolean().optional(),
    saveExecutionProgress: z.boolean().optional(),
    executionTimeout: z.number().int().min(0).optional(),
    callerPolicy: z.enum(['any', 'none', 'sameProject', 'allowList']).optional(),
    callerIds: z.array(z.string()).optional(),
    /** P5-03, P5-04: the workflow is reachable from MCP (tenant server tools, trigger) */
    availableInMCP: z.boolean().optional(),
  })
  .loose();

export const stickyNoteSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    position: z.tuple([z.number(), z.number()]),
    width: z.number(),
    height: z.number(),
    color: z.string().optional(),
  })
  .loose();

/** a canvas group (P3-04); the rules are checked by validateWorkflowNodeGroups */
export const nodeGroupSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  nodeIds: z.array(z.string().max(128)).max(2000),
  description: z.string().max(GROUP_DESCRIPTION_MAX_LENGTH).optional(),
});
const nodeGroupsSchema = z.array(nodeGroupSchema).max(1000);

export const pinDataSchema = z.record(z.string(), z.array(itemSchema));

const sourceDataSchema = z
  .object({
    previousNode: z.string(),
    previousNodeOutput: z.number().optional(),
    previousNodeRun: z.number().optional(),
  })
  .loose();

/** the results of one node run in an earlier execution, as a partial run takes them over */
const taskDataSchema = z
  .object({
    startTime: z.number().default(0),
    executionTime: z.number().default(0),
    executionStatus: z.string().default('success'),
    data: z.record(z.string(), z.array(z.array(itemSchema).nullable())).optional(),
    source: z.array(sourceDataSchema.nullable()).default([]),
  })
  .loose();

export const runDataSchema = z.record(z.string(), z.array(taskDataSchema).max(10_000));

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  nodes: z.array(nodeSchema).max(2000).default([]),
  connections: connectionsSchema.default({}),
  settings: settingsSchema.optional(),
  pinData: pinDataSchema.optional(),
  stickyNotes: z.array(stickyNoteSchema).max(1000).optional(),
  nodeGroups: nodeGroupsSchema.optional(),
  tagIds: z.array(z.uuid()).max(100).optional(),
  /** P3-07: the folder to create the workflow in (null / absent = root) */
  folderId: z.uuid().nullable().optional(),
});

export const workflowUpdateSchema = z.object({
  versionId: z.uuid(),
  name: z.string().trim().min(1).max(128).optional(),
  nodes: z.array(nodeSchema).max(2000).optional(),
  connections: connectionsSchema.optional(),
  settings: settingsSchema.optional(),
  pinData: pinDataSchema.optional(),
  stickyNotes: z.array(stickyNoteSchema).max(1000).optional(),
  nodeGroups: nodeGroupsSchema.optional(),
  tagIds: z.array(z.uuid()).max(100).optional(),
  /** P3-17: saved by the editor's autosave */
  autosaved: z.boolean().optional(),
  /** optional description of the change for version history */
  versionMessage: z.string().max(500).optional(),
});

/** the definition the editor sends for unsaved runs / test listeners */
export const workflowDataSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().max(128).default('Untitled'),
    nodes: z.array(nodeSchema).max(2000),
    connections: connectionsSchema.default({}),
    settings: settingsSchema.optional(),
    pinData: pinDataSchema.optional(),
    stickyNotes: z.array(stickyNoteSchema).optional(),
    nodeGroups: nodeGroupsSchema.optional(),
  })
  .loose();

const MAX_TOOL_TEST_VALUES = 100;

export const runSchema = z.object({
  workflowData: workflowDataSchema.optional(),
  startNode: z.string().optional(),
  destinationNode: z.string().optional(),
  pinData: pinDataSchema.optional(),
  triggerItems: z.array(itemSchema).max(10_000).optional(),
  /** partial run: the run data of an earlier execution; the nodes before the start node keep theirs */
  runData: runDataSchema.optional(),
  /** P3-06: nodes changed since runData was produced (they and their descendants run again) */
  dirtyNodeNames: z.array(z.string().max(256)).max(2000).optional(),
  /** P5-76 test a tool: `destinationNode` is the tool, `query` its values (data, never evaluated) */
  agentRequest: z
    .object({
      query: z
        .record(z.string(), z.unknown())
        .refine((query) => Object.keys(query).length <= MAX_TOOL_TEST_VALUES, {
          error: `A tool test takes at most ${MAX_TOOL_TEST_VALUES} values`,
        }),
      toolName: z.string().max(256),
    })
    .optional(),
});

/** POST /workflows/:id/activate (publish, P3-10): all optional; an empty body publishes the current version */
export const publishSchema = z.object({
  versionId: z.uuid().optional(),
  versionName: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2000).optional(),
});

/** PATCH /workflows/:id/versions/:versionId (P3-10): name or describe a version; null clears */
export const versionPatchSchema = z
  .object({
    versionName: z.string().trim().min(1).max(128).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.versionName !== undefined || v.description !== undefined, {
    message: 'Give versionName or description',
  });

/** PATCH /executions/:id (P3-09): tags replace the execution's tags; vote null clears it */
export const annotationPatchSchema = z
  .object({
    tags: z.array(z.uuid()).max(50).optional(),
    vote: z.enum(['up', 'down']).nullable().optional(),
  })
  .refine((v) => v.tags !== undefined || v.vote !== undefined, { message: 'Give tags or vote' });

/** POST /workflows/from-url (P3-13): the URL travels in the body, never in a query string */
export const importUrlSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
});

export const credentialCreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const credentialUpdateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const credentialTestSchema = z.object({
  type: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()).default({}),
  id: z.uuid().optional(),
});

export const tagSchema = z.object({ name: z.string().trim().min(1).max(64) });

export const variableKey = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
    'Keys start with a letter or underscore and contain only letters, digits and underscores',
  );
export const variableCreateSchema = z.object({ key: variableKey, value: z.string().max(4096) });
export const variableUpdateSchema = z.object({
  key: variableKey.optional(),
  value: z.string().max(4096).optional(),
});

/** P6-03: `member` joins the old words; L10 moves the member routes to their own schema, L24 deletes this */
export const roleSchema = z.enum(['owner', 'admin', 'member', 'editor', 'viewer']);
