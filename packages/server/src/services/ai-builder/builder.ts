/**
 * The AI workflow builder service (P5-09, L1). One `build` call is one turn:
 * 1. load the session and the draft, build the `BuilderTurnState` (turn-local AbortController joined
 *    to `signal` with `AbortSignal.any`; `stopTurn` aborts it with `BUILDER_TURN_STOP`);
 * 2. the seams, in this order: `applyPlanResume` (plan.ts), `applyWebFetchResume` (web-fetch.ts),
 *    `maybeCompact` (compaction.ts);
 * 3. only then read `state.mode`: build mode offers `createBuilderTools` plus `webFetchTools`, plan mode
 *    only `planTools(state, readBuilderTools(draft, deps))`; `promptNotes` go into the turn's input;
 * 4. `runAgent` from `loadAiRuntime`, at most 50 iterations, streamed text as `message` chunks;
 * 5. `saveTurn`. A `BUILDER_TURN_STOP` abort is a clean end (turn saved, no `error` chunk).
 *
 * Nothing here saves the workflow or runs it: the draft reaches the editor as `workflow-updated` and
 * only the user's Accept saves it. No prompt, message or body is logged.
 */
import { randomUUID } from 'node:crypto';
import {
  type AiChatMessage,
  type AiMemory,
  BUILDER_MAX_ITERATIONS,
  BUILDER_PROMPT_LIMIT,
  BUILDER_PROMPT_TOO_LONG,
  type BuilderChunk,
  type BuilderMessage,
  type BuildRequest,
  redactSecrets,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { TenantRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError, parse } from '../../http/errors';
import { workflowDataSchema } from '../../http/schemas';
import type { TenantSettings } from '../../plans';
import { cloneDefinition, toDefinition } from '../workflow-model';
import { maybeCompact } from './compaction';
import { buildWorkflowContext } from './context';
import { BuilderDraft } from './draft';
import {
  BUILDER_NODE_NAME,
  type BuilderModel,
  BuilderModelError,
  loadBuilderModel,
  NO_AI_PACKAGE,
} from './model';
import { applyPlanResume, planTools } from './plan';
import { builderSystemPrompt } from './prompt';
import { type AiRuntime, loadAiRuntime } from './runtime';
import { loadSession, saveTurn } from './sessions';
import { type BuilderToolDeps, createBuilderTools, readBuilderTools } from './tools';
import { BUILDER_TURN_STOP, type BuilderTurnState, isBuilderTurnStop } from './types';
import { applyWebFetchResume, webFetchTools } from './web-fetch';

/** n8n's title of a failed builder turn */
export const BUILDER_ERROR_TITLE = 'Workflow update failed';
/** earlier messages the model sees as conversation (the summary covers older ones, L6) */
const HISTORY_MESSAGES = 20;

/** the message a client sees for a failed turn: our own refusals as written, other errors redacted */
function errorMessageOf(error: unknown): string {
  if (error instanceof BuilderModelError || error instanceof ApiError) return error.message;
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text) || 'The AI model did not answer';
}

/** the earlier conversation as chat messages (no memory store: the session row is the memory) */
function historyMemory(messages: BuilderMessage[]): AiMemory {
  const history: AiChatMessage[] = messages
    .filter((m) => m.text)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.text }));
  return {
    kind: 'memory',
    load: async () => history,
    loadAll: async () => history,
    // the turn is saved by `saveTurn`, never through the agent loop
    append: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
}

export class AiBuilderService {
  private runtimePromise?: Promise<AiRuntime | undefined>;
  private readonly running = new Set<AbortController>();

  /** `runtimeOverride` is `createContext`'s `aiRuntime` option (tests); else the installed AI package */
  constructor(
    readonly deps: ServiceDeps,
    private readonly runtimeOverride?: AiRuntime,
  ) {}

  /** the AI runtime, loaded once; undefined when the AI package is not installed */
  runtime(): Promise<AiRuntime | undefined> {
    this.runtimePromise ??= loadAiRuntime(this.runtimeOverride);
    return this.runtimePromise;
  }

  /** the draft's start: the editor's unsaved data (this workflow's only) or the saved row */
  private async startDefinition(tenant: TenantRow, request: BuildRequest): Promise<WorkflowDefinition> {
    const ctx = this.deps.context();
    const row = await ctx.repos.workflows.get(tenant.id, request.workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    let definition: WorkflowDefinition;
    if (request.workflowData !== undefined) {
      const data = parse(workflowDataSchema, request.workflowData);
      if (data.id !== undefined && data.id !== row.id) {
        throw ApiError.badRequest('The workflow data belongs to another workflow');
      }
      definition = {
        ...cloneDefinition(data as unknown as WorkflowDefinition),
        id: row.id,
        versionId: row.versionId,
      };
    } else {
      definition = toDefinition(row);
    }
    // static data is the server's: the editor and the model never need it
    delete definition.staticData;
    return definition;
  }

  /** one builder turn; every chunk goes out through `write` (NDJSON, the route owns the wire) */
  async build(
    auth: AuthContext,
    request: BuildRequest,
    write: (chunk: BuilderChunk) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const ctx = this.deps.context();
    if (typeof request.text !== 'string' || request.text.length > BUILDER_PROMPT_LIMIT) {
      throw ApiError.badRequest(BUILDER_PROMPT_TOO_LONG);
    }
    // the stored settings, not the copy the session loaded with
    const tenant = (await ctx.repos.tenants.get(auth.tenant.id)) ?? auth.tenant;
    const definition = await this.startDefinition(tenant, request);
    const workflowId = definition.id as string;
    const settings = (tenant.settings ?? {}) as TenantSettings;
    const sendValues = settings.ai?.allowSendingParameterValues ?? ctx.config.ai.allowSendingParameterValues;
    const text = redactSecrets(request.text);

    const session = await loadSession(ctx, { tenantId: tenant.id, workflowId, userId: auth.user.id });
    const stop = new AbortController();
    this.running.add(stop);
    const turnSignal = AbortSignal.any([
      signal,
      stop.signal,
      AbortSignal.timeout(ctx.config.ai.timeoutMaxS * 1000),
    ]);
    const emit = (chunk: BuilderChunk) => {
      if (!signal.aborted) write(chunk);
    };
    const draft = new BuilderDraft(definition, ctx.registries.nodeTypes);
    const state: BuilderTurnState = {
      mode: request.mode === 'plan' ? 'plan' : 'build',
      session,
      draft,
      emit,
      signal: turnSignal,
      promptNotes: [],
      stopTurn: () => stop.abort(BUILDER_TURN_STOP),
    };
    const deps: BuilderToolDeps = { ctx, tenant, emit, workflowId, sendValues };
    const createdAt = new Date().toISOString();
    const userMessage: BuilderMessage | undefined = text.trim()
      ? { id: randomUUID(), role: 'user', text, createdAt }
      : undefined;
    const assistantId = randomUUID();
    let reply = '';
    let streamed = false;
    let model: BuilderModel | undefined;
    /** where this turn's messages start in `state.session.messages`; unset when the turn failed early */
    let turnStart: number | undefined;

    try {
      const runtime = await this.runtime();
      if (!runtime) throw new BuilderModelError(NO_AI_PACKAGE);
      model = await loadBuilderModel(ctx, tenant, turnSignal);

      // a seam may end the turn (`stopTurn`): the later seams and the model call are skipped
      const stopped = () => {
        if (turnSignal.aborted) throw turnSignal.reason;
      };
      applyPlanResume(state, request.resumeData);
      stopped();
      await applyWebFetchResume(state, request.resumeData, deps);
      stopped();
      await maybeCompact({
        session: state.session,
        model: model.model,
        signal: turnSignal,
        emit,
        pending: userMessage,
      });
      stopped();

      // the seams are done: the mode is final for this turn
      const history = state.session.messages.slice();
      turnStart = state.session.messages.length;
      if (userMessage) state.session.messages.push(userMessage);
      const tools =
        state.mode === 'plan'
          ? planTools(state, readBuilderTools(draft, deps))
          : [...createBuilderTools(draft, deps), ...webFetchTools(state, deps)];
      const context = await buildWorkflowContext({
        ctx,
        tenant,
        workflowId,
        definition: draft.definition(),
        sendValues,
      });
      const input = [
        context,
        ...state.promptNotes,
        userMessage ? `The user's request:\n${text}` : 'Continue with the request above.',
      ].join('\n\n');
      const builderNode: WorkflowNode = {
        id: randomUUID(),
        name: BUILDER_NODE_NAME,
        type: 'ai.agent',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      };

      const result = await runtime.runAgent({
        node: builderNode,
        itemIndex: 0,
        model: model.model,
        tools,
        memory: { ...historyMemory(history), sessionId: assistantId },
        sessionId: assistantId,
        systemMessage: builderSystemPrompt(state.mode, state.session.previousSummary ?? undefined),
        input,
        maxIterations: BUILDER_MAX_ITERATIONS,
        toolErrorBehavior: 'feedback',
        streaming: true,
        onChunk: (delta) => {
          if (!delta) return;
          streamed = true;
          emit({ type: 'message', id: assistantId, text: delta, delta: true });
        },
        signal: turnSignal,
      });
      reply = redactSecrets(result.text ?? '');
      if (!streamed && reply) emit({ type: 'message', id: assistantId, text: reply });
    } catch (error) {
      const stopped = isBuilderTurnStop(stop.signal) || isBuilderTurnStop(error);
      if (!stopped && !signal.aborted) {
        ctx.logger.warn(
          { tenantId: tenant.id, workflowId, error: error instanceof Error ? error.name : 'unknown' },
          'AI builder turn failed',
        );
        emit({ type: 'error', title: BUILDER_ERROR_TITLE, message: errorMessageOf(error) });
      }
    } finally {
      this.running.delete(stop);
      await model?.close().catch(() => {});
    }

    await this.save(state, turnStart, userMessage, { id: assistantId, text: reply, createdAt });
  }

  /**
   * Saves the turn: the user's message, then one assistant message with the reply and whatever a tool
   * put on an assistant message during the turn (a plan or questions, L3).
   */
  private async save(
    state: BuilderTurnState,
    turnStart: number | undefined,
    userMessage: BuilderMessage | undefined,
    reply: { id: string; text: string; createdAt: string },
  ): Promise<void> {
    const ctx = this.deps.context();
    const all = state.session.messages;
    const base = turnStart === undefined ? all : all.slice(0, turnStart);
    // what the tools added during the turn (a plan or questions on an assistant message)
    const added = turnStart === undefined ? [] : all.slice(turnStart).filter((m) => m !== userMessage);
    const toolMessages = added.filter((m) => m.role === 'assistant');
    const assistant: BuilderMessage = {
      id: reply.id,
      role: 'assistant',
      text:
        reply.text ||
        toolMessages
          .map((m) => m.text)
          .filter(Boolean)
          .join('\n\n'),
      createdAt: reply.createdAt,
      ...Object.assign(
        {},
        ...toolMessages.map((m) => ({
          ...(m.plan ? { plan: m.plan } : {}),
          ...(m.questions ? { questions: m.questions } : {}),
          ...(m.versionId ? { versionId: m.versionId } : {}),
        })),
      ),
    };
    const turn: BuilderMessage[] = [
      ...(userMessage ? [userMessage] : []),
      ...added.filter((m) => m.role !== 'assistant'),
      ...(assistant.text || assistant.plan || assistant.questions ? [assistant] : []),
    ];
    try {
      await saveTurn(ctx, { ...state.session, messages: base }, turn);
    } catch (error) {
      ctx.logger.warn(
        {
          tenantId: state.session.tenantId,
          workflowId: state.session.workflowId,
          error: (error as Error).name,
        },
        'AI builder session save failed',
      );
    }
  }

  /** stops running turns on shutdown */
  async close(): Promise<void> {
    for (const stop of this.running) stop.abort(BUILDER_TURN_STOP);
    this.running.clear();
  }
}
