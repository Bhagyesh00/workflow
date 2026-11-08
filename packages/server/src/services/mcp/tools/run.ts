/**
 * MCP tools: run workflows (P5-04; research-B section 2, part a). `execute_workflow` starts the draft
 * (manual) or the published version (production) from a webhook, form, chat, schedule or manual trigger
 * (manual mode only), with the client's inputs as the trigger's items, and answers at once.
 * `test_workflow` runs the draft with pin data and waits up to a timeout. `prepare_workflow_pin_data`
 * says which nodes need pin data for a test. All need a workflow available in MCP; `minRole` is the REST
 * run route's (editor).
 */
import { randomUUID } from 'node:crypto';
import {
  type DataObject,
  type Item,
  isTriggerDescription,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../context';
import { ApiError } from '../../../http/errors';
import { loadPublishedDefinition } from '../../published-workflow';
import { toDefinition } from '../../workflow-model';
import type { McpCaller, McpToolDefinition } from '../types';
import { assertWorkflowForMcp, McpToolError, sanitizeNodeCredentials } from '../workflow-gate';

export type McpTriggerKind = 'manual' | 'webhook' | 'form' | 'chat' | 'schedule';

/** the trigger types `execute_workflow` can start, by node type */
export const MCP_TRIGGER_KINDS: Readonly<Record<string, McpTriggerKind>> = {
  'core.manualTrigger': 'manual',
  'core.webhook': 'webhook',
  'core.formTrigger': 'form',
  'ai.chatTrigger': 'chat',
  'core.scheduleTrigger': 'schedule',
};

export const MCP_RUN_TEXTS = {
  noPublished: (id: string) => `Workflow '${id}' has no published (active) version to execute`,
  noTrigger:
    'The workflow has no trigger that MCP can start. Supported triggers: webhook, form, chat, schedule, and manual in manual mode.',
  triggerNotFound: (name: string) => `Trigger node '${name}' was not found in the workflow`,
  triggerDisabled: (name: string) => `Trigger node '${name}' is disabled`,
  triggerUnsupported: (name: string, type: string) =>
    `Trigger node '${name}' (${type}) is not supported. Supported triggers: webhook, form, chat, schedule, and manual in manual mode.`,
  manualOnly: (name: string) => `Trigger node '${name}' is a manual trigger: it runs in manual mode only`,
  severalTriggers: (names: string[]) =>
    `The workflow has several triggers (${names.join(', ')}): name one with triggerNodeName`,
  wrongInputs: (kind: string, type: string) => `The ${kind} trigger does not take ${type} inputs`,
  unknownNode: (name: string) => `Node '${name}' was not found in the workflow`,
} as const;

/** the triggers of a workflow and whether `execute_workflow` can start them */
export function triggerInfo(ctx: ServerContext, nodes: WorkflowNode[]) {
  return nodes
    .filter((node) => isTrigger(ctx, node))
    .map((node) => ({
      name: node.name,
      type: node.type,
      disabled: node.disabled === true,
      kind: MCP_TRIGGER_KINDS[node.type] ?? null,
      supported: MCP_TRIGGER_KINDS[node.type] !== undefined,
    }));
}

function isTrigger(ctx: ServerContext, node: WorkflowNode): boolean {
  return (
    MCP_TRIGGER_KINDS[node.type] !== undefined ||
    isTriggerDescription(ctx.registries.nodeTypes.get(node.type)?.description)
  );
}

/** the trigger a run starts from: the named one, else the only one it can start */
function chooseTrigger(
  ctx: ServerContext,
  definition: WorkflowDefinition,
  name: string | undefined,
  mode: 'manual' | 'production',
): { node: WorkflowNode; kind: McpTriggerKind } {
  if (name !== undefined) {
    const node = definition.nodes.find((n) => n.name === name);
    if (!node || !isTrigger(ctx, node)) throw new McpToolError(MCP_RUN_TEXTS.triggerNotFound(name));
    if (node.disabled) throw new McpToolError(MCP_RUN_TEXTS.triggerDisabled(name));
    const kind = MCP_TRIGGER_KINDS[node.type];
    if (!kind) throw new McpToolError(MCP_RUN_TEXTS.triggerUnsupported(name, node.type));
    if (kind === 'manual' && mode !== 'manual') throw new McpToolError(MCP_RUN_TEXTS.manualOnly(name));
    return { node, kind };
  }
  const startable = definition.nodes.filter((n) => {
    const kind = MCP_TRIGGER_KINDS[n.type];
    return !n.disabled && kind !== undefined && (kind !== 'manual' || mode === 'manual');
  });
  if (startable.length > 1)
    throw new McpToolError(MCP_RUN_TEXTS.severalTriggers(startable.map((n) => n.name)));
  if (startable.length === 1) return { node: startable[0], kind: MCP_TRIGGER_KINDS[startable[0].type] };
  const triggers = definition.nodes.filter((n) => isTrigger(ctx, n));
  if (triggers.length === 1) {
    const [only] = triggers;
    if (only.disabled) throw new McpToolError(MCP_RUN_TEXTS.triggerDisabled(only.name));
    if (MCP_TRIGGER_KINDS[only.type] === 'manual')
      throw new McpToolError(MCP_RUN_TEXTS.manualOnly(only.name));
    throw new McpToolError(MCP_RUN_TEXTS.triggerUnsupported(only.name, only.type));
  }
  throw new McpToolError(MCP_RUN_TEXTS.noTrigger);
}

const jsonObject = z.record(z.string(), z.unknown());

const inputsSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('chat'), chatInput: z.string().max(100_000) }),
    z.object({ type: z.literal('form'), formData: jsonObject }),
    z.object({
      type: z.literal('webhook'),
      webhookData: z
        .object({
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          query: z.record(z.string(), z.string()).optional(),
          body: z.unknown().optional(),
        })
        .default({}),
    }),
  ])
  .describe('What the trigger receives: a chat message, form fields or a webhook request');

type McpRunInputs = z.output<typeof inputsSchema>;

/** the items a trigger starts the run with, built from the client's inputs (data, never evaluated) */
function triggerItems(
  kind: McpTriggerKind,
  inputs: McpRunInputs | undefined,
  mode: 'manual' | 'production',
): Item[] {
  if (inputs && inputs.type !== kind) throw new McpToolError(MCP_RUN_TEXTS.wrongInputs(kind, inputs.type));
  const executionMode = mode === 'manual' ? 'test' : 'production';
  const now = new Date().toISOString();
  switch (kind) {
    case 'chat':
      return [
        {
          json: {
            sessionId: randomUUID(),
            action: 'sendMessage',
            chatInput: inputs?.type === 'chat' ? inputs.chatInput : '',
          },
        },
      ];
    case 'form':
      return [
        {
          json: {
            ...(inputs?.type === 'form' ? inputs.formData : {}),
            submittedAt: now,
            formMode: executionMode,
          },
        },
      ];
    case 'webhook': {
      const data: { headers?: Record<string, string>; query?: Record<string, string>; body?: unknown } =
        inputs?.type === 'webhook' ? inputs.webhookData : {};
      return [
        {
          json: {
            headers: data.headers ?? {},
            params: {},
            query: data.query ?? {},
            body: data.body ?? {},
            executionMode,
          },
        },
      ];
    }
    case 'schedule':
      return [{ json: { timestamp: now } }];
    default:
      return [{ json: {} }];
  }
}

/** a service refusal (4xx) becomes the tool's readable error; anything else stays internal */
function refusal(error: unknown): string | undefined {
  if (error instanceof McpToolError) return error.message;
  if (error instanceof ApiError && error.statusCode < 500) return error.message;
  return undefined;
}

async function definitionFor(
  ctx: ServerContext,
  caller: McpCaller,
  workflowId: string,
  mode: 'manual' | 'production',
) {
  const row = await assertWorkflowForMcp(ctx, caller, workflowId, 'run');
  if (mode === 'manual') return { row, definition: toDefinition(row) };
  let definition: WorkflowDefinition | null;
  try {
    definition = await loadPublishedDefinition(ctx.repos, caller.tenant.id, row);
  } catch {
    definition = null;
  }
  if (!definition) throw new McpToolError(MCP_RUN_TEXTS.noPublished(workflowId));
  return { row, definition };
}

const workflowId = z.uuid().describe('The id of the workflow');

const executeWorkflow: McpToolDefinition<{
  workflowId: string;
  executionMode: 'manual' | 'production';
  triggerNodeName?: string;
  inputs?: McpRunInputs;
}> = {
  name: 'execute_workflow',
  description:
    'Start a workflow available in MCP and answer at once with the execution id (read the result with get_workflow_execution). executionMode "production" runs the published version, "manual" the current draft. Webhook, form, chat and schedule triggers are supported; a manual trigger only in manual mode.',
  scopes: ['workflow:execute'],
  minRole: 'editor',
  input: z.object({
    workflowId,
    executionMode: z.enum(['manual', 'production']).default('production'),
    triggerNodeName: z.string().min(1).max(256).optional(),
    inputs: inputsSchema.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  async handler(ctx, caller, input) {
    const { row, definition } = await definitionFor(ctx, caller, input.workflowId, input.executionMode);
    const trigger = chooseTrigger(ctx, definition, input.triggerNodeName, input.executionMode);
    const items = triggerItems(trigger.kind, input.inputs, input.executionMode);
    try {
      const started = await ctx.executions.start({
        tenantId: caller.tenant.id,
        workflow: definition,
        workflowId: row.id,
        mode:
          input.executionMode === 'manual' ? 'manual' : trigger.kind === 'schedule' ? 'trigger' : 'webhook',
        startNode: trigger.node.name,
        triggerItems: items,
        userId: caller.user.id,
      });
      return { executionId: started.executionId, status: 'started' as const };
    } catch (error) {
      const text = refusal(error);
      if (text === undefined) throw error;
      return { executionId: null, status: 'error' as const, error: text };
    }
  },
};

const pinItems = z
  .array(jsonObject)
  .max(1000)
  .describe('The items the node outputs instead of running: one JSON object per item');

const testWorkflow: McpToolDefinition<{
  workflowId: string;
  pinData: Record<string, Array<Record<string, unknown>>>;
  triggerNodeName?: string;
  timeoutMs: number;
}> = {
  name: 'test_workflow',
  description:
    'Run the current draft of a workflow available in MCP with pin data (prepare it with prepare_workflow_pin_data): pinned nodes output the given items instead of running, so no outside system is called for them. Waits for the run up to timeoutMs.',
  scopes: ['workflow:execute'],
  minRole: 'editor',
  input: z.object({
    workflowId,
    pinData: z
      .record(z.string().min(1).max(256), pinItems)
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 200, {
        message: 'Give pin data for 1 to 200 nodes',
      }),
    triggerNodeName: z.string().min(1).max(256).optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  async handler(ctx, caller, input) {
    const { row, definition } = await definitionFor(ctx, caller, input.workflowId, 'manual');
    const names = new Set(definition.nodes.map((n) => n.name));
    for (const name of Object.keys(input.pinData)) {
      if (!names.has(name)) throw new McpToolError(MCP_RUN_TEXTS.unknownNode(name));
    }
    let start: WorkflowNode | undefined;
    if (input.triggerNodeName !== undefined) {
      start = definition.nodes.find((n) => n.name === input.triggerNodeName && isTrigger(ctx, n));
      if (!start) throw new McpToolError(MCP_RUN_TEXTS.triggerNotFound(input.triggerNodeName));
    } else {
      const triggers = definition.nodes.filter((n) => !n.disabled && isTrigger(ctx, n));
      if (triggers.length > 1)
        throw new McpToolError(MCP_RUN_TEXTS.severalTriggers(triggers.map((n) => n.name)));
      start = triggers[0];
    }
    if (!start) throw new McpToolError(MCP_RUN_TEXTS.noTrigger);
    const pinData = Object.fromEntries(
      Object.entries(input.pinData).map(([name, items]) => [
        name,
        items.map((json) => ({ json: json as DataObject })),
      ]),
    ) as Record<string, Item[]>;
    let executionId: string;
    let finished: Promise<unknown> | undefined;
    try {
      const started = await ctx.executions.start({
        tenantId: caller.tenant.id,
        workflow: definition,
        workflowId: row.id,
        mode: 'manual',
        startNode: start.name,
        triggerItems: pinData[start.name] ? undefined : [{ json: {} }],
        pinData,
        userId: caller.user.id,
        wait: true,
      });
      executionId = started.executionId;
      finished = started.finished;
    } catch (error) {
      const text = refusal(error);
      if (text === undefined) throw error;
      return { executionId: null, status: 'error' as const, error: text };
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      (finished ?? Promise.resolve()).then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), input.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const execution = await ctx.repos.executions.get(caller.tenant.id, executionId);
    return {
      executionId,
      status: execution?.status ?? 'running',
      timedOut,
      ...(execution?.errorMessage ? { error: execution.errorMessage, errorNode: execution.errorNode } : {}),
    };
  },
};

const preparePinData: McpToolDefinition<{ workflowId: string }> = {
  name: 'prepare_workflow_pin_data',
  description:
    'List the nodes of a workflow available in MCP that need pin data for test_workflow (its triggers and the nodes that call outside systems with credentials), with the pin data already saved for them and a template to fill.',
  scopes: ['workflow:execute'],
  minRole: 'editor',
  input: z.object({ workflowId }),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async handler(ctx, caller, input) {
    const row = await assertWorkflowForMcp(ctx, caller, input.workflowId, 'run');
    const nodes = sanitizeNodeCredentials(row.nodes);
    const saved = (row.pinData ?? {}) as Record<string, Item[]>;
    const needed = nodes
      .filter((n) => !n.disabled)
      .flatMap((n) => {
        const trigger = isTrigger(ctx, n);
        const credentials = Object.keys(n.credentials ?? {}).length > 0;
        if (!trigger && !credentials) return [];
        const pinned = Array.isArray(saved[n.name]) ? saved[n.name] : [];
        return [
          {
            name: n.name,
            type: n.type,
            reason: trigger ? ('trigger' as const) : ('credentials' as const),
            savedPinData: pinned.slice(0, 5).map((item) => item.json),
          },
        ];
      });
    return {
      workflowId: row.id,
      nodes: needed,
      template: Object.fromEntries(
        needed.map((n) => [n.name, n.savedPinData.length ? n.savedPinData : [{}]]),
      ),
      hint: 'Fill the template with realistic items (one JSON object per item) and pass it as pinData to test_workflow.',
    };
  },
};

export const runTools: McpToolDefinition<any>[] = [executeWorkflow, testWorkflow, preparePinData];
