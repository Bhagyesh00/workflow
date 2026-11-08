/**
 * In-memory implementation of the REST + SSE contract (docs/ARCHITECTURE.md section 14). It
 * backs the self-contained demo build and the test suite (behind MSW), so both exercise the
 * real client code paths. It is a stand-in: no persistence, a single browser session.
 */
import {
  CHAT_TRIGGER_TYPE,
  type Connections,
  type DataObject,
  diffWorkflows,
  type ExecutionState,
  type Item,
  isParameterDisplayed,
  type RunData,
  resolveNodeParameters,
  type StickyNote,
  splitTemplate,
  type TaskData,
  type WorkflowNode,
  type WorkflowNodeGroup,
  type WorkflowSettings,
} from '@workflow/workflow';
import type { ApiRequest, ApiResponse } from '../api/client';
import type {
  ApiKey,
  CredentialSummary,
  ExecutionDetail,
  ExecutionSummary,
  Member,
  PushEvent,
  Role,
  Settings,
  Tag,
  Variable,
  VersionSummary,
  WorkflowDTO,
  WorkflowSummary,
} from '../api/types';
import { REDACTED } from '../api/types';
import { newId } from '../lib/ids';
import { getAncestors, getMainParents, listConnections } from '../lib/workflow-ops';
import {
  demoContacts,
  demoCredentialTypes,
  demoLoadOptions,
  demoNodeTypes,
  demoResourceMapping,
} from './fixtures';
import { filterExecutionList, registerAnnotationRoutes } from './mock-annotations';
import { registerChatRoutes } from './mock-chat';
import { registerDataTableRoutes, searchDataTables } from './mock-data-tables';
import { DEMO_EVALUATION_CONCURRENCY_LIMIT, registerEvaluationRoutes } from './mock-evaluations';
import { filterWorkflowList, registerFolderRoutes } from './mock-folders';
import { registerFormAuthRoutes } from './mock-form-auth';
import { copy, HttpError, now, page } from './mock-http';
import { registerPublishRoutes } from './mock-publish';
import { registerReviewRoutes } from './mock-reviews';
import { registerSecretRoutes } from './mock-secrets';
import { registerTriggerListenRoutes } from './mock-triggers';
import { type SimulationInput, type SimulationResult, simulateExecution } from './simulator';

/** body field `agentRequest` of POST /workflows/:id/run (P5-76 Test a tool) */
interface AgentRequest {
  query: DataObject;
  toolName: string;
}

/**
 * The webhook path of a trigger in the demo's URLs: a Webhook or Form Trigger's own path, else its
 * webhook id; a Chat Trigger's hook path is `chat` under it (`<webhookId or id>/chat`, as on the server).
 */
function hookPath(node: WorkflowNode): string {
  if (node.type === CHAT_TRIGGER_TYPE) return `${node.webhookId || node.id}/chat`;
  return String(node.parameters.path || node.webhookId || node.id);
}

/** The node a tool hangs under: non-main connections up to the first node without one. */
function toolRootName(connections: Connections, toolNode: string): string {
  const references = listConnections(connections);
  const seen = new Set([toolNode]);
  const parentOf = (name: string) =>
    references.find((c) => c.source === name && c.sourceType !== 'main' && !seen.has(c.target))?.target;
  let current = toolNode;
  let parent = parentOf(current);
  while (parent) {
    seen.add(parent);
    current = parent;
    parent = parentOf(current);
  }
  return current;
}

interface StoredUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

interface StoredTenant {
  id: string;
  name: string;
  slug: string;
}

export interface StoredWorkflow extends WorkflowDTO {
  tenantId: string;
}

export interface StoredVersion {
  versionId: string;
  workflowId: string;
  authorName: string;
  message: string | null;
  createdAt: string;
  /** P3-10 (absent = null) */
  versionName?: string | null;
  description?: string | null;
  /** P3-17 (absent = false) */
  autosaved?: boolean;
  snapshot: {
    name: string;
    nodes: WorkflowNode[];
    connections: Connections;
    settings: WorkflowSettings;
    nodeGroups?: WorkflowNodeGroup[];
  };
}

export interface StoredExecution extends ExecutionDetail {
  tenantId: string;
  cancel?: { canceled: boolean };
}

/** per-workspace settings PATCH /settings changes */
interface StoredTenantSettings {
  workflowReviews: { enabled: boolean };
}

export type MockHandler = Handler;

/** a "Listen for test event" registration (POST /workflows/:id/listen-test-webhook), one per workflow */
export interface TestListen {
  nodeName: string;
  expiresAt: number;
  /** S3: the node a chat test run stops at (a step run downstream of a Chat Trigger) */
  destinationNode?: string;
  /** S3: a Chat Trigger's token, sent back by the chat panel in `x-chat-test-token` */
  chatTestToken?: string;
}

/**
 * S3 (P5-61): GET /executions `customDataKey` (the key, exact), `customDataValue` (a part of the value,
 * case-sensitive as SQL LIKE, or the whole value with `customDataExact=true`). No key: no filter.
 */
export function matchesCustomData(
  customData: Record<string, string> | null,
  query: Record<string, string>,
): boolean {
  const key = query.customDataKey;
  if (!key) return true;
  if (!customData || !Object.hasOwn(customData, key)) return false;
  const value = String(customData[key]);
  const wanted = query.customDataValue;
  if (wanted === undefined || wanted === '') return true;
  return query.customDataExact === 'true' ? value === wanted : value.includes(wanted);
}

interface StoredCredential extends CredentialSummary {
  tenantId: string;
  data: Record<string, unknown>;
}

export interface MockBackendOptions {
  stepDelayMs?: number;
  /** demo: simulate a call to the test URL this many ms after "Listen for test event" */
  autoWebhookMs?: number;
  brand?: Settings['brand'];
  signupEnabled?: boolean;
}

type Handler = (ctx: {
  params: string[];
  query: Record<string, string>;
  body: Record<string, unknown>;
}) => unknown | Promise<unknown>;

export { HttpError };

/** P3-13: the n8n messages of GET /from-url */
const NOT_JSON = 'The URL does not point to valid JSON file!';
const NOT_WORKFLOW = 'The data in the file does not seem to be a workflow JSON file!';

export class MockBackend {
  users: StoredUser[] = [];
  tenants: StoredTenant[] = [];
  memberships: Array<{ tenantId: string; userId: string; role: Role }> = [];
  invitations: Array<{ token: string; tenantId: string; email: string; role: Role }> = [];
  workflows: StoredWorkflow[] = [];
  versions: StoredVersion[] = [];
  executions: StoredExecution[] = [];
  credentials: StoredCredential[] = [];
  tags: Array<Tag & { tenantId: string }> = [];
  variables: Array<Variable & { tenantId: string }> = [];
  apiKeys: Array<ApiKey & { tenantId: string }> = [];
  session: { userId: string; tenantId: string } | null = null;
  /** last request bodies, for assertions in tests */
  requests: ApiRequest[] = [];
  /** state of the Phase 3 route modules (mock-folders, mock-annotations, mock-publish, mock-reviews) */
  ext: Record<string, unknown> = {};
  /** P3-13: what POST /workflows/from-url answers per URL (the demo never fetches) */
  private urlFixtures = new Map<string, unknown>();
  private tenantSettings = new Map<string, StoredTenantSettings>();
  /** the execution simulator; tests may spy on it (P3-06 runData / dirtyNodeNames reach it) */
  simulate: typeof simulateExecution = simulateExecution;
  private listeners = new Set<(event: PushEvent) => void>();
  private routes: Array<[string, RegExp, Handler]> = [];
  private listening = new Map<string, TestListen>();

  constructor(readonly options: MockBackendOptions = {}) {
    this.registerRoutes();
    registerFolderRoutes(this);
    registerAnnotationRoutes(this);
    registerPublishRoutes(this);
    registerReviewRoutes(this);
    registerDataTableRoutes(this);
    registerSecretRoutes(this);
    registerTriggerListenRoutes(this);
    registerFormAuthRoutes(this);
    registerChatRoutes(this);
    registerEvaluationRoutes(this);
  }

  // -------------------------------------------------------------------------------------------
  // push
  // -------------------------------------------------------------------------------------------

  subscribe(listener: (event: PushEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PushEvent): void {
    for (const listener of this.listeners) listener(copy(event));
  }

  // -------------------------------------------------------------------------------------------
  // seeding helpers (tests and demo)
  // -------------------------------------------------------------------------------------------

  createAccount(input: { email: string; password: string; name: string; workspaceName: string }) {
    const user: StoredUser = {
      id: newId(),
      email: input.email.toLowerCase(),
      name: input.name,
      password: input.password,
    };
    const tenant: StoredTenant = {
      id: newId(),
      name: input.workspaceName,
      slug: input.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    };
    this.users.push(user);
    this.tenants.push(tenant);
    this.memberships.push({ tenantId: tenant.id, userId: user.id, role: 'owner' });
    return { user, tenant };
  }

  signIn(email: string) {
    const user = this.users.find((u) => u.email === email.toLowerCase());
    const membership = user && this.memberships.find((m) => m.userId === user.id);
    if (!user || !membership) throw new Error(`No account for ${email}`);
    this.session = { userId: user.id, tenantId: membership.tenantId };
  }

  seedWorkflow(input: Partial<WorkflowDTO> & { name: string }): WorkflowDTO {
    const tenantId = this.session?.tenantId ?? this.tenants[0]?.id ?? 'tenant';
    const wf: StoredWorkflow = {
      id: input.id ?? newId(),
      name: input.name,
      nodes: input.nodes ?? [],
      connections: input.connections ?? {},
      settings: input.settings ?? {},
      pinData: input.pinData ?? {},
      stickyNotes: input.stickyNotes ?? [],
      active: input.active ?? false,
      versionId: newId(),
      tags: input.tags ?? [],
      createdAt: input.createdAt ?? now(),
      updatedAt: input.updatedAt ?? now(),
      nodeGroups: input.nodeGroups ?? [],
      folderId: input.folderId ?? null,
      isArchived: input.isArchived ?? false,
      publishedVersionId: null,
      tenantId,
    };
    // a seeded active workflow is published at its version (as migration 0006 backfills)
    if (wf.active) wf.publishedVersionId = wf.versionId;
    this.workflows.push(wf);
    this.recordVersion(wf, 'Created');
    return this.toDto(wf);
  }

  /** P3-13: POST /workflows/from-url with this URL answers `json` (anything else: n8n's 400) */
  setUrlFixture(url: string, json: unknown): void {
    this.urlFixtures.set(url, copy(json));
  }

  // -------------------------------------------------------------------------------------------
  // request handling
  // -------------------------------------------------------------------------------------------

  async handle(request: ApiRequest): Promise<ApiResponse> {
    this.requests.push(copy({ ...request, signal: undefined }));
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.query ?? {}))
      if (v !== undefined && v !== null) query[k] = String(v);
    const path = request.path.split('?')[0];
    for (const [method, pattern, handler] of this.routes) {
      if (method !== request.method) continue;
      const match = pattern.exec(path);
      if (!match) continue;
      try {
        const data = await handler({
          params: match.slice(1).map(decodeURIComponent),
          query,
          body: (request.body ?? {}) as Record<string, unknown>,
        });
        if (data && typeof data === 'object' && '__list' in data) {
          const { __list, ...rest } = data as { __list: true };
          void __list;
          return { status: 200, body: rest };
        }
        return { status: 200, body: { data } };
      } catch (error) {
        if (error instanceof HttpError) {
          return {
            status: error.status,
            body: { error: { code: error.code, message: error.message, details: error.details } },
          };
        }
        return { status: 500, body: { error: { code: 'internal', message: (error as Error).message } } };
      }
    }
    return {
      status: 404,
      body: { error: { code: 'not_found', message: `No route for ${request.method} ${path}` } },
    };
  }

  /** register a route; `:name` segments become handler params (in order). First match wins. */
  on(method: string, path: string, handler: Handler) {
    const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    this.routes.push([method, pattern, handler]);
  }

  /** the signed-in user, workspace and role (401 when signed out) */
  auth() {
    if (!this.session) throw new HttpError(401, 'unauthorized', 'Sign in to continue');
    const user = this.users.find((u) => u.id === this.session!.userId)!;
    const tenant = this.tenants.find((t) => t.id === this.session!.tenantId)!;
    const role =
      this.memberships.find((m) => m.userId === user.id && m.tenantId === tenant.id)?.role ?? 'viewer';
    return { user, tenant, role };
  }

  private authResult() {
    const { user, tenant, role } = this.auth();
    return { user: { id: user.id, email: user.email, name: user.name }, tenant: { ...tenant }, role };
  }

  /** 403 unless the signed-in role is at least `role` */
  requireRole(role: 'editor' | 'admin') {
    const auth = this.auth();
    const rank = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const;
    if (rank[auth.role] < rank[role]) throw new HttpError(403, 'forbidden', 'You do not have permission');
    return auth;
  }

  toDto(wf: StoredWorkflow): WorkflowDTO {
    const { tenantId, ...dto } = wf;
    void tenantId;
    return copy(dto);
  }

  /** the workflow in the signed-in workspace (404 otherwise) */
  workflow(id: string): StoredWorkflow {
    const { tenant } = this.auth();
    const wf = this.workflows.find((w) => w.id === id && w.tenantId === tenant.id);
    if (!wf) throw new HttpError(404, 'not_found', 'Workflow not found');
    return wf;
  }

  recordVersion(wf: StoredWorkflow, message: string | null, options: { autosaved?: boolean } = {}) {
    const author = this.session ? this.users.find((u) => u.id === this.session!.userId)?.name : undefined;
    this.versions.unshift({
      versionId: wf.versionId,
      workflowId: wf.id,
      authorName: author ?? 'Demo user',
      message,
      createdAt: now(),
      versionName: null,
      description: null,
      autosaved: options.autosaved ?? false,
      snapshot: copy({
        name: wf.name,
        nodes: wf.nodes,
        connections: wf.connections,
        settings: wf.settings,
        nodeGroups: wf.nodeGroups ?? [],
      }),
    });
  }

  versionSummary(v: StoredVersion): VersionSummary {
    return {
      versionId: v.versionId,
      authorName: v.authorName,
      message: v.message,
      createdAt: v.createdAt,
      versionName: v.versionName ?? null,
      description: v.description ?? null,
      autosaved: v.autosaved ?? false,
    };
  }

  /** the execution in the signed-in workspace (404 otherwise) */
  execution(id: string): StoredExecution {
    const { tenant } = this.auth();
    const e = this.executions.find((x) => x.id === id && x.tenantId === tenant.id);
    if (!e) throw new HttpError(404, 'not_found', 'Execution not found');
    return e;
  }

  executionSummary(e: StoredExecution): ExecutionSummary {
    return {
      id: e.id,
      workflowId: e.workflowId,
      workflowName: e.workflowName,
      mode: e.mode,
      status: e.status,
      startedAt: e.startedAt,
      stoppedAt: e.stoppedAt,
      durationMs: e.durationMs,
      errorMessage: e.errorMessage,
      customData: e.customData,
      workflowVersionId: e.workflowVersionId ?? null,
      annotation: e.annotation ? copy(e.annotation) : null,
    };
  }

  workflowSummary(w: StoredWorkflow): WorkflowSummary {
    return {
      id: w.id,
      name: w.name,
      active: w.active,
      tags: copy(w.tags),
      updatedAt: w.updatedAt,
      createdAt: w.createdAt,
      nodeTypes: w.nodes.map((n) => n.type),
      isArchived: w.isArchived,
      folderId: w.folderId,
      publishedVersionId: w.publishedVersionId,
    };
  }

  private settingsOf(tenantId: string): StoredTenantSettings {
    let settings = this.tenantSettings.get(tenantId);
    if (!settings) {
      settings = { workflowReviews: { enabled: false } };
      this.tenantSettings.set(tenantId, settings);
    }
    return settings;
  }

  validateForActivation(wf: StoredWorkflow) {
    const details: Array<{ node: string; message: string }> = [];
    const byName = new Map(demoNodeTypes.map((d) => [d.name, d]));
    const triggers = wf.nodes.filter(
      (n) => !n.disabled && byName.get(n.type)?.group.includes('trigger') && n.type !== 'core.manualTrigger',
    );
    if (!triggers.length)
      details.push({
        node: '',
        message: 'Add a trigger other than the manual trigger, so the workflow can start on its own.',
      });
    for (const node of wf.nodes) {
      const description = byName.get(node.type);
      if (!description) {
        details.push({ node: node.name, message: `Unknown node type "${node.type}"` });
        continue;
      }
      const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
        nodeVersion: node.typeVersion,
      });
      for (const cred of description.credentials ?? []) {
        if (
          cred.required &&
          isParameterDisplayed(cred.displayOptions, params) &&
          !node.credentials?.[cred.name]?.id
        ) {
          details.push({ node: node.name, message: `Select a credential for "${cred.name}"` });
        }
      }
    }
    if (details.length) throw new HttpError(400, 'validation_failed', 'The workflow has problems', details);
  }

  /** start a simulated run; route modules use it (S3: mock-evaluations runs a case with mode `evaluation`) */
  startExecution(
    wf: StoredWorkflow,
    data: {
      nodes: WorkflowNode[];
      connections: Connections;
      name: string;
      settings?: WorkflowSettings;
      pinData?: Record<string, Item[]>;
    },
    options: {
      mode: 'manual' | 'webhook' | 'retry' | 'evaluation';
      destinationNode?: string;
      startNode?: string;
      triggerItems?: Item[];
      retryOf?: string;
      /** P3-06 partial run */
      runData?: RunData;
      dirtyNodeNames?: string[];
      /** P3-10: the saved version the run used (null for unsaved editor data) */
      workflowVersionId?: string | null;
      /** P5-76: test the tool `destinationNode` names */
      agentRequest?: AgentRequest;
    },
  ): string {
    const executionId = newId();
    const cancel = { canceled: false };
    const execution: StoredExecution = {
      id: executionId,
      tenantId: wf.tenantId,
      workflowId: wf.id,
      workflowName: data.name,
      mode: options.mode,
      status: 'running',
      startedAt: now(),
      stoppedAt: null,
      durationMs: null,
      errorMessage: null,
      customData: null,
      workflowVersionId: options.workflowVersionId ?? null,
      annotation: null,
      workflowData: copy({ id: wf.id, ...data }),
      state: {
        // a tool test runs up to the tool's root, as on the engine
        startData: {
          destinationNode:
            options.agentRequest && data.nodes.some((n) => n.name === options.destinationNode)
              ? toolRootName(data.connections, options.destinationNode as string)
              : options.destinationNode,
        },
        resultData: { runData: {} },
        executionData: {
          nodeExecutionStack: [],
          waitingExecution: {},
          waitingExecutionSource: {},
          contextData: {},
        },
      },
      cancel,
    };
    this.executions.unshift(execution);
    const variables = Object.fromEntries(
      this.variables.filter((v) => v.tenantId === wf.tenantId).map((v) => [v.key, v.value]),
    );
    // start asynchronously so the HTTP response (with the id) can win or lose the race, like on a real server
    setTimeout(() => {
      const input: SimulationInput = {
        executionId,
        workflow: {
          id: wf.id,
          name: data.name,
          active: wf.active,
          nodes: data.nodes,
          connections: data.connections,
          pinData: options.mode === 'manual' || options.mode === 'evaluation' ? data.pinData : undefined,
        },
        mode: options.mode,
        destinationNode: options.destinationNode,
        startNode: options.startNode,
        triggerItems: options.triggerItems,
        runData: options.runData,
        dirtyNodeNames: options.dirtyNodeNames,
        variables,
        emit: (event) => {
          if (event.type === 'nodeExecuteAfter') {
            const runs = (execution.state.resultData.runData[event.data.nodeName] ??= []);
            runs[event.data.runIndex] = event.data.taskData;
          }
          this.emit(event);
        },
        stepDelayMs: this.options.stepDelayMs ?? 0,
        signal: cancel,
      };
      void (
        options.agentRequest ? this.simulateToolTest(input, options.agentRequest) : this.simulate(input)
      ).then((result: SimulationResult) => this.finishExecution(execution, result));
    }, 0);
    return executionId;
  }

  /**
   * P5-76 Test a tool, as the engine runs it: the root's parents run as usual, the root only hands
   * their items on and leaves no run, and the tool node gets the one run. The query is data: it goes
   * into the run as it came and is never evaluated.
   */
  private async simulateToolTest(input: SimulationInput, request: AgentRequest): Promise<SimulationResult> {
    const { workflow, executionId, emit } = input;
    const workflowId = workflow.id ?? '';
    const refuse = (message: string): SimulationResult => {
      const error = { name: 'WorkflowOperationError', message };
      emit({ type: 'executionStarted', data: { executionId, workflowId, mode: input.mode } });
      emit({ type: 'executionFinished', data: { executionId, workflowId, status: 'error', error } });
      return { status: 'error', runData: {}, error };
    };
    const toolName = input.destinationNode;
    if (!toolName) return refuse('A tool test needs a destination node');
    if (!workflow.nodes.some((n) => n.name === toolName))
      return refuse(`Destination node "${toolName}" does not exist`);

    const root = toolRootName(workflow.connections, toolName);
    const ancestors = getAncestors(workflow.connections, root);
    const heads = workflow.nodes.filter(
      (n) => ancestors.includes(n.name) && getMainParents(workflow.connections, n.name).length === 0,
    );
    const held: PushEvent[] = [];
    const upstream = await this.simulate({
      ...input,
      workflow: {
        ...workflow,
        // a pass-through in the root's place: no parameter of it is evaluated, no sub-node logs a run
        nodes: workflow.nodes.map((n) =>
          n.name === root ? { ...n, type: 'core.noOp', parameters: {}, disabled: false } : n,
        ),
      },
      destinationNode: root,
      startNode:
        input.startNode ?? (heads.find((n) => /trigger|webhook/i.test(n.type)) ?? heads[0])?.name ?? root,
      emit: (event) => {
        if (event.type === 'executionFinished') held.push(event);
        else if (
          (event.type !== 'nodeExecuteBefore' && event.type !== 'nodeExecuteAfter') ||
          event.data.nodeName !== root
        )
          emit(event);
      },
    });
    const runData: RunData = Object.fromEntries(
      Object.entries(upstream.runData).filter(([name]) => name !== root),
    );
    if (upstream.status !== 'success') {
      for (const event of held) emit(event);
      return { ...upstream, runData };
    }

    emit({ type: 'nodeExecuteBefore', data: { executionId, nodeName: toolName } });
    const delayMs = input.stepDelayMs;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const task: TaskData = {
      startTime: Date.now(),
      executionTime: delayMs ? 120 : 0,
      executionStatus: 'success',
      inputOverride: { ai_tool: [[{ json: copy(request.query ?? {}) }]] },
      data: { ai_tool: [[{ json: { response: 'demo response', toolName: request.toolName } }]] },
      source: root === toolName ? [] : [{ previousNode: root }],
    };
    const runs = (runData[toolName] ??= []);
    runs.push(task);
    emit({
      type: 'nodeExecuteAfter',
      data: { executionId, nodeName: toolName, runIndex: runs.length - 1, taskData: task },
    });
    for (const event of held) emit(event);
    return { status: 'success', runData, lastNodeExecuted: toolName };
  }

  private finishExecution(execution: StoredExecution, result: SimulationResult) {
    execution.status = result.status;
    execution.stoppedAt = now();
    execution.durationMs = new Date(execution.stoppedAt).getTime() - new Date(execution.startedAt).getTime();
    execution.errorMessage = result.error?.message ?? null;
    const state: ExecutionState = execution.state;
    state.resultData = {
      runData: result.runData,
      lastNodeExecuted: result.lastNodeExecuted,
      error: result.error,
    };
    if (result.error?.node) {
      state.executionData.failedExecuteData = { node: result.error.node, data: { main: [[]] }, source: null };
    }
  }

  /**
   * Simulate the call to a test URL that "Listen for test event" registered. S3: `triggerItems` is what the
   * request brought (the chat item of a Chat Trigger); the run stops at the listen's `destinationNode`.
   */
  receiveTestWebhook(workflowId: string, triggerItems?: Item[]): string | null {
    const listen = this.listening.get(workflowId);
    if (!listen || listen.expiresAt < Date.now()) return null;
    this.listening.delete(workflowId);
    const wf = this.workflows.find((w) => w.id === workflowId);
    if (!wf) return null;
    const executionId = this.startExecution(wf, wf, {
      mode: 'webhook',
      startNode: listen.nodeName,
      destinationNode: listen.destinationNode,
      triggerItems,
      workflowVersionId: wf.versionId,
    });
    this.emit({ type: 'testWebhookReceived', data: { workflowId, executionId } });
    return executionId;
  }

  /** S3: the live chat test listen that issued `token` (null when unknown or expired) */
  testListenByChatToken(token: string): { workflowId: string; listen: TestListen } | null {
    if (!token) return null;
    for (const [workflowId, listen] of this.listening) {
      if (listen.chatTestToken === token && listen.expiresAt >= Date.now()) return { workflowId, listen };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // routes
  // -------------------------------------------------------------------------------------------

  private registerRoutes() {
    // --- auth -----------------------------------------------------------------------------------
    this.on('POST', '/auth/signup', ({ body }) => {
      if (this.options.signupEnabled === false)
        throw new HttpError(403, 'signup_disabled', 'Sign-up is disabled on this server');
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      const password = String(body.password ?? '');
      if (!/^\S+@\S+\.\S+$/.test(email))
        throw new HttpError(400, 'invalid_email', 'Enter a valid email address');
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw new HttpError(400, 'weak_password', 'Use at least 8 characters with a letter and a digit');
      }
      if (this.users.some((u) => u.email === email))
        throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      const { user, tenant } = this.createAccount({
        email,
        password,
        name: String(body.name ?? ''),
        workspaceName: String(body.workspaceName ?? 'My workspace'),
      });
      this.session = { userId: user.id, tenantId: tenant.id };
      return this.authResult();
    });
    this.on('POST', '/auth/login', ({ body }) => {
      const user = this.users.find((u) => u.email === String(body.email ?? '').toLowerCase());
      if (!user || user.password !== body.password)
        throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');
      const membership = this.memberships.find((m) => m.userId === user.id)!;
      this.session = { userId: user.id, tenantId: membership.tenantId };
      return this.authResult();
    });
    this.on('POST', '/auth/logout', () => {
      this.session = null;
      return { ok: true };
    });
    this.on('GET', '/auth/me', () => {
      const result = this.authResult();
      return {
        ...result,
        tenants: this.memberships
          .filter((m) => m.userId === result.user.id)
          .map((m) => ({ ...this.tenants.find((t) => t.id === m.tenantId)!, role: m.role })),
      };
    });
    this.on('POST', '/auth/switch-tenant', ({ body }) => {
      const { user } = this.auth();
      const membership = this.memberships.find((m) => m.userId === user.id && m.tenantId === body.tenantId);
      if (!membership) throw new HttpError(403, 'forbidden', 'You are not a member of that workspace');
      this.session = { userId: user.id, tenantId: membership.tenantId };
      return this.authResult();
    });
    this.on('POST', '/invitations/:token/accept', ({ params, body }) => {
      const invitation = this.invitations.find((i) => i.token === params[0]);
      if (!invitation) throw new HttpError(404, 'not_found', 'Invitation not found or expired');
      let user = this.users.find((u) => u.email === invitation.email);
      if (!user) {
        user = {
          id: newId(),
          email: invitation.email,
          name: String(body.name ?? ''),
          password: String(body.password ?? ''),
        };
        this.users.push(user);
      }
      this.memberships.push({ tenantId: invitation.tenantId, userId: user.id, role: invitation.role });
      this.invitations = this.invitations.filter((i) => i !== invitation);
      this.session = { userId: user.id, tenantId: invitation.tenantId };
      return this.authResult();
    });

    // --- settings & types -------------------------------------------------------------------------
    this.on(
      'GET',
      '/settings',
      (): Settings => ({
        brand: this.options.brand ?? { name: 'Workflow', logoUrl: null, primaryColor: '#3346d3' },
        baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
        webhookBaseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
        timezone: 'Europe/Berlin',
        limits: { executionTimeoutMax: 3600 },
        features: { demo: true },
        autosaveEnabled: true,
        evaluationConcurrencyLimit: DEMO_EVALUATION_CONCURRENCY_LIMIT,
        workflowReviews: copy(
          this.session ? this.settingsOf(this.session.tenantId).workflowReviews : { enabled: false },
        ),
      }),
    );
    this.on('PATCH', '/settings', ({ body }) => {
      const { tenant } = this.requireRole('admin');
      const settings = this.settingsOf(tenant.id);
      const reviews = body.workflowReviews as { enabled?: unknown } | undefined;
      if (reviews && typeof reviews.enabled === 'boolean')
        settings.workflowReviews = { enabled: reviews.enabled };
      // the server's PATCH answer: brand, timezone and the two P3 fields
      return {
        brand: this.options.brand ?? { name: 'Workflow', logoUrl: null, primaryColor: '#3346d3' },
        timezone: 'Europe/Berlin',
        autosaveEnabled: true,
        workflowReviews: copy(settings.workflowReviews),
      };
    });
    this.on('GET', '/node-types', () => {
      this.auth();
      return copy(demoNodeTypes);
    });
    this.on('GET', '/credential-types', () => {
      this.auth();
      return copy(demoCredentialTypes);
    });
    this.on('POST', '/node-types/options', ({ body }) => {
      this.auth();
      const node = body.node as WorkflowNode;
      if (body.kind === 'loadOptions') {
        const fn = demoLoadOptions[String(body.method)];
        if (!fn) throw new HttpError(400, 'unknown_method', `Unknown method ${String(body.method)}`);
        return fn(node?.parameters ?? {});
      }
      if (body.kind === 'resourceMapping') {
        // P5-80, the role of the server's route
        this.requireRole('editor');
        const fn = demoResourceMapping[String(body.method)];
        if (!fn) throw new HttpError(400, 'unknown_method', `Unknown method ${String(body.method)}`);
        return fn(node?.parameters ?? {});
      }
      // P4-05: the Data Table node's locator lists the demo's tables
      if (body.method === 'tableSearch') return searchDataTables(String(body.filter ?? ''));
      const filter = String(body.filter ?? '').toLowerCase();
      const matches = demoContacts.filter((c) => !filter || c.name.toLowerCase().includes(filter));
      const offset = Number(body.paginationToken ?? 0) || 0;
      const results = matches.slice(offset, offset + 10);
      return { results, paginationToken: offset + 10 < matches.length ? String(offset + 10) : undefined };
    });

    // --- workflows ------------------------------------------------------------------------------
    this.on('GET', '/workflows', ({ query }) => {
      const { tenant } = this.auth();
      const search = (query.search ?? '').toLowerCase();
      // P3-01 command bar search: name, or a node of one of `nodeTypes`, or (matchTags) a tag named like it
      const nodeTypes = new Set((query.nodeTypes ?? '').split(',').filter(Boolean).slice(0, 20));
      const matchTags = query.matchTags === 'true';
      const matches = (w: StoredWorkflow) =>
        w.name.toLowerCase().includes(search) ||
        w.nodes.some((n) => nodeTypes.has(n.type)) ||
        (matchTags && w.tags.some((t) => t.name.toLowerCase().includes(search)));
      const scoped = filterWorkflowList(
        this,
        this.workflows.filter((w) => w.tenantId === tenant.id),
        query,
      );
      const list = scoped
        .filter((w) => !search || matches(w))
        .filter((w) => !query.tagId || w.tags.some((t) => t.id === query.tagId))
        .filter((w) => query.active === undefined || String(w.active) === query.active)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((w) => this.workflowSummary(w));
      return { __list: true, ...page(list, query) };
    });
    // P3-13: the server fetches the URL; the demo answers fixtures set with setUrlFixture
    this.on('POST', '/workflows/from-url', ({ body }) => {
      this.requireRole('editor');
      const url = typeof body.url === 'string' ? body.url : '';
      if (!/^https?:\/\/.+/i.test(url) || url.length > 2048)
        throw new HttpError(400, 'invalid_url', 'Enter a URL that starts with http:// or https://');
      if (!this.urlFixtures.has(url)) throw new HttpError(400, 'invalid_json', NOT_JSON);
      const data = this.urlFixtures.get(url) as { nodes?: unknown; connections?: unknown } | null;
      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray(data.nodes) ||
        !data.connections ||
        typeof data.connections !== 'object'
      ) {
        throw new HttpError(400, 'invalid_workflow', NOT_WORKFLOW);
      }
      return copy(data);
    });
    this.on('POST', '/workflows', ({ body }) => {
      const { tenant } = this.auth();
      const tagIds = (body.tagIds as string[] | undefined) ?? [];
      const wf: StoredWorkflow = {
        id: newId(),
        tenantId: tenant.id,
        name: String(body.name ?? 'My workflow'),
        nodes: (body.nodes as WorkflowNode[]) ?? [],
        connections: (body.connections as Connections) ?? {},
        settings: (body.settings as WorkflowSettings) ?? {},
        pinData: (body.pinData as Record<string, Item[]>) ?? {},
        stickyNotes: (body.stickyNotes as StickyNote[]) ?? [],
        active: false,
        versionId: newId(),
        tags: this.tags.filter((t) => tagIds.includes(t.id)).map(({ id, name }) => ({ id, name })),
        createdAt: now(),
        updatedAt: now(),
        nodeGroups: (body.nodeGroups as WorkflowNodeGroup[]) ?? [],
        folderId: typeof body.folderId === 'string' ? body.folderId : null,
        isArchived: false,
        publishedVersionId: null,
      };
      this.workflows.push(wf);
      this.recordVersion(wf, null);
      return this.toDto(wf);
    });
    this.on('GET', '/workflows/:id', ({ params }) => this.toDto(this.workflow(params[0])));
    this.on('PATCH', '/workflows/:id', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      if (body.versionId !== wf.versionId)
        throw new HttpError(409, 'version_conflict', 'The workflow was changed by someone else');
      for (const key of [
        'name',
        'nodes',
        'connections',
        'settings',
        'pinData',
        'stickyNotes',
        'nodeGroups',
      ] as const) {
        if (body[key] !== undefined) (wf as unknown as Record<string, unknown>)[key] = copy(body[key]);
      }
      const tagIds =
        (body.tagIds as string[] | undefined) ?? (body.tags as Tag[] | undefined)?.map((t) => t.id);
      if (tagIds)
        wf.tags = this.tags.filter((t) => tagIds.includes(t.id)).map(({ id, name }) => ({ id, name }));
      wf.versionId = newId();
      wf.updatedAt = now();
      this.recordVersion(wf, null, { autosaved: body.autosaved === true });
      return this.toDto(wf);
    });
    this.on('DELETE', '/workflows/:id', ({ params }) => {
      const wf = this.workflow(params[0]);
      this.workflows = this.workflows.filter((w) => w !== wf);
      return { ok: true };
    });
    // POST /workflows/:id/activate and /deactivate: mock-publish.ts
    this.on('POST', '/workflows/:id/run', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      const data = (body.workflowData as typeof wf | undefined) ?? wf;
      const executionId = this.startExecution(
        wf,
        {
          name: data.name ?? wf.name,
          nodes: data.nodes ?? wf.nodes,
          connections: data.connections ?? wf.connections,
          settings: data.settings ?? wf.settings,
          pinData: (body.pinData as Record<string, Item[]>) ?? data.pinData ?? wf.pinData,
        },
        {
          mode: 'manual',
          destinationNode: body.destinationNode as string | undefined,
          startNode: body.startNode as string | undefined,
          triggerItems: body.triggerItems as Item[] | undefined,
          runData: body.runData as RunData | undefined,
          dirtyNodeNames: body.dirtyNodeNames as string[] | undefined,
          workflowVersionId: body.workflowData ? null : wf.versionId,
          agentRequest: body.agentRequest as AgentRequest | undefined,
        },
      );
      return { executionId };
    });
    this.on('DELETE', '/workflows/:id/listen-test-webhook', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      if (this.listening.get(wf.id)?.nodeName === String(body.nodeName ?? '')) this.listening.delete(wf.id);
      return { ok: true };
    });
    this.on('POST', '/workflows/:id/listen-test-webhook', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      const nodeName = String(body.nodeName ?? '');
      const node = wf.nodes.find((n) => n.name === nodeName);
      if (!node) throw new HttpError(400, 'unknown_node', `Node "${nodeName}" is not in the saved workflow`);
      const expiresAt = Date.now() + 120_000;
      const isChat = node.type === CHAT_TRIGGER_TYPE;
      // S3: a chat test run gets a token per registration (the server signs one, kind chat-test, 120 s)
      const chatTestToken = isChat ? `demo-chat-test-${newId()}` : undefined;
      const destinationNode = typeof body.destinationNode === 'string' ? body.destinationNode : undefined;
      this.listening.set(wf.id, { nodeName, expiresAt, destinationNode, chatTestToken });
      // a chat message comes from the chat panel, never from the demo timer
      if (this.options.autoWebhookMs && !isChat)
        setTimeout(() => this.receiveTestWebhook(wf.id), this.options.autoWebhookMs);
      const { tenant } = this.auth();
      const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      const isForm = node.type === 'core.formTrigger';
      const testUrl = `${origin}/${isForm ? 'form-test' : 'webhook-test'}/${tenant.slug}/${hookPath(node)}`;
      return {
        testUrl,
        expiresAt: new Date(expiresAt).toISOString(),
        formTestUrls: isForm ? [testUrl] : [],
        ...(chatTestToken ? { chatTestToken } : {}),
      };
    });
    this.on('GET', '/workflows/:id/webhook-urls', ({ params }) => {
      const wf = this.workflow(params[0]);
      const { tenant } = this.auth();
      const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      return wf.nodes
        .filter(
          (n) => n.type === 'core.webhook' || n.type === 'core.formTrigger' || n.type === CHAT_TRIGGER_TYPE,
        )
        .map((n) => {
          const path = hookPath(n);
          const isForm = n.type === 'core.formTrigger';
          return {
            nodeName: n.name,
            method: isForm ? 'GET' : String(n.parameters.httpMethod ?? 'POST'),
            testUrl: `${origin}/${isForm ? 'form-test' : 'webhook-test'}/${tenant.slug}/${path}`,
            productionUrl: `${origin}/${isForm ? 'form' : 'webhook'}/${tenant.slug}/${path}`,
          };
        });
    });
    this.on('GET', '/workflows/:id/versions', ({ params, query }) => {
      const wf = this.workflow(params[0]);
      const list: VersionSummary[] = this.versions
        .filter((v) => v.workflowId === wf.id)
        .map((v) => this.versionSummary(v));
      return { __list: true, ...page(list, query) };
    });
    this.on('GET', '/workflows/:id/versions/:versionId', ({ params }) => {
      const wf = this.workflow(params[0]);
      const version = this.versions.find((v) => v.workflowId === wf.id && v.versionId === params[1]);
      if (!version) throw new HttpError(404, 'not_found', 'Version not found');
      return {
        versionId: version.versionId,
        createdAt: version.createdAt,
        versionName: version.versionName ?? null,
        description: version.description ?? null,
        autosaved: version.autosaved ?? false,
        ...copy(version.snapshot),
      };
    });
    // structural diff: `against` = a version id, 'current' (the saved workflow) or 'published'
    this.on('GET', '/workflows/:id/versions/:versionId/diff', ({ params, query }) => {
      const wf = this.workflow(params[0]);
      const find = (id: string | null) => {
        const v = id ? this.versions.find((x) => x.workflowId === wf.id && x.versionId === id) : undefined;
        if (!v) throw new HttpError(404, 'not_found', 'Version not found');
        return v.snapshot;
      };
      const against = query.against || 'current';
      const from = find(params[1]);
      const to = against === 'current' ? wf : find(against === 'published' ? wf.publishedVersionId : against);
      return {
        from: params[1],
        to: against,
        ...diffWorkflows(
          { name: from.name, nodes: from.nodes, connections: from.connections, settings: from.settings },
          { name: to.name, nodes: to.nodes, connections: to.connections, settings: to.settings ?? {} },
        ),
      };
    });
    this.on('POST', '/workflows/:id/versions/:versionId/restore', ({ params }) => {
      const wf = this.workflow(params[0]);
      const version = this.versions.find((v) => v.workflowId === wf.id && v.versionId === params[1]);
      if (!version) throw new HttpError(404, 'not_found', 'Version not found');
      Object.assign(wf, copy(version.snapshot));
      wf.versionId = newId();
      wf.updatedAt = now();
      this.recordVersion(wf, 'Restored an earlier version');
      return this.toDto(wf);
    });

    // --- executions -----------------------------------------------------------------------------
    const summary = (e: StoredExecution) => this.executionSummary(e);
    const execution = (id: string) => this.execution(id);
    this.on('GET', '/executions', ({ query }) => {
      const { tenant } = this.auth();
      const list = filterExecutionList(
        this,
        this.executions.filter((e) => e.tenantId === tenant.id),
        query,
      )
        .filter((e) => !query.workflowId || e.workflowId === query.workflowId)
        .filter((e) => !query.status || e.status === query.status)
        .filter((e) => !query.workflowVersionId || e.workflowVersionId === query.workflowVersionId)
        .filter((e) => matchesCustomData(e.customData, query))
        .map(summary);
      return { __list: true, ...page(list, query) };
    });
    this.on('GET', '/executions/:id', ({ params }) => {
      const e = execution(params[0]);
      return { ...summary(e), workflowData: copy(e.workflowData), state: copy(e.state) };
    });
    this.on('POST', '/executions/:id/retry', ({ params, body }) => {
      const e = execution(params[0]);
      if (!['error', 'crashed', 'canceled'].includes(e.status)) {
        throw new HttpError(409, 'conflict', 'Only failed or stopped executions can be retried');
      }
      const wf = this.workflow(e.workflowId);
      const data = body.useCurrentWorkflow ? wf : { ...wf, ...e.workflowData, name: e.workflowData.name };
      return {
        executionId: this.startExecution(wf, data, {
          mode: 'retry',
          retryOf: e.id,
          workflowVersionId: body.useCurrentWorkflow ? wf.versionId : e.workflowVersionId,
        }),
      };
    });
    this.on('POST', '/executions/:id/stop', ({ params }) => {
      const e = execution(params[0]);
      if (e.cancel) e.cancel.canceled = true;
      if (e.status === 'running' || e.status === 'waiting') e.status = 'canceled';
      return { status: e.status };
    });
    this.on('DELETE', '/executions/:id', ({ params }) => {
      const e = execution(params[0]);
      this.executions = this.executions.filter((x) => x !== e);
      return { ok: true };
    });

    // --- credentials ------------------------------------------------------------------------------
    const credential = (id: string) => {
      const { tenant, role } = this.auth();
      if (role === 'viewer') throw new HttpError(403, 'forbidden', 'Viewers cannot read credentials');
      const c = this.credentials.find((x) => x.id === id && x.tenantId === tenant.id);
      if (!c) throw new HttpError(404, 'not_found', 'Credential not found');
      return c;
    };
    const secretKeys = (type: string) =>
      new Set(
        demoCredentialTypes
          .find((t) => t.name === type)
          ?.properties.filter((p) => p.typeOptions?.password)
          .map((p) => p.name) ?? [],
      );
    this.on('GET', '/credentials', ({ query }) => {
      const { tenant } = this.auth();
      return this.credentials
        .filter((c) => c.tenantId === tenant.id && (!query.type || c.type === query.type))
        .map(({ id, name, type, createdAt, updatedAt }) => ({ id, name, type, createdAt, updatedAt }));
    });
    this.on('POST', '/credentials', ({ body }) => {
      const { tenant } = this.auth();
      const c: StoredCredential = {
        id: newId(),
        tenantId: tenant.id,
        name: String(body.name ?? 'Credential'),
        type: String(body.type ?? ''),
        data: copy((body.data as Record<string, unknown>) ?? {}),
        createdAt: now(),
        updatedAt: now(),
      };
      this.credentials.push(c);
      return { id: c.id, name: c.name, type: c.type };
    });
    this.on('GET', '/credentials/:id', ({ params }) => {
      const c = credential(params[0]);
      const secrets = secretKeys(c.type);
      // as the server: a saved expression stays visible, it is a reference and not the secret
      const isExpression = (v: unknown) =>
        typeof v === 'string' &&
        v.startsWith('=') &&
        splitTemplate(v.slice(1)).some((segment) => segment.type === 'code');
      const data = Object.fromEntries(
        Object.entries(c.data).map(([k, v]) => [k, secrets.has(k) && v && !isExpression(v) ? REDACTED : v]),
      );
      return { id: c.id, name: c.name, type: c.type, data };
    });
    this.on('PATCH', '/credentials/:id', ({ params, body }) => {
      const c = credential(params[0]);
      if (typeof body.name === 'string') c.name = body.name;
      if (body.data && typeof body.data === 'object') {
        const next = copy(body.data as Record<string, unknown>);
        for (const [k, v] of Object.entries(next)) if (v === REDACTED) next[k] = c.data[k];
        c.data = next;
      }
      c.updatedAt = now();
      return { id: c.id, name: c.name, type: c.type };
    });
    this.on('DELETE', '/credentials/:id', ({ params }) => {
      const c = credential(params[0]);
      this.credentials = this.credentials.filter((x) => x !== c);
      return { ok: true };
    });
    this.on('POST', '/credentials/test', ({ body }) => {
      this.auth();
      const data = (body.data as Record<string, unknown>) ?? {};
      const filled = Object.values(data).some((v) => v !== '' && v !== undefined && v !== null);
      return filled
        ? { status: 'OK', message: 'Connection works' }
        : { status: 'Error', message: 'Fill in the fields first' };
    });
    this.on('GET', '/oauth2/authorize', () => {
      throw new HttpError(
        400,
        'not_available',
        'OAuth2 sign-in needs a running server; it is not available in this demo.',
      );
    });
    this.on('GET', '/oauth1/authorize', () => {
      throw new HttpError(
        400,
        'not_available',
        'OAuth1 sign-in needs a running server; it is not available in this demo.',
      );
    });

    // --- tags, variables -----------------------------------------------------------------------------
    this.on('GET', '/tags', () => {
      const { tenant } = this.auth();
      return this.tags.filter((t) => t.tenantId === tenant.id).map(({ id, name }) => ({ id, name }));
    });
    this.on('POST', '/tags', ({ body }) => {
      const { tenant } = this.auth();
      const name = String(body.name ?? '').trim();
      if (this.tags.some((t) => t.tenantId === tenant.id && t.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, 'tag_exists', 'A tag with this name exists');
      }
      const tag = { id: newId(), name, tenantId: tenant.id };
      this.tags.push(tag);
      return { id: tag.id, name: tag.name };
    });
    this.on('PATCH', '/tags/:id', ({ params, body }) => {
      const tag = this.tags.find((t) => t.id === params[0]);
      if (!tag) throw new HttpError(404, 'not_found', 'Tag not found');
      tag.name = String(body.name ?? tag.name);
      return { id: tag.id, name: tag.name };
    });
    this.on('DELETE', '/tags/:id', ({ params }) => {
      this.tags = this.tags.filter((t) => t.id !== params[0]);
      return { ok: true };
    });
    this.on('GET', '/variables', () => {
      const { tenant } = this.auth();
      return this.variables
        .filter((v) => v.tenantId === tenant.id)
        .map(({ id, key, value }) => ({ id, key, value }));
    });
    this.on('POST', '/variables', ({ body }) => {
      const { tenant } = this.auth();
      const v = {
        id: newId(),
        key: String(body.key ?? ''),
        value: String(body.value ?? ''),
        tenantId: tenant.id,
      };
      this.variables.push(v);
      return { id: v.id, key: v.key, value: v.value };
    });
    this.on('PATCH', '/variables/:id', ({ params, body }) => {
      const v = this.variables.find((x) => x.id === params[0]);
      if (!v) throw new HttpError(404, 'not_found', 'Variable not found');
      v.key = String(body.key ?? v.key);
      v.value = String(body.value ?? v.value);
      return { id: v.id, key: v.key, value: v.value };
    });
    this.on('DELETE', '/variables/:id', ({ params }) => {
      this.variables = this.variables.filter((v) => v.id !== params[0]);
      return { ok: true };
    });

    // --- members, api keys -----------------------------------------------------------------------
    this.on('GET', '/members', (): Member[] => {
      const { tenant } = this.auth();
      return this.memberships
        .filter((m) => m.tenantId === tenant.id)
        .map((m) => {
          const u = this.users.find((x) => x.id === m.userId)!;
          return { userId: u.id, email: u.email, name: u.name, role: m.role };
        });
    });
    this.on('POST', '/members/invite', ({ body }) => {
      const { tenant, role } = this.auth();
      if (role !== 'owner' && role !== 'admin')
        throw new HttpError(403, 'forbidden', 'Only admins can invite');
      const token = newId();
      this.invitations.push({
        token,
        tenantId: tenant.id,
        email: String(body.email ?? '').toLowerCase(),
        role: (body.role as Role) ?? 'editor',
      });
      const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      return { inviteUrl: `${origin}/invitation/${token}` };
    });
    this.on('PATCH', '/members/:userId', ({ params, body }) => {
      const { tenant } = this.auth();
      const m = this.memberships.find((x) => x.tenantId === tenant.id && x.userId === params[0]);
      if (!m) throw new HttpError(404, 'not_found', 'Member not found');
      m.role = body.role as Role;
      const u = this.users.find((x) => x.id === m.userId)!;
      return { userId: u.id, email: u.email, name: u.name, role: m.role };
    });
    this.on('DELETE', '/members/:userId', ({ params }) => {
      const { tenant } = this.auth();
      this.memberships = this.memberships.filter(
        (x) => !(x.tenantId === tenant.id && x.userId === params[0]),
      );
      return { ok: true };
    });
    this.on('GET', '/api-keys', () => {
      const { tenant } = this.auth();
      return this.apiKeys
        .filter((k) => k.tenantId === tenant.id)
        .map(({ id, name, prefix, createdAt, lastUsedAt, scopes }) => ({
          id,
          name,
          prefix,
          createdAt,
          lastUsedAt,
          scopes,
        }));
    });
    this.on('POST', '/api-keys', ({ body }) => {
      const { tenant } = this.auth();
      const prefix = newId().slice(0, 8);
      const key = {
        id: newId(),
        name: String(body.name ?? 'Key'),
        prefix,
        createdAt: now(),
        lastUsedAt: null,
        // empty means every scope
        scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
        tenantId: tenant.id,
      };
      this.apiKeys.push(key);
      return {
        id: key.id,
        name: key.name,
        key: `wfk_${prefix}_${newId().replace(/-/g, '')}`,
        scopes: key.scopes,
      };
    });
    this.on('DELETE', '/api-keys/:id', ({ params }) => {
      this.apiKeys = this.apiKeys.filter((k) => k.id !== params[0]);
      return { ok: true };
    });
  }
}
