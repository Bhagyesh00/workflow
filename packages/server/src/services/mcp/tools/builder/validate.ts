/**
 * MCP build tools: validate a workflow definition or one node's configuration without saving
 * anything (P5-13). The checks are L1's `validateDefinition` (builder lint, the graph and the webhook
 * paths in use) and `lintForBuilder`. The helpers at the top are shared with `create_workflow` and
 * `update_workflow`, which refuse a definition that has errors.
 */
import { randomUUID } from 'node:crypto';
import {
  type DoctorIssue,
  latestVersion,
  lintForBuilder,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../../context';
import { workflowDataSchema } from '../../../../http/schemas';
import { type BuilderValidation, validateDefinition } from '../../../ai-builder/tools';
import { PolicyCheckFailedError, violationMessage } from '../../../type-policies/errors';
import { policyIssues } from '../../../type-policies/tool-filter';
import { toDefinition } from '../../../workflow-model';
import type { McpToolDefinition } from '../../types';
import { assertWorkflowForMcp, McpToolError } from '../../workflow-gate';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** the workflow object the build tools take: `workflowDataSchema`, the editor's own shape */
export const workflowInput = workflowDataSchema;
export type WorkflowInput = z.output<typeof workflowInput>;

/** the fields of a workflow the build tools keep from a client's object (anything else is dropped) */
export function definitionFromInput(input: WorkflowInput): WorkflowDefinition {
  const name = (input.name ?? '').trim() || 'Untitled';
  return {
    name,
    nodes: structuredClone(input.nodes) as unknown as WorkflowNode[],
    connections: structuredClone(input.connections) as unknown as WorkflowDefinition['connections'],
    settings: structuredClone(input.settings ?? {}) as unknown as WorkflowDefinition['settings'],
    pinData: structuredClone(input.pinData ?? {}) as unknown as WorkflowDefinition['pinData'],
    stickyNotes: structuredClone(input.stickyNotes ?? []) as unknown as WorkflowDefinition['stickyNotes'],
    nodeGroups: structuredClone(input.nodeGroups ?? []) as unknown as WorkflowDefinition['nodeGroups'],
  };
}

/** what a client reads of one issue */
export function issueView(issue: DoctorIssue) {
  return {
    severity: issue.severity,
    ...(issue.code ? { code: issue.code } : {}),
    ...(issue.node ? { node: issue.node } : {}),
    message: issue.message,
    ...(issue.hint ? { hint: issue.hint } : {}),
  };
}

function issueLine(issue: DoctorIssue): string {
  return `- ${issue.severity}${issue.node ? ` in "${issue.node}"` : ''}${issue.code ? ` (${issue.code})` : ''}: ${issue.message}${issue.hint ? ` ${issue.hint}` : ''}`;
}

/** the refusal text: what was not done and every error, so a client fixes them in one go */
export function refusalText(prefix: string, issues: DoctorIssue[]): string {
  return `${prefix}\n${issues.map(issueLine).join('\n')}`;
}

/** an error that was in the workflow before an update is not the update's */
function issueKey(issue: DoctorIssue): string {
  return `${issue.node ?? ''}|${issue.code ?? ''}|${issue.message}`;
}

/**
 * Throws when the definition has an error, listing all issues; returns the warnings and notes.
 * With `before` (an update), errors that were already there are not counted, so a workflow that
 * was saved with a problem can still be repaired in steps.
 */
export function refuseOnErrors(
  validation: BuilderValidation,
  prefix: string,
  before?: BuilderValidation,
): ReturnType<typeof issueView>[] {
  const known = new Set((before?.issues ?? []).filter((i) => i.severity === 'error').map(issueKey));
  const errors = validation.issues.filter((i) => i.severity === 'error' && !known.has(issueKey(i)));
  if (errors.length) throw new McpToolError(refusalText(prefix, errors));
  return validation.issues.filter((i) => i.severity !== 'error' || known.has(issueKey(i))).map(issueView);
}

/**
 * A node type resolves through the registry's map only: a name that is not in it is refused before
 * anything else looks at the definition (no path, no import).
 */
export function assertNodeTypesKnown(ctx: ServerContext, definition: WorkflowDefinition): void {
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  for (const node of definition.nodes) {
    if (!ctx.registries.nodeTypes.get(node.type)) {
      throw new McpToolError(
        `Unknown node type "${node.type}" (node "${node.name}"). Use search_nodes to find the exact type name.`,
      );
    }
    if (seenNames.has(node.name)) throw new McpToolError(`Two nodes are named "${node.name}"`);
    if (seenIds.has(node.id)) throw new McpToolError(`Two nodes have the id "${node.id}"`);
    seenNames.add(node.name);
    seenIds.add(node.id);
  }
}

/** a webhook node gets a fresh `webhookId` from the server, whatever the client wrote */
export function freshWebhookIds(ctx: ServerContext, definition: WorkflowDefinition): void {
  for (const node of definition.nodes) {
    const description = ctx.registries.nodeTypes.get(node.type)?.description;
    if (description?.webhooks?.length) node.webhookId = randomUUID();
  }
}

const validateWorkflowInput = z.object({
  workflow: workflowInput
    .optional()
    .describe('A workflow definition to check (see get_workflow_format_reference)'),
  workflowId: z.uuid().optional().describe('Or the id of a workflow available in MCP; its draft is checked'),
});

export const validateWorkflowTool: McpToolDefinition<z.output<typeof validateWorkflowInput>> = {
  name: 'validate_workflow',
  description:
    'Check a workflow definition (or the draft of a workflow available in MCP) and list its issues: errors that stop a save, warnings and notes. Nothing is saved. Give "workflow" or "workflowId".',
  scopes: ['workflow:read', 'workflow:write'],
  access: 'workflow:read',
  input: validateWorkflowInput,
  annotations: READ,
  async handler(ctx, caller, input) {
    if (Boolean(input.workflow) === Boolean(input.workflowId)) {
      throw new McpToolError('Give either "workflow" or "workflowId"');
    }
    let definition: WorkflowDefinition;
    let workflowId: string | undefined;
    if (input.workflowId) {
      const row = await assertWorkflowForMcp(ctx, caller, input.workflowId, 'details');
      definition = toDefinition(row);
      workflowId = row.id;
    } else {
      definition = definitionFromInput(input.workflow as WorkflowInput);
    }
    const validation = await validateDefinition(ctx, caller.tenant.id, definition, workflowId);
    return {
      valid: validation.valid,
      issues: validation.issues.map(issueView),
      ...(workflowId ? { workflowId } : {}),
    };
  },
};

/** the checks that need the rest of the workflow: a lone node always fails them */
const CONNECTION_CODES = new Set([
  'sub-node-not-connected',
  'node-missing-required-input',
  'node-not-connected',
  'node-merge-single-input',
  'node-merge-missing-input',
  'node-unsupported-connection-input',
  'webhook-response-node-missing',
  'respond-to-webhook-without-webhook',
  'workflow-has-no-trigger',
  'workflow-has-no-nodes',
  'webhook-path-conflict',
  'node-missing-credentials',
  'expression-unknown-node',
  'expression-not-upstream',
]);

const validateNodeInput = z.object({
  type: z.string().min(1).max(256).describe('The exact node type name from search_nodes'),
  typeVersion: z.number().optional().describe('Default: the latest version'),
  name: z.string().min(1).max(128).default('Node').describe('The name the node would have'),
  parameters: z.record(z.string(), z.unknown()).default({}).describe('The parameters to check'),
});

export const validateNodeConfigTool: McpToolDefinition<z.output<typeof validateNodeInput>> = {
  name: 'validate_node_config',
  description:
    'Check the parameters of one node type before you put the node in a workflow: unknown or missing required parameters and options that are not allowed. Checks that need other nodes (connections, a trigger) are left out. Nothing is saved.',
  scopes: ['workflow:read', 'workflow:write'],
  access: 'workflow:read',
  input: validateNodeInput,
  annotations: READ,
  async handler(ctx, caller, input) {
    const nodeType = ctx.registries.nodeTypes.get(input.type);
    if (!nodeType) {
      throw new McpToolError(
        `Unknown node type "${input.type}". Use search_nodes to find the exact type name.`,
      );
    }
    const description = nodeType.description;
    const versions = Array.isArray(description.version) ? description.version : [description.version];
    if (input.typeVersion !== undefined && !versions.includes(input.typeVersion)) {
      throw new McpToolError(
        `"${input.type}" has no version ${input.typeVersion}; it has ${versions.join(', ')}`,
      );
    }
    const node: WorkflowNode = {
      id: randomUUID(),
      name: input.name,
      type: description.name,
      typeVersion: input.typeVersion ?? latestVersion(description),
      position: [0, 0],
      parameters: structuredClone(input.parameters) as WorkflowNode['parameters'],
    };
    const issues = lintForBuilder(
      { nodes: [node], connections: {}, pinData: {} },
      { get: (type) => ctx.registries.nodeTypes.get(type)?.description },
    ).filter((issue) => !CONNECTION_CODES.has(issue.code ?? '') && (!issue.node || issue.node === node.name));
    // a type a policy blocks is an error, so the model picks another before it builds with it (workspace scope)
    try {
      for (const violation of await policyIssues(ctx.serviceDeps, caller.tenant.id, null, {
        nodes: [node],
      })) {
        issues.push({
          id: `error:${node.name}:policy-blocked:${issues.length}`,
          severity: 'error',
          node: node.name,
          code: 'policy-blocked',
          message: violationMessage([violation]),
          hint: 'Use another type; this one is not available here.',
        });
      }
    } catch (error) {
      if (!(error instanceof PolicyCheckFailedError)) throw error;
      issues.push({
        id: `error:-:policy-check-failed:${issues.length}`,
        severity: 'error',
        code: 'policy-check-failed',
        message: error.message,
        hint: 'Try again in a moment.',
      });
    }
    return {
      valid: !issues.some((i) => i.severity === 'error'),
      type: description.name,
      typeVersion: node.typeVersion,
      issues: issues.map(issueView),
    };
  },
};

export const validateTools: McpToolDefinition<any>[] = [validateWorkflowTool, validateNodeConfigTool];
