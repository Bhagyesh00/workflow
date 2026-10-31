/**
 * In-memory implementation of the REST + SSE contract (docs/ARCHITECTURE.md section 14). It
 * backs the self-contained demo build and the test suite (behind MSW), so both exercise the
 * real client code paths. It is a stand-in: no persistence, a single browser session.
 */
import {
  type Connections,
  type ExecutionState,
  type Item,
  isParameterDisplayed,
  resolveNodeParameters,
  type StickyNote,
  type WorkflowNode,
  type WorkflowSettings,
} from '@workflow/workflow';
import type { ApiRequest, ApiResponse } from '../api/client';
import type {
  ApiKey,
  CredentialSummary,
  ExecutionDetail,
  Member,
  PushEvent,
  Role,
  Settings,
  Tag,
  Variable,
  VersionSummary,
  WorkflowDTO,
} from '../api/types';
import { REDACTED } from '../api/types';
import { newId } from '../lib/ids';
import { demoContacts, demoCredentialTypes, demoLoadOptions, demoNodeTypes } from './fixtures';
import { type SimulationResult, simulateExecution } from './simulator';

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

interface StoredWorkflow extends WorkflowDTO {
  tenantId: string;
}

interface StoredVersion {
  versionId: string;
  workflowId: string;
  authorName: string;
  message: string | null;
  createdAt: string;
  snapshot: { name: string; nodes: WorkflowNode[]; connections: Connections; settings: WorkflowSettings };
}

interface StoredExecution extends ExecutionDetail {
  tenantId: string;
  cancel?: { canceled: boolean };
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function page<T>(list: T[], query: Record<string, string>): { data: T[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 250);
  const offset = query.cursor ? Number(atob(query.cursor)) || 0 : 0;
  const slice = list.slice(offset, offset + limit);
  const next = offset + limit < list.length ? btoa(String(offset + limit)) : null;
  return { data: slice, nextCursor: next };
}

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
  private listeners = new Set<(event: PushEvent) => void>();
  private routes: Array<[string, RegExp, Handler]> = [];
  private listening = new Map<string, { nodeName: string; expiresAt: number }>();

  constructor(readonly options: MockBackendOptions = {}) {
    this.registerRoutes();
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
      tenantId,
    };
    this.workflows.push(wf);
    this.recordVersion(wf, 'Created');
    return this.toDto(wf);
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

  private on(method: string, path: string, handler: Handler) {
    const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    this.routes.push([method, pattern, handler]);
  }

  private auth() {
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

  private toDto(wf: StoredWorkflow): WorkflowDTO {
    const { tenantId, ...dto } = wf;
    void tenantId;
    return copy(dto);
  }

  private workflow(id: string): StoredWorkflow {
    const { tenant } = this.auth();
    const wf = this.workflows.find((w) => w.id === id && w.tenantId === tenant.id);
    if (!wf) throw new HttpError(404, 'not_found', 'Workflow not found');
    return wf;
  }

  private recordVersion(wf: StoredWorkflow, message: string | null) {
    const author = this.session ? this.users.find((u) => u.id === this.session!.userId)?.name : undefined;
    this.versions.unshift({
      versionId: wf.versionId,
      workflowId: wf.id,
      authorName: author ?? 'Demo user',
      message,
      createdAt: now(),
      snapshot: copy({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings }),
    });
  }

  private validateForActivation(wf: StoredWorkflow) {
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

  private startExecution(
    wf: StoredWorkflow,
    data: {
      nodes: WorkflowNode[];
      connections: Connections;
      name: string;
      settings?: WorkflowSettings;
      pinData?: Record<string, Item[]>;
    },
    options: {
      mode: 'manual' | 'webhook' | 'retry';
      destinationNode?: string;
      startNode?: string;
      triggerItems?: Item[];
      retryOf?: string;
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
      workflowData: copy({ id: wf.id, ...data }),
      state: {
        startData: { destinationNode: options.destinationNode },
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
      void simulateExecution({
        executionId,
        workflow: {
          id: wf.id,
          name: data.name,
          active: wf.active,
          nodes: data.nodes,
          connections: data.connections,
          pinData: options.mode === 'manual' ? data.pinData : undefined,
        },
        mode: options.mode,
        destinationNode: options.destinationNode,
        startNode: options.startNode,
        triggerItems: options.triggerItems,
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
      }).then((result: SimulationResult) => this.finishExecution(execution, result));
    }, 0);
    return executionId;
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

  /** Simulate the call to a test URL that "Listen for test event" registered. */
  receiveTestWebhook(workflowId: string): string | null {
    const listen = this.listening.get(workflowId);
    if (!listen || listen.expiresAt < Date.now()) return null;
    this.listening.delete(workflowId);
    const wf = this.workflows.find((w) => w.id === workflowId);
    if (!wf) return null;
    const executionId = this.startExecution(wf, wf, { mode: 'webhook', startNode: listen.nodeName });
    this.emit({ type: 'testWebhookReceived', data: { workflowId, executionId } });
    return executionId;
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
    this.on('GET', '/settings', () => ({
      brand: this.options.brand ?? { name: 'Workflow', logoUrl: null, primaryColor: '#3346d3' },
      baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
      webhookBaseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
      timezone: 'Europe/Berlin',
      limits: { executionTimeoutMax: 3600 },
      features: { demo: true },
    }));
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
      const list = this.workflows
        .filter((w) => w.tenantId === tenant.id)
        .filter((w) => !search || w.name.toLowerCase().includes(search))
        .filter((w) => !query.tagId || w.tags.some((t) => t.id === query.tagId))
        .filter((w) => query.active === undefined || String(w.active) === query.active)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((w) => ({
          id: w.id,
          name: w.name,
          active: w.active,
          tags: copy(w.tags),
          updatedAt: w.updatedAt,
          createdAt: w.createdAt,
          nodeTypes: w.nodes.map((n) => n.type),
        }));
      return { __list: true, ...page(list, query) };
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
      for (const key of ['name', 'nodes', 'connections', 'settings', 'pinData', 'stickyNotes'] as const) {
        if (body[key] !== undefined) (wf as unknown as Record<string, unknown>)[key] = copy(body[key]);
      }
      const tagIds =
        (body.tagIds as string[] | undefined) ?? (body.tags as Tag[] | undefined)?.map((t) => t.id);
      if (tagIds)
        wf.tags = this.tags.filter((t) => tagIds.includes(t.id)).map(({ id, name }) => ({ id, name }));
      wf.versionId = newId();
      wf.updatedAt = now();
      this.recordVersion(wf, null);
      return this.toDto(wf);
    });
    this.on('DELETE', '/workflows/:id', ({ params }) => {
      const wf = this.workflow(params[0]);
      this.workflows = this.workflows.filter((w) => w !== wf);
      return { ok: true };
    });
    this.on('POST', '/workflows/:id/activate', ({ params }) => {
      const wf = this.workflow(params[0]);
      this.validateForActivation(wf);
      wf.active = true;
      return this.toDto(wf);
    });
    this.on('POST', '/workflows/:id/deactivate', ({ params }) => {
      const wf = this.workflow(params[0]);
      wf.active = false;
      return this.toDto(wf);
    });
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
        },
      );
      return { executionId };
    });
    this.on('POST', '/workflows/:id/listen-test-webhook', ({ params, body }) => {
      const wf = this.workflow(params[0]);
      const nodeName = String(body.nodeName ?? '');
      const node = wf.nodes.find((n) => n.name === nodeName);
      if (!node) throw new HttpError(400, 'unknown_node', `Node "${nodeName}" is not in the saved workflow`);
      const expiresAt = Date.now() + 120_000;
      this.listening.set(wf.id, { nodeName, expiresAt });
      if (this.options.autoWebhookMs)
        setTimeout(() => this.receiveTestWebhook(wf.id), this.options.autoWebhookMs);
      const { tenant } = this.auth();
      const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      return {
        testUrl: `${origin}/webhook-test/${tenant.slug}/${String(node.parameters.path || node.webhookId || node.id)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    });
    this.on('GET', '/workflows/:id/webhook-urls', ({ params }) => {
      const wf = this.workflow(params[0]);
      const { tenant } = this.auth();
      const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      return wf.nodes
        .filter((n) => n.type === 'core.webhook')
        .map((n) => {
          const path = String(n.parameters.path || n.webhookId || n.id);
          return {
            nodeName: n.name,
            method: String(n.parameters.httpMethod ?? 'POST'),
            testUrl: `${origin}/webhook-test/${tenant.slug}/${path}`,
            productionUrl: `${origin}/webhook/${tenant.slug}/${path}`,
          };
        });
    });
    this.on('GET', '/workflows/:id/versions', ({ params, query }) => {
      const wf = this.workflow(params[0]);
      const list: VersionSummary[] = this.versions
        .filter((v) => v.workflowId === wf.id)
        .map(({ versionId, authorName, message, createdAt }) => ({
          versionId,
          authorName,
          message,
          createdAt,
        }));
      return { __list: true, ...page(list, query) };
    });
    this.on('GET', '/workflows/:id/versions/:versionId', ({ params }) => {
      const wf = this.workflow(params[0]);
      const version = this.versions.find((v) => v.workflowId === wf.id && v.versionId === params[1]);
      if (!version) throw new HttpError(404, 'not_found', 'Version not found');
      return { versionId: version.versionId, createdAt: version.createdAt, ...copy(version.snapshot) };
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
    const summary = (e: StoredExecution) => ({
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
    });
    const execution = (id: string) => {
      const { tenant } = this.auth();
      const e = this.executions.find((x) => x.id === id && x.tenantId === tenant.id);
      if (!e) throw new HttpError(404, 'not_found', 'Execution not found');
      return e;
    };
    this.on('GET', '/executions', ({ query }) => {
      const { tenant } = this.auth();
      const list = this.executions
        .filter((e) => e.tenantId === tenant.id)
        .filter((e) => !query.workflowId || e.workflowId === query.workflowId)
        .filter((e) => !query.status || e.status === query.status)
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
      return { executionId: this.startExecution(wf, data, { mode: 'retry', retryOf: e.id }) };
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
      const data = Object.fromEntries(
        Object.entries(c.data).map(([k, v]) => [k, secrets.has(k) && v ? REDACTED : v]),
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
        .map(({ id, name, prefix, createdAt, lastUsedAt }) => ({ id, name, prefix, createdAt, lastUsedAt }));
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
        tenantId: tenant.id,
      };
      this.apiKeys.push(key);
      return { id: key.id, name: key.name, key: `wfk_${prefix}_${newId().replace(/-/g, '')}` };
    });
    this.on('DELETE', '/api-keys/:id', ({ params }) => {
      this.apiKeys = this.apiKeys.filter((k) => k.id !== params[0]);
      return { ok: true };
    });
  }
}
