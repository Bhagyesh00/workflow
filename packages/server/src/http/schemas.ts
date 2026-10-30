/** Zod schemas shared by the REST and public APIs (also used for the OpenAPI document). */
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

export const pinDataSchema = z.record(z.string(), z.array(itemSchema));

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  nodes: z.array(nodeSchema).max(2000).default([]),
  connections: connectionsSchema.default({}),
  settings: settingsSchema.optional(),
  pinData: pinDataSchema.optional(),
  stickyNotes: z.array(stickyNoteSchema).max(1000).optional(),
  tagIds: z.array(z.uuid()).max(100).optional(),
});

export const workflowUpdateSchema = z.object({
  versionId: z.uuid(),
  name: z.string().trim().min(1).max(128).optional(),
  nodes: z.array(nodeSchema).max(2000).optional(),
  connections: connectionsSchema.optional(),
  settings: settingsSchema.optional(),
  pinData: pinDataSchema.optional(),
  stickyNotes: z.array(stickyNoteSchema).max(1000).optional(),
  tagIds: z.array(z.uuid()).max(100).optional(),
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
  })
  .loose();

export const runSchema = z.object({
  workflowData: workflowDataSchema.optional(),
  startNode: z.string().optional(),
  destinationNode: z.string().optional(),
  pinData: pinDataSchema.optional(),
  triggerItems: z.array(itemSchema).max(10_000).optional(),
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

export const roleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
