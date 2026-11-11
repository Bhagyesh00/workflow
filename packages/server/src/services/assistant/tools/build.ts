/**
 * Assistant tools: build and verify a draft workflow (P5-70, lane L7).
 *
 * `build_workflow` (editor, no card: nothing is saved) runs a nested agent with the workflow builder's
 * draft tools (`createBuilderTools`, S4) on a draft that starts from an open draft of this thread, the
 * workspace's saved workflow, or nothing. Same model as the turn, its own limit of 50 steps, capped at
 * `AI_TIMEOUT_MAX`; each builder step shows as a live `status` event. After the loop the draft is
 * checked (`validateDefinition`) and stored on the thread with its base version, and an `artifact`
 * event names it. A credential the model writes is dropped by the builder tools; only a person's Accept
 * (routes/assistant-drafts.ts) saves anything. Refused while the admin blocked creating (new) or
 * updating (existing) workflows.
 *
 * `verify_workflow` (editor, no card: nothing live runs) runs a stored draft once in mode `manual`
 * through `runAndCollect` with every node `planVerify` does not allow pinned to its fixture (or one
 * empty item), so a node that calls out, holds a credential, waits or reads `$vars` never runs, and the
 * sub-nodes under a pinned root never run either. Fixtures are JSON items, only for simulated nodes,
 * 256 KB at most, no binary, and are pinned as they are (data, never read as expressions). A run that
 * parks (`waiting`) is a failure. Refused while the admin blocked running workflows.
 */
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_STREAM,
  type AssistantPermissionKey,
  BUILDER_MAX_ITERATIONS,
  BUILDER_PROMPT_LIMIT,
  type BuilderChunk,
  type DataObject,
  type DoctorIssue,
  type Item,
  redactSecrets,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../context';
import type { AssistantStoredDraft } from '../../../db/schema';
import type { TenantSettings } from '../../../plans';
import { buildWorkflowContext, sanitizeForModel, wrapUntrusted } from '../../ai-builder/context';
import { BuilderDraft } from '../../ai-builder/draft';
import { BuilderModelError, NO_AI_PACKAGE } from '../../ai-builder/model';
import { builderSystemPrompt } from '../../ai-builder/prompt';
import { type BuilderToolDeps, createBuilderTools, validateDefinition } from '../../ai-builder/tools';
import { PROTECTED_TEXT } from '../../protected';
import { cloneDefinition, toDefinition } from '../../workflow-model';
import { draftStatus } from '../drafts';
import { loadAssistantModel } from '../model';
import { guardModel } from '../model-guard';
import { RUN_PREVIEW, type RunOutcome, runAndCollect, triggerPinData } from '../run-helper';
import { protectedActionFor } from '../settings';
import {
  type AssistantRunScope,
  type AssistantToolDefinition,
  assertScope,
  projectIdInput,
  writeProject,
} from '../types';
import { planVerify } from '../verify-plan';

/** what a tool refused by the admin answers (approvals.ts uses the same words) */
export const BUILD_BLOCKED = 'An admin turned this off';
/** a verify run's time limit, `run_workflow`'s default */
export const VERIFY_TIMEOUT_MS = 5 * 60_000;
/** the most fixture data one verify call takes */
export const VERIFY_FIXTURE_BYTES = 256 * 1024;

/**
 * Refuses a build or verify call whose permission key is blocked: the protected workspace's own text when
 * the workspace is protected (the key reads `blocked` only because of that), else the admin's.
 */
function assertBuildAllowed(run: AssistantRunScope, key: AssistantPermissionKey): void {
  const action = protectedActionFor(run.tenant.settings as TenantSettings, key);
  if (action) throw new Error(PROTECTED_TEXT[action]);
  if (run.settings.permissions[key] === 'blocked') throw new Error(BUILD_BLOCKED);
}

export const BUILD_TEXTS = {
  noDraft: (id: string) => `There is no draft "${id}" in this chat`,
  draftClosed: 'That draft was accepted or discarded. Build again without draftId to start a new one.',
  notFound: 'Workflow not found',
  saved: 'Nothing is saved yet: the person reviews the draft in the chat, then accepts or discards it.',
} as const;

export const VERIFY_TEXTS = {
  discarded: 'That draft was discarded. Build it again first.',
  empty: 'The draft has no nodes to run.',
  fixtureNode: (name: string) => `There is no node "${name}" in the draft`,
  fixtureRuns: (name: string) =>
    `"${name}" runs for real in a verify run, so it takes no fixture. Give fixtures only for simulated nodes.`,
  fixtureBinary: 'Fixtures hold JSON items only; binary data is not allowed.',
  fixtureItem: 'Each fixture item must be a JSON object.',
  fixtureSize: `Fixtures and input data are limited to ${VERIFY_FIXTURE_BYTES / 1024} KB.`,
  simulationNote:
    'The nodes in simulatedNodes did not run: each returned its fixture, or one empty item. Nothing was sent outside and no credential was used, so their output is not real. After the person accepts the draft, run_workflow runs it for real.',
  waiting:
    'The run stopped to wait (for example a Wait node or a form). A verify run must finish, so this counts as a failure.',
  stopped: 'The run was stopped before it finished.',
  timedOut: `The run did not finish within ${VERIFY_TIMEOUT_MS / 60_000} minutes.`,
} as const;

// ---------------------------------------------------------------------------------------------
// helpers

/** the thread's stored draft, or undefined */
async function threadDraft(
  ctx: ServerContext,
  run: AssistantRunScope,
  draftId: string,
): Promise<AssistantStoredDraft | undefined> {
  const drafts = await ctx.repos.assistantThreads.getDrafts(run.tenant.id, run.threadId);
  const stored = Object.hasOwn(drafts, draftId) ? drafts[draftId] : undefined;
  return stored && typeof stored === 'object' && stored.definition ? stored : undefined;
}

/** a draft's name from the request: its first line, cut */
function nameFromRequest(request: string): string {
  const line = request.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const name = line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
  return name || 'My workflow';
}

interface BuildStart {
  draftId: string;
  name: string;
  workflowId: string | null;
  baseVersionId: string | null;
  definition: WorkflowDefinition;
  createdAt: string;
  /** the project the draft is saved in when it is accepted (a new workflow); null for a saved workflow's own */
  projectId: string | null;
}

/** where a build starts: an open draft of this thread, the workspace's saved workflow, or nothing */
async function buildStart(
  ctx: ServerContext,
  run: AssistantRunScope,
  input: BuildInput,
): Promise<BuildStart> {
  if (input.draftId) {
    const stored = await threadDraft(ctx, run, input.draftId);
    if (!stored) throw new Error(BUILD_TEXTS.noDraft(input.draftId));
    if (draftStatus(stored) !== 'open') throw new Error(BUILD_TEXTS.draftClosed);
    // the scope on what the draft changes, read now: a project lost since the draft was made stops the build
    let projectId: string | null = null;
    if (stored.workflowId) {
      await assertScope(ctx, run, 'workflow:update', { workflowId: stored.workflowId });
    } else {
      projectId = await writeProject(
        ctx,
        run,
        'workflow:create',
        typeof stored.projectId === 'string' ? stored.projectId : undefined,
      );
    }
    return {
      projectId,
      draftId: stored.id,
      name: stored.name,
      workflowId: stored.workflowId ?? null,
      baseVersionId: stored.baseVersionId ?? null,
      definition: cloneDefinition(stored.definition),
      createdAt: stored.createdAt,
    };
  }
  const createdAt = new Date().toISOString();
  if (input.workflowId) {
    // a saved workflow is changed through a draft only by someone who may change it
    const row = await ctx.repos.workflows.get(run.tenant.id, input.workflowId);
    if (!row) throw new Error(BUILD_TEXTS.notFound);
    await assertScope(ctx, run, 'workflow:update', { workflowId: row.id });
    const definition = cloneDefinition(toDefinition(row));
    // static data is the server's: a draft never carries it
    delete definition.staticData;
    return {
      draftId: randomUUID(),
      name: row.name,
      workflowId: row.id,
      baseVersionId: row.versionId,
      definition,
      createdAt,
      projectId: null,
    };
  }
  // a new workflow: the named project, else the caller's default, with `workflow:create` there
  const projectId = await writeProject(ctx, run, 'workflow:create', input.projectId);
  const name = nameFromRequest(input.request);
  return {
    projectId,
    draftId: randomUUID(),
    name,
    workflowId: null,
    baseVersionId: null,
    definition: { name, nodes: [], connections: {}, settings: {} },
    createdAt,
  };
}

/** the workflow as the nested builder reads it first */
async function contextText(
  ctx: ServerContext,
  run: AssistantRunScope,
  start: BuildStart,
  definition: WorkflowDefinition,
): Promise<string> {
  if (start.workflowId) {
    return buildWorkflowContext({
      ctx,
      tenant: run.tenant,
      workflowId: start.workflowId,
      definition,
      sendValues: run.sendValues,
      userId: run.user.id,
    });
  }
  if (!definition.nodes.length) return 'The workflow is empty.';
  return `The current workflow (nodes, parameters and connections${run.sendValues ? '' : '; values are hidden by a workspace setting'}):\n${wrapUntrusted(
    'workflow',
    JSON.stringify(sanitizeForModel(definition, { sendValues: run.sendValues })),
  )}`;
}

/** a builder step as a live progress line */
function progressText(chunk: BuilderChunk): string | null {
  if (chunk.type !== 'tool') return null;
  if (chunk.status === 'running') return `Building: ${chunk.toolName}`;
  if (chunk.status === 'error') return `Building: ${chunk.toolName} failed`;
  return null;
}

/** an issue as the model reads it; with values off, no message (some quote a parameter value) */
function issueView(issue: DoctorIssue, sendValues: boolean) {
  return {
    severity: issue.severity,
    ...(issue.code ? { code: issue.code } : {}),
    ...(issue.node ? { node: issue.node } : {}),
    ...(sendValues ? { message: redactSecrets(issue.message) } : {}),
  };
}

const BUILD_NODE: WorkflowNode = {
  id: 'assistant-build',
  name: 'Assistant workflow builder',
  type: 'ai.agent',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

// ---------------------------------------------------------------------------------------------
// build_workflow

const buildInput = z.object({
  request: z
    .string()
    .trim()
    .min(1)
    .max(BUILDER_PROMPT_LIMIT)
    .describe('What the workflow should do, or what to change, in plain words'),
  workflowId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('A saved workflow to change; leave out to build a new one'),
  draftId: z.string().min(1).max(64).optional().describe('An open draft of this chat to keep working on'),
  projectId: projectIdInput.describe('For a new workflow: the project it is saved in; yours when left out'),
});

type BuildInput = z.output<typeof buildInput>;

export interface BuildWorkflowResult {
  draftId: string;
  name: string;
  workflowId: string | null;
  nodeCount: number;
  valid: boolean;
  issues: ReturnType<typeof issueView>[];
  saved: false;
  note: string;
  builderReply: string;
}

export const buildWorkflowTool: AssistantToolDefinition<BuildInput> = {
  name: 'build_workflow',
  description:
    'Build a new workflow, or change a saved one, as a draft. Describe the whole request in plain words. Nothing is saved: the person sees the draft in the chat and accepts or discards it. Pass draftId to keep working on a draft of this chat, or workflowId to change a saved workflow. Call verify_workflow on the draft to test it safely.',
  input: buildInput,
  access: 'workflow:create',
  target: (input) => (input.projectId && !input.workflowId ? { projectId: input.projectId } : null),
  untrusted: 'workflow-draft',
  artifact(_input, result) {
    const built = result as BuildWorkflowResult | undefined;
    return built?.draftId ? { type: 'draft', draftId: built.draftId, name: built.name } : null;
  },
  async handler(ctx, run, input): Promise<BuildWorkflowResult> {
    const start = await buildStart(ctx, run, input);
    const key = start.workflowId ? 'updateWorkflow' : 'createWorkflow';
    assertBuildAllowed(run, key);

    const runtime = await ctx.assistant.runtime();
    if (!runtime) throw new BuilderModelError(NO_AI_PACKAGE);
    const signal = AbortSignal.any([run.signal, AbortSignal.timeout(ctx.config.ai.timeoutMaxS * 1000)]);
    const model = await loadAssistantModel(ctx, run.tenant, run.settings, signal);
    const draft = new BuilderDraft(start.definition, ctx.registries.nodeTypes);
    let reply = '';
    try {
      const guarded = guardModel(model.model, {
        idleMs: ctx.config.assistant.streamIdleTimeoutMs,
        firstOutputMs: ctx.config.assistant.streamFirstOutputTimeoutMs,
        stallRetries: ASSISTANT_STREAM.stallRetries,
      });
      const deps: BuilderToolDeps = {
        ctx,
        tenant: run.tenant,
        emit: (chunk) => {
          const message = progressText(chunk);
          if (message) run.emit({ type: 'status', runId: run.runId, payload: { message } });
        },
        ...(start.workflowId ? { workflowId: start.workflowId } : {}),
        sendValues: run.sendValues,
        // P6-53: `get_execution_schema` reads the last run as this user
        userId: run.user.id,
      };
      const context = await contextText(ctx, run, start, draft.definition());
      const result = await runtime.runAgent({
        node: BUILD_NODE,
        itemIndex: 0,
        model: guarded,
        tools: createBuilderTools(draft, deps),
        systemMessage: builderSystemPrompt('build'),
        input: `${context}\n\nThe user's request:\n${redactSecrets(input.request)}`,
        maxIterations: BUILDER_MAX_ITERATIONS,
        toolErrorBehavior: 'feedback',
        streaming: false,
        signal,
      });
      reply = redactSecrets(result.text ?? '').slice(0, 4000);
    } finally {
      await model.close().catch(() => {});
    }

    const definition = draft.definition();
    definition.name = start.name;
    const validation = await validateDefinition(
      ctx,
      run.tenant.id,
      definition,
      start.workflowId ?? undefined,
    );
    const now = new Date().toISOString();
    const stored: AssistantStoredDraft = {
      id: start.draftId,
      name: start.name,
      workflowId: start.workflowId,
      baseVersionId: start.baseVersionId,
      ...(start.projectId ? { projectId: start.projectId } : {}),
      definition,
      createdAt: start.createdAt,
      updatedAt: now,
      status: 'open',
      nodeCount: definition.nodes.length,
      issues: validation.issues,
    };
    await ctx.assistantDrafts.put(run.tenant.id, run.threadId, stored);
    return {
      draftId: stored.id,
      name: stored.name,
      workflowId: stored.workflowId,
      nodeCount: definition.nodes.length,
      valid: validation.valid,
      issues: validation.issues.map((issue) => issueView(issue, run.sendValues)),
      saved: false,
      note: BUILD_TEXTS.saved,
      builderReply: reply,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// verify_workflow

const verifyInput = z.object({
  draftId: z.string().min(1).max(64).describe('The draft to test (from build_workflow)'),
  inputData: z
    .unknown()
    .optional()
    .describe('Data for the trigger, as that trigger would receive it (for example a webhook body)'),
  fixtures: z
    .record(z.string().min(1).max(128), z.array(z.record(z.string(), z.unknown())).max(100))
    .optional()
    .describe(
      'Output items for simulated nodes, by node name: an array of JSON objects per node. Nodes without a fixture return one empty item.',
    ),
});

type VerifyInput = z.output<typeof verifyInput>;

/** a fixture as pinned items: JSON only (`{ json }` or the object itself), never binary */
function fixtureItems(list: Array<Record<string, unknown>>): Item[] {
  return list.map((entry) => {
    if ('binary' in entry) throw new Error(VERIFY_TEXTS.fixtureBinary);
    const keys = Object.keys(entry);
    const wrapped = keys.length === 1 && keys[0] === 'json';
    const json = wrapped ? entry.json : entry;
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error(VERIFY_TEXTS.fixtureItem);
    }
    return { json: structuredClone(json) as DataObject };
  });
}

/** how a verify run ended: only `success` passes; `waiting`, a timeout and a stop are failures */
export function verifyVerdict(
  outcome: Pick<RunOutcome, 'status' | 'aborted' | 'error'> & Partial<Pick<RunOutcome, 'redaction'>>,
): {
  success: boolean;
  reason?: string;
} {
  switch (outcome.status) {
    case 'success':
      return { success: true };
    case 'waiting':
      return { success: false, reason: VERIFY_TEXTS.waiting };
    case 'timedOut':
      return { success: false, reason: outcome.aborted ? VERIFY_TEXTS.stopped : VERIFY_TEXTS.timedOut };
    default:
      return {
        success: false,
        // P6-53: a redacted run's error text never reaches the model
        reason:
          outcome.error?.message && !isManualRedacted(outcome)
            ? redactSecrets(outcome.error.message).slice(0, 1000)
            : `The run ended with status "${outcome.status}".`,
      };
  }
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** a value as the model may read it: strings redacted then cut, sizes held to `RUN_PREVIEW` */
function previewValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string')
    return cut(redactSecrets(value.slice(0, RUN_PREVIEW.valueChars * 4)), RUN_PREVIEW.valueChars);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object')
    return value === undefined ? null : cut(String(value), RUN_PREVIEW.valueChars);
  if (depth >= RUN_PREVIEW.depth) return '[…]';
  if (Array.isArray(value)) {
    const shown = value.slice(0, RUN_PREVIEW.arrayItems).map((v) => previewValue(v, depth + 1));
    if (value.length > RUN_PREVIEW.arrayItems) shown.push(`[${value.length - RUN_PREVIEW.arrayItems} more]`);
    return shown;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries.slice(0, RUN_PREVIEW.keys)) out[cut(key, 200)] = previewValue(v, depth + 1);
  if (entries.length > RUN_PREVIEW.keys) out['[more keys]'] = entries.length - RUN_PREVIEW.keys;
  return out;
}

function previewItem(item: Item): DataObject {
  const out: DataObject = { json: previewValue(item.json ?? {}, 0) as DataObject };
  if (item.binary && typeof item.binary === 'object') {
    const files: DataObject = {};
    for (const [key, file] of Object.entries(item.binary)) {
      files[cut(key, 200)] = {
        fileName: typeof file?.fileName === 'string' ? cut(redactSecrets(file.fileName), 200) : null,
        mimeType: typeof file?.mimeType === 'string' ? cut(file.mimeType, 200) : null,
        fileSize: typeof file?.fileSize === 'number' ? file.fileSize : null,
      };
    }
    out.binary = files;
  }
  return out;
}

export interface VerifyNodePreview {
  node: string;
  simulated: boolean;
  ran: boolean;
  status?: string | null;
  outputs?: Array<{ itemCount: number; items?: DataObject[] }>;
  error?: string;
}

/** per node of the draft: simulated or not, whether it ran, item counts and (values on) the first items */
function nodePreviews(
  definition: WorkflowDefinition,
  simulated: Set<string>,
  outcome: RunOutcome,
  sendValues: boolean,
): VerifyNodePreview[] {
  // P6-53: the Assistant only starts manual-mode runs (run-helper), so only the manual channel applies. A
  // run whose manual channel is redacted (its own snapshot or a sub-workflow's report) shows the
  // model counts and statuses only: no item values and no error text, as `previewOutput` shows no values
  const redacted =
    outcome.redaction?.own.manual === true || outcome.redaction?.fromSubWorkflows.manual === true;
  return definition.nodes.map((node) => {
    const runs = outcome.runData?.[node.name];
    const last = Array.isArray(runs) ? runs[runs.length - 1] : undefined;
    if (!last) return { node: node.name, simulated: simulated.has(node.name), ran: false };
    const outputs = (last.data?.main ?? []).map((items) => {
      const list = Array.isArray(items) ? items : [];
      return {
        itemCount: list.length,
        ...(sendValues && !redacted ? { items: list.slice(0, RUN_PREVIEW.items).map(previewItem) } : {}),
      };
    });
    return {
      node: node.name,
      simulated: simulated.has(node.name),
      ran: true,
      status: last.executionStatus ?? null,
      outputs,
      ...(last.error?.message && !redacted
        ? { error: cut(redactSecrets(String(last.error.message)), 500) }
        : {}),
    };
  });
}

/** P6-53: the manual channel is on in the run's own snapshot or in what its sub-workflows reported */
function isManualRedacted(outcome: Partial<Pick<RunOutcome, 'redaction'>>): boolean {
  return outcome.redaction?.own.manual === true || outcome.redaction?.fromSubWorkflows.manual === true;
}

/** names of nodes that ran and returned no item on any output, so the nodes after them did not run */
function emptyOutputNote(previews: VerifyNodePreview[]): string | undefined {
  const empty = previews
    .filter((p) => p.ran && (p.outputs ?? []).every((o) => o.itemCount === 0))
    .map((p) => `"${p.node}"`);
  if (!empty.length) return undefined;
  return `${empty.join(', ')} returned no items, so the nodes after them did not run. Give fixtures with data to the simulated nodes before them to test that part.`;
}

export interface VerifyWorkflowResult {
  success: boolean;
  status: RunOutcome['status'];
  executionId?: string;
  reason?: string;
  simulatedNodes: string[];
  executedNodes: string[];
  simulationNote: string;
  emptyOutputNote?: string;
  nodePreviews: VerifyNodePreview[];
  itemValues?: string;
}

export const verifyWorkflowTool: AssistantToolDefinition<VerifyInput> = {
  name: 'verify_workflow',
  description:
    'Test a draft safely before the person accepts it. Data-only nodes (Set, If, Switch, Filter, Merge, Sort and similar) run for real; every other node, every trigger and every node with a credential is simulated with its fixture or one empty item, so nothing is sent outside. Give inputData for the trigger and fixtures for simulated nodes. A run that waits counts as a failure.',
  input: verifyInput,
  access: 'workflow:create',
  untrusted: 'execution-output',
  async handler(ctx, run, input): Promise<VerifyWorkflowResult> {
    assertBuildAllowed(run, 'runWorkflow');
    const stored = await threadDraft(ctx, run, input.draftId);
    if (!stored) throw new Error(BUILD_TEXTS.noDraft(input.draftId));
    if (draftStatus(stored) === 'discarded') throw new Error(VERIFY_TEXTS.discarded);

    // the project the draft runs in: a saved workflow's own (the caller must be able to run it), else the
    // project it was built for (the caller must be able to build there), read now
    let projectId: string;
    if (stored.workflowId) {
      await assertScope(ctx, run, 'workflow:execute', { workflowId: stored.workflowId });
      projectId =
        (await ctx.repos.workflows.get(run.tenant.id, stored.workflowId))?.projectId ??
        (await writeProject(ctx, run, 'workflow:create'));
    } else {
      projectId = await writeProject(
        ctx,
        run,
        'workflow:create',
        typeof stored.projectId === 'string' ? stored.projectId : undefined,
      );
    }

    const definition = cloneDefinition(stored.definition);
    // the run's pins are ours alone; the draft's own pins and static data are not used
    delete definition.pinData;
    delete definition.staticData;
    if (!definition.nodes?.length) throw new Error(VERIFY_TEXTS.empty);

    const fixtureBytes = Buffer.byteLength(JSON.stringify(input.fixtures ?? {}) ?? '');
    const inputBytes = Buffer.byteLength(JSON.stringify(input.inputData ?? null) ?? '');
    if (fixtureBytes + inputBytes > VERIFY_FIXTURE_BYTES) throw new Error(VERIFY_TEXTS.fixtureSize);

    const nodeTypes = ctx.registries.nodeTypes;
    const plan = planVerify(definition, nodeTypes);
    const simulated = new Set(plan.simulate);
    const names = new Set(definition.nodes.map((n) => n.name));
    const fixtures = new Map<string, Item[]>();
    for (const [name, list] of Object.entries(input.fixtures ?? {})) {
      if (!names.has(name)) throw new Error(VERIFY_TEXTS.fixtureNode(name));
      if (!simulated.has(name)) throw new Error(VERIFY_TEXTS.fixtureRuns(name));
      fixtures.set(name, fixtureItems(list));
    }

    // the node the run starts at (the same choice the engine makes)
    const start = new Workflow(definition, nodeTypes).getStartNode();
    const pinData: Record<string, Item[]> = {};
    for (const name of plan.simulate) {
      const fixture = fixtures.get(name);
      if (fixture) pinData[name] = fixture;
      else if (start && name === start.name)
        pinData[name] = triggerPinData(definition, name, input.inputData)[name];
      else pinData[name] = [{ json: {} }];
    }
    const triggerItems =
      start && !simulated.has(start.name) && input.inputData !== undefined
        ? triggerPinData(definition, start.name, input.inputData)[start.name]
        : undefined;

    const outcome = await runAndCollect(
      ctx,
      run,
      {
        workflow: definition,
        ...(stored.workflowId ? { workflowId: stored.workflowId } : {}),
        // a saved draft runs in its row's project, an unsaved one in the project it was built for
        projectId,
        ...(start ? { startNode: start.name } : {}),
        ...(triggerItems ? { triggerItems } : {}),
        pinData,
      },
      VERIFY_TIMEOUT_MS,
    );
    if (outcome.status === 'waiting') {
      // a verify run never stays parked: it already failed
      await ctx.executions.stop(run.tenant.id, outcome.executionId).catch(() => {});
    }
    const verdict = verifyVerdict(outcome);
    const previews = nodePreviews(definition, simulated, outcome, run.sendValues);
    const empty = verdict.success ? emptyOutputNote(previews) : undefined;
    return {
      success: verdict.success,
      status: outcome.status,
      executionId: outcome.executionId,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      simulatedNodes: plan.simulate,
      executedNodes: plan.execute,
      simulationNote: VERIFY_TEXTS.simulationNote,
      ...(empty ? { emptyOutputNote: empty } : {}),
      nodePreviews: previews,
      ...(isManualRedacted(outcome)
        ? { itemValues: 'Item values are redacted for this execution' }
        : run.sendValues
          ? {}
          : { itemValues: 'Item values are hidden by a workspace setting' }),
    };
  },
};

export const buildTools: AssistantToolDefinition[] = [buildWorkflowTool, verifyWorkflowTool];
