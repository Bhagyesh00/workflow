/**
 * MCP build tool: `update_workflow` (P5-13). The client sends the workflow id, the version id it read
 * and a list of JSON operations (26 types: nodes, connections, credentials, settings, pin data, tags,
 * groups). The operations run in order on an in-memory copy; node and connection operations go through
 * L1's `BuilderDraft` methods, the credential, settings, pin data and group operations act on
 * `draft.definition()` here, and tags are collected for the save because a definition holds none. One
 * failed operation stops everything and nothing is saved. Then: credentials of the workspace only,
 * validation (a refusal lists every new error), and the normal `WorkflowService.update`, which checks
 * the version again and writes a version snapshot. No code is evaluated.
 */
import { randomUUID } from 'node:crypto';
import type { Connections, WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../../context';
import { itemSchema, settingsSchema } from '../../../../http/schemas';
import { BuilderDraft, BuilderDraftError } from '../../../ai-builder/draft';
import { validateDefinition } from '../../../ai-builder/tools';
import { toDefinition } from '../../../workflow-model';
import type { McpCaller, McpToolDefinition } from '../../types';
import { assertWorkflowForMcp, McpToolError, mcpActor } from '../../workflow-gate';
import { assertCredentialsInTenant } from './credential-check';
import { refuseOnErrors } from './validate';

const MAX_OPERATIONS = 100;
const MAX_PIN_ITEMS = 100;

const nodeName = z.string().min(1).max(256).describe('The name of the node');
const nodeNames = z.array(nodeName).min(1).max(500);
const position = z.tuple([z.number(), z.number()]);
const parameters = z.record(z.string(), z.unknown());
const credentialRef = z.object({ id: z.string().nullable(), name: z.string() });
const op = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

const operation = z.discriminatedUnion('type', [
  op('addNode', {
    node: z.object({
      type: z.string().min(1).max(256).describe('The exact node type name from search_nodes'),
      name: z.string().min(1).max(128).optional(),
      typeVersion: z.number().optional(),
      position: position.optional(),
      parameters: parameters.optional(),
      credentials: z.record(z.string(), credentialRef).optional(),
    }),
  }),
  op('removeNode', { name: nodeName }),
  op('renameNode', { name: nodeName, newName: z.string().min(1).max(128) }),
  op('setNodeParameters', {
    name: nodeName,
    parameters: parameters.describe('Keys to set; a null value removes the key'),
  }),
  op('replaceNodeParameters', { name: nodeName, parameters }),
  op('setNodePosition', { name: nodeName, position }),
  op('setNodeDisabled', { name: nodeName, disabled: z.boolean() }),
  op('setNodeNotes', {
    name: nodeName,
    notes: z.string().max(5000).nullable().describe('null removes the note'),
    notesInFlow: z.boolean().optional(),
  }),
  op('setNodeOptions', {
    name: nodeName,
    retryOnFail: z.boolean().optional(),
    maxTries: z.number().int().min(1).max(5).optional(),
    waitBetweenTries: z.number().int().min(0).max(5000).optional(),
    alwaysOutputData: z.boolean().optional(),
    executeOnce: z.boolean().optional(),
    onError: z.enum(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']).optional(),
  }),
  op('connect', {
    from: nodeName,
    to: nodeName,
    connectionType: z.string().max(64).optional().describe('Default "main"; e.g. "ai_languageModel"'),
    outputIndex: z.number().int().min(0).max(31).optional(),
    inputIndex: z.number().int().min(0).max(31).optional(),
  }),
  op('disconnect', {
    from: nodeName,
    to: nodeName,
    connectionType: z.string().max(64).optional(),
    outputIndex: z.number().int().min(0).max(31).optional(),
    inputIndex: z.number().int().min(0).max(31).optional(),
  }),
  op('clearNodeConnections', { name: nodeName }),
  op('setNodeCredential', {
    name: nodeName,
    credentialType: z.string().min(1).max(256).describe('The credential type the node asks for'),
    credentialId: z.uuid().describe('A credential id from list_credentials'),
  }),
  op('removeNodeCredential', { name: nodeName, credentialType: z.string().min(1).max(256) }),
  op('setWorkflowName', { name: z.string().trim().min(1).max(128) }),
  op('setSettings', {
    settings: z.record(z.string(), z.unknown()).describe('Settings to set; a null value removes the key'),
  }),
  op('setPinData', {
    name: nodeName,
    items: z.array(itemSchema).max(MAX_PIN_ITEMS).describe('Items such as { "json": { ... } }'),
  }),
  op('clearPinData', { name: nodeName }),
  op('addTag', { tag: z.string().min(1).max(256).describe('A tag id or name from list_workflow_tags') }),
  op('removeTag', { tag: z.string().min(1).max(256) }),
  op('setTags', { tags: z.array(z.string().min(1).max(256)).max(100).describe('Tag ids or names') }),
  op('addGroup', {
    name: z.string().min(1).max(128),
    nodeNames: nodeNames,
    description: z.string().max(145).optional(),
  }),
  op('removeGroup', { group: z.string().min(1).max(256).describe('A group id or name') }),
  op('renameGroup', { group: z.string().min(1).max(256), name: z.string().min(1).max(128) }),
  op('addNodesToGroup', { group: z.string().min(1).max(256), nodeNames }),
  op('removeNodesFromGroup', { group: z.string().min(1).max(256), nodeNames }),
]);

export type UpdateOperation = z.output<typeof operation>;

/** the operation types, for the tests and the drift check */
export const UPDATE_OPERATION_TYPES = operation.options.map((o) => o.shape.type.value);

const updateInput = z.object({
  workflowId: z.uuid().describe('The id of the workflow'),
  versionId: z
    .uuid()
    .describe(
      'The versionId you read (get_workflow_details). A newer version in the workspace refuses the update.',
    ),
  operations: z
    .array(operation)
    .min(1)
    .max(MAX_OPERATIONS)
    .describe('Changes, applied in order. All of them or none.'),
  message: z.string().max(500).optional().describe('A note for the version history'),
});

export const MCP_UPDATE_TEXTS = {
  stale: (given: string, current: string) =>
    `The workflow changed since version ${given} (now ${current}). Read it again with get_workflow_details and redo the operations. Nothing was saved.`,
  failed: (index: number, type: string, message: string) =>
    `Operation ${index + 1} (${type}) failed: ${message} Nothing was saved.`,
  notValid: 'The change makes the workflow invalid. Nothing was saved. Issues:',
} as const;

/** what the operations run on */
interface Session {
  ctx: ServerContext;
  caller: McpCaller;
  /** the workflow's project: a credential must be usable in it (P6-35) */
  projectId: string;
  draft: BuilderDraft;
  /** the workflow's tag ids, once a tag operation changed them */
  tagIds?: Set<string>;
  currentTagIds: string[];
  tenantTags?: Array<{ id: string; name: string }>;
}

function definitionOf(session: Session): WorkflowDefinition {
  return session.draft.definition();
}

function findNode(session: Session, name: string): WorkflowNode {
  const node = definitionOf(session).nodes.find((n) => n.name === name);
  if (!node) throw new BuilderDraftError(`There is no node named "${name}"`);
  return node;
}

function findGroup(session: Session, key: string) {
  const groups = (definitionOf(session).nodeGroups ??= []);
  const group = groups.find((g) => g.id === key) ?? groups.find((g) => g.name === key);
  if (!group) throw new BuilderDraftError(`There is no group "${key}"`);
  return group;
}

async function resolveTag(session: Session, key: string): Promise<string> {
  session.tenantTags ??= (await session.ctx.repos.tags.list(session.caller.tenant.id)).map((t) => ({
    id: t.id,
    name: t.name,
  }));
  const tag = session.tenantTags.find((t) => t.id === key) ?? session.tenantTags.find((t) => t.name === key);
  if (!tag) throw new BuilderDraftError(`There is no tag "${key}". Tags are listed by list_workflow_tags.`);
  return tag.id;
}

function tagSet(session: Session): Set<string> {
  session.tagIds ??= new Set(session.currentTagIds);
  return session.tagIds;
}

function memberIds(session: Session, names: string[]): string[] {
  return [...new Set(names.map((name) => findNode(session, name).id))];
}

/** drops a node from every connection, in and out (the node itself stays) */
function clearConnectionsOf(connections: Connections, name: string): void {
  delete connections[name];
  for (const byType of Object.values(connections)) {
    for (const [type, outputs] of Object.entries(byType)) {
      (byType as Record<string, unknown>)[type] = (outputs ?? []).map(
        (dests) => dests?.filter((d) => d.node !== name) ?? null,
      );
    }
  }
}

async function apply(session: Session, step: UpdateOperation): Promise<void> {
  const { draft } = session;
  const definition = definitionOf(session);
  switch (step.type) {
    case 'addNode':
      draft.addNodes([step.node as Parameters<BuilderDraft['addNodes']>[0][number]]);
      return;
    case 'removeNode': {
      const node = findNode(session, step.name);
      draft.removeNode(step.name);
      // a removed node leaves its group; a group left with no member goes too
      definition.nodeGroups = (definition.nodeGroups ?? [])
        .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => id !== node.id) }))
        .filter((g) => g.nodeIds.length > 0);
      return;
    }
    case 'renameNode':
      draft.renameNode(step.name, step.newName);
      return;
    case 'setNodeParameters':
      draft.updateNodeParameters(step.name, step.parameters as never);
      return;
    case 'replaceNodeParameters':
      findNode(session, step.name).parameters = structuredClone(step.parameters) as never;
      return;
    case 'setNodePosition':
      findNode(session, step.name).position = [step.position[0], step.position[1]];
      return;
    case 'setNodeDisabled': {
      const node = findNode(session, step.name);
      if (step.disabled) node.disabled = true;
      else delete node.disabled;
      return;
    }
    case 'setNodeNotes': {
      const node = findNode(session, step.name);
      if (step.notes === null || step.notes === '') {
        delete node.notes;
        delete node.notesInFlow;
      } else {
        node.notes = step.notes;
        if (step.notesInFlow !== undefined) node.notesInFlow = step.notesInFlow;
      }
      return;
    }
    case 'setNodeOptions': {
      const node = findNode(session, step.name);
      const { type: _type, name: _name, ...options } = step;
      for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) (node as unknown as Record<string, unknown>)[key] = value;
      }
      return;
    }
    case 'connect':
      draft.connectNodes([
        {
          from: step.from,
          to: step.to,
          type: step.connectionType,
          outputIndex: step.outputIndex,
          inputIndex: step.inputIndex,
        },
      ]);
      return;
    case 'disconnect':
      draft.removeConnection({
        from: step.from,
        to: step.to,
        type: step.connectionType,
        outputIndex: step.outputIndex,
        inputIndex: step.inputIndex,
      });
      return;
    case 'clearNodeConnections':
      findNode(session, step.name);
      clearConnectionsOf(definition.connections, step.name);
      return;
    case 'setNodeCredential': {
      const node = findNode(session, step.name);
      const row = await session.ctx.repos.credentials.get(session.caller.tenant.id, step.credentialId);
      if (
        !row ||
        !(await session.ctx.access.credentialUsable(session.caller.tenant.id, session.projectId, row))
      )
        throw new BuilderDraftError(`Credential "${step.credentialId}" was not found in this workspace`);
      const types = session.ctx.registries.credentialTypes;
      if (row.type !== step.credentialType && !types.isA(row.type, step.credentialType)) {
        throw new BuilderDraftError(
          `Credential "${row.name}" is of type "${row.type}", not "${step.credentialType}"`,
        );
      }
      node.credentials = {
        ...(node.credentials ?? {}),
        [step.credentialType]: { id: row.id, name: row.name },
      };
      return;
    }
    case 'removeNodeCredential': {
      const node = findNode(session, step.name);
      if (!node.credentials || !(step.credentialType in node.credentials)) {
        throw new BuilderDraftError(`"${step.name}" has no "${step.credentialType}" credential`);
      }
      delete node.credentials[step.credentialType];
      if (!Object.keys(node.credentials).length) delete node.credentials;
      return;
    }
    case 'setWorkflowName':
      definition.name = step.name;
      return;
    case 'setSettings': {
      const merged: Record<string, unknown> = { ...(definition.settings ?? {}) };
      for (const [key, value] of Object.entries(structuredClone(step.settings))) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      const parsed = settingsSchema.safeParse(merged);
      if (!parsed.success) {
        throw new BuilderDraftError(
          `The settings are not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'} ${i.message}`).join('; ')}`,
        );
      }
      definition.settings = parsed.data as WorkflowDefinition['settings'];
      return;
    }
    case 'setPinData':
      findNode(session, step.name);
      definition.pinData = {
        ...(definition.pinData ?? {}),
        [step.name]: structuredClone(step.items) as never,
      };
      return;
    case 'clearPinData':
      findNode(session, step.name);
      if (definition.pinData) delete definition.pinData[step.name];
      return;
    case 'addTag':
      tagSet(session).add(await resolveTag(session, step.tag));
      return;
    case 'removeTag': {
      const id = await resolveTag(session, step.tag);
      tagSet(session).delete(id);
      return;
    }
    case 'setTags': {
      const ids = new Set<string>();
      for (const tag of step.tags) ids.add(await resolveTag(session, tag));
      session.tagIds = ids;
      return;
    }
    case 'addGroup': {
      const groups = (definition.nodeGroups ??= []);
      const ids = memberIds(session, step.nodeNames);
      for (const id of ids) {
        const other = groups.find((g) => g.nodeIds.includes(id));
        if (other)
          throw new BuilderDraftError(`A node can be in one group only; it is in "${other.name}" already`);
      }
      groups.push({
        id: randomUUID(),
        name: step.name,
        nodeIds: ids,
        ...(step.description ? { description: step.description } : {}),
      });
      return;
    }
    case 'removeGroup': {
      const group = findGroup(session, step.group);
      definition.nodeGroups = (definition.nodeGroups ?? []).filter((g) => g !== group);
      return;
    }
    case 'renameGroup':
      findGroup(session, step.group).name = step.name;
      return;
    case 'addNodesToGroup': {
      const group = findGroup(session, step.group);
      const ids = memberIds(session, step.nodeNames);
      for (const id of ids) {
        const other = (definition.nodeGroups ?? []).find((g) => g !== group && g.nodeIds.includes(id));
        if (other)
          throw new BuilderDraftError(`A node can be in one group only; it is in "${other.name}" already`);
        if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
      }
      return;
    }
    case 'removeNodesFromGroup': {
      const group = findGroup(session, step.group);
      const ids = new Set(memberIds(session, step.nodeNames));
      group.nodeIds = group.nodeIds.filter((id) => !ids.has(id));
      if (!group.nodeIds.length) {
        definition.nodeGroups = (definition.nodeGroups ?? []).filter((g) => g !== group);
      }
      return;
    }
  }
}

function describeFailure(error: unknown): string | undefined {
  if (error instanceof BuilderDraftError || error instanceof McpToolError) return error.message;
  if (error instanceof z.ZodError) return error.issues.map((i) => i.message).join('; ');
  return undefined;
}

export const updateWorkflowTool: McpToolDefinition<z.output<typeof updateInput>> = {
  name: 'update_workflow',
  description: `Change a workflow available in MCP with a list of operations, applied in order, all or none (${UPDATE_OPERATION_TYPES.length} types: ${UPDATE_OPERATION_TYPES.join(', ')}). Pass the versionId you read; a newer version refuses the update. The result is validated; when it has new errors nothing is saved and the issues are listed. A published workflow keeps running its published version until you publish_workflow.`,
  scopes: ['workflow:write'],
  access: 'workflow:update',
  input: updateInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const row = await assertWorkflowForMcp(ctx, caller, input.workflowId, 'write');
    await ctx.collaboration.assertNoLock(caller.tenant.id, input.workflowId);
    if (row.versionId !== input.versionId) {
      throw new McpToolError(MCP_UPDATE_TEXTS.stale(input.versionId, row.versionId));
    }
    const tenantId = caller.tenant.id;
    const original = toDefinition(row);
    const session: Session = {
      ctx,
      caller,
      projectId: row.projectId,
      draft: new BuilderDraft(structuredClone(original), ctx.registries.nodeTypes),
      currentTagIds: ((await ctx.repos.workflows.tagsFor(tenantId, [row.id])).get(row.id) ?? []).map(
        (t) => t.id,
      ),
    };
    for (const [index, step] of input.operations.entries()) {
      try {
        await apply(session, step);
      } catch (error) {
        const message = describeFailure(error);
        if (message === undefined) throw error;
        throw new McpToolError(MCP_UPDATE_TEXTS.failed(index, step.type, message));
      }
    }

    const definition = definitionOf(session);
    await assertCredentialsInTenant(ctx, tenantId, definition, row.projectId);
    const after = await validateDefinition(ctx, tenantId, definition, row.id);
    const before = after.valid ? undefined : await validateDefinition(ctx, tenantId, original, row.id);
    const issues = refuseOnErrors(after, MCP_UPDATE_TEXTS.notValid, before);

    const saved = await ctx.workflows.update(
      tenantId,
      row.id,
      {
        versionId: input.versionId,
        name: definition.name,
        nodes: definition.nodes,
        connections: definition.connections,
        settings: definition.settings ?? {},
        pinData: definition.pinData ?? {},
        stickyNotes: definition.stickyNotes ?? [],
        nodeGroups: definition.nodeGroups ?? [],
        ...(session.tagIds ? { tagIds: [...session.tagIds] } : {}),
      } as unknown as Parameters<typeof ctx.workflows.update>[2],
      mcpActor(caller),
      input.message,
    );
    return {
      workflowId: saved.id,
      name: saved.name,
      versionId: saved.versionId,
      operationsApplied: input.operations.length,
      nodes: saved.nodes.map((n) => ({ name: n.name, type: n.type })),
      issues,
      ...(saved.activationError ? { activationError: saved.activationError.message } : {}),
    };
  },
};

export const updateTools: McpToolDefinition<any>[] = [updateWorkflowTool];
