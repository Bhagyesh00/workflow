/**
 * Wires configuration, database, Redis, registries and services for one process
 * (a main serving HTTP, or a queue worker).
 */
import { CredentialCipher, HttpClient, IsolatedVmCodeRunner, PyodideCodeRunner } from '@workflow/core';
import type { NodePackage } from '@workflow/workflow';
import { Redis } from 'ioredis';
import type { Config } from './config';
import { createDatabase, type Database, runMigrations } from './db/client';
import { createLogger, type PinoLogger } from './logger';
import { buildRegistries, loadNodePackages, type Registries } from './node-packages';
import { createRepositories, type Repositories } from './repositories';
import { AccessService } from './services/access';
import { ActiveWorkflowManager } from './services/active-workflows';
import { AiBuilderService } from './services/ai-builder/builder';
import type { AiRuntime } from './services/ai-builder/runtime';
import { AnnotationService } from './services/annotations';
import { ApiKeyService } from './services/api-keys';
import { AssistantApprovals } from './services/assistant/approvals';
import { AssistantDrafts } from './services/assistant/drafts';
import { AssistantService } from './services/assistant/service';
import { AssistantSettingsService } from './services/assistant/settings';
import type { AssistantToolDefinition } from './services/assistant/types';
import { AuthService } from './services/auth';
import { MemoryBus, type MessageBus, PushService, RedisBus } from './services/bus';
import { CredentialGateService } from './services/credential-gate';
import { CredentialService } from './services/credentials';
import { DataTableService } from './services/data-tables';
import { EvaluationService } from './services/evaluations';
import { ExecutionService } from './services/executions';
import { FavoriteService } from './services/favorites';
import { FolderService } from './services/folders';
import { FormAuthService } from './services/form-auth';
import { FormTokenService } from './services/form-tokens';
import { HistoryCompactionService } from './services/history-compaction';
import { Mailer } from './services/mailer';
import { Pruner, WaitTracker } from './services/maintenance';
import { createMcpAuthHelper } from './services/mcp/oauth/tokens';
import { createMcpSessionStore, type McpSessionStore } from './services/mcp-sessions';
import { McpTriggerService } from './services/mcp-trigger';
import { MemberService } from './services/members';
import { Metrics } from './services/metrics';
import { MfaService } from './services/mfa';
import { OAuthJweService } from './services/oauth-jwe';
import { OAuth1Service } from './services/oauth1';
import { OAuth2Service } from './services/oauth2';
import { PasswordService } from './services/password';
import { PrivateCredentialService } from './services/private-credentials';
import { ProjectService } from './services/projects';
import { PublishHistoryService } from './services/publish-history';
import { ExecutionQueue, type Leadership, RedisLeader, SingleLeader } from './services/queue';
import { RoleService } from './services/roles';
import { ScimService } from './services/scim';
import { SecretsManager } from './services/secrets/manager';
import type { SecretProviderType } from './services/secrets/types';
import { SecuritySettingsService } from './services/security-settings';
import { SharingService } from './services/sharing';
import { LdapService } from './services/sso/ldap';
import { SsoLoginService } from './services/sso/login';
import { OidcService } from './services/sso/oidc';
import { ProvisioningService } from './services/sso/provisioning';
import { SamlService } from './services/sso/saml';
import { SsoSettingsService } from './services/sso/settings';
import {
  MemoryTestWebhookStore,
  RedisTestWebhookStore,
  type TestWebhookStore,
} from './services/test-webhooks';
import { TransferService } from './services/transfer';
import { VariableService } from './services/variables';
import { WebhookService } from './services/webhooks';
import { WorkflowArchiveService } from './services/workflow-archive';
import { WorkflowImportUrlService } from './services/workflow-import-url';
import { WorkflowReviewService } from './services/workflow-reviews';
import { WorkflowService } from './services/workflows';

/** the Python Code node's decided cap; CODE_MEMORY_MB can raise it, and alone sets the JavaScript cap */
const MIN_PYTHON_MEMORY_MB = 256;

export interface ServerContext {
  config: Config;
  logger: PinoLogger;
  database: Database;
  repos: Repositories;
  registries: Registries;
  cipher: CredentialCipher;
  http: HttpClient;
  bus: MessageBus;
  push: PushService;
  redis?: Redis;
  queue?: ExecutionQueue;
  leadership: Leadership;
  metrics: Metrics;
  credentials: CredentialService;
  auth: AuthService;
  oauth1: OAuth1Service;
  oauth2: OAuth2Service;
  executions: ExecutionService;
  activeWorkflows: ActiveWorkflowManager;
  testWebhooks: TestWebhookStore;
  webhooks: WebhookService;
  workflows: WorkflowService;
  waitTracker: WaitTracker;
  pruner: Pruner;
  /** P3-07 (L8) */
  folders: FolderService;
  favorites: FavoriteService;
  workflowArchive: WorkflowArchiveService;
  /** P3-09 (L9) */
  annotations: AnnotationService;
  /** P3-13 (L11) */
  workflowImportUrl: WorkflowImportUrlService;
  /** P3-16 (L12) */
  publishHistory: PublishHistoryService;
  /** P3-18 (L12): leader only, started and stopped with the pruner */
  historyCompaction: HistoryCompactionService;
  /** P3-19 (L14) */
  reviews: WorkflowReviewService;
  /** P4-03 (L4) */
  dataTables: DataTableService;
  /** P4-07 (L9): started before any job in startMain and startWorker, stopped in close */
  secrets: SecretsManager;
  /** P4-16 (L2) */
  formAuth: FormAuthService;
  /** P4-01 (L1) */
  formTokens: FormTokenService;
  /** P5-02 (L8): evaluation test runs; init and sweep in startMain, stopped in close */
  evaluations: EvaluationService;
  /** P5-03 (L7): MCP Server Trigger transports and runs; closed in close */
  mcpTrigger: McpTriggerService;
  /** P5-03 (L7): MCP trigger sessions (Redis in queue mode, else memory); sweep started in startMain */
  mcpSessions: McpSessionStore;
  /** P5-09 (L1): the AI workflow builder; closed in close */
  aiBuilder: AiBuilderService;
  /** P5-67 (L1): the Assistant (threads, chat, events); the leader timers run its sweep and pruneThreads */
  assistant: AssistantService;
  /** P5-67 (L3): approval cards */
  assistantApprovals: AssistantApprovals;
  /** P5-67 (L7): workflow drafts */
  assistantDrafts: AssistantDrafts;
  /** P5-67 (L8): a tenant's Assistant settings */
  assistantSettings: AssistantSettingsService;
  /** P6-03: scope checks (`requireScope` reads it as `app.access`), list filters, target projects */
  access: AccessService;
  /** P6-03 (L1): projects */
  projects: ProjectService;
  /** P6-29 (L9): shares of workflows and credentials */
  sharing: SharingService;
  /** P6-30 (L9): moves between projects */
  transfer: TransferService;
  /** P6-31 (L10): global and project variables */
  variables: VariableService;
  /** P6-32 (L11): custom roles */
  roles: RoleService;
  /** P6-33 (L12): the personal space policy */
  securitySettings: SecuritySettingsService;
  /** P6-17 (L1): mail (`isConfigured`, `send*`) */
  mailer: Mailer;
  /** P6-18 (L2): MFA setup and the sign-in step */
  mfa: MfaService;
  /** P6-19 (L3): password reset, profile, email change */
  passwords: PasswordService;
  /** P6-20 (L4): the members list and invitations (`inviteMany`) */
  members: MemberService;
  /** P6-21 (L5): API key edit, rotate, admin view, `onRoleChange` */
  apiKeys: ApiKeyService;
  /** P6-01 (L6): the sign-in method of a workspace */
  ssoSettings: SsoSettingsService;
  /** P6-01 (L6): the SSO sign-in rules and the fence */
  ssoLogin: SsoLoginService;
  /** P6-09 (L7) */
  saml: SamlService;
  /** P6-10 (L8) */
  oidc: OidcService;
  /** P6-11 (L9): role provisioning from the identity provider */
  provisioning: ProvisioningService;
  /** P6-12 (L10): LDAP sign-in and sync (the sweep runs on the leader) */
  ldap: LdapService;
  /** P6-02 (L13): SCIM users */
  scim: ScimService;
  /** P6-15 (L14): private (per user) credentials */
  privateCredentials: PrivateCredentialService;
  /** P6-16 (L15): JWE token responses */
  oauthJwe: OAuthJweService;
  /** P6-87 (L16): the credential gate of signed-in triggers */
  credentialGate: CredentialGateService;
  /**
   * P6-09, P6-10: plain http to an identity provider (`ContextOptions.allowInsecureIdp`, tests only; never
   * read from the environment). Services read `this.deps.context().allowInsecureIdp`.
   */
  allowInsecureIdp: boolean;
  /** start leader duties (triggers, wait tracker, pruning) on mains */
  startMain(): Promise<void>;
  /** consume the execution queue (queue mode workers) */
  startWorker(): Promise<void>;
  close(): Promise<void>;
}

/**
 * What the Phase 3 services get: the basics, plus the whole context read lazily (they call each
 * other, e.g. archive -> workflows -> reviews).
 */
export interface ServiceDeps {
  config: Config;
  database: Database;
  repos: Repositories;
  logger: PinoLogger;
  context: () => ServerContext;
}

export interface ContextOptions {
  config: Config;
  /** defaults to `loadNodePackages()` */
  nodePackages?: NodePackage[];
  logger?: PinoLogger;
  /** override the SSRF-guarded client (tests allow 127.0.0.1) */
  http?: HttpClient;
  /** apply migrations before returning (default true) */
  migrate?: boolean;
  /** added to the six built-in secret providers (tests add a fake vault) */
  secretProviderTypes?: SecretProviderType[];
  /** P5-09: the builder's agent runtime (tests pass one); default loads `@workflow/nodes-ai` when installed */
  aiRuntime?: AiRuntime;
  /**
   * P5-67: test seam, tools offered to the Assistant after the built-in ones (the service gets them as
   * `extraTools`, the approvals as their extra tools)
   */
  assistantTools?: AssistantToolDefinition[];
  /**
   * P6-09, P6-10: test seam, lets the SAML metadata and OIDC discovery use plain http (fake identity
   * providers on 127.0.0.1). Never read from the environment; default false.
   */
  allowInsecureIdp?: boolean;
}

/** P5-67: how often the leader sweeps stale Assistant runs and expired cards (fixed) */
export const ASSISTANT_SWEEP_INTERVAL_MS = 30_000;

export interface AssistantTimers {
  /** clears both timers and waits for a sweep or prune in flight */
  stop(): Promise<void>;
}

/**
 * P5-67: the Assistant's two leader timers, both `unref()`. `sweep` runs once at once, then every 30 s
 * (stale runs, expired cards); `pruneThreads` runs every `pruneIntervalMs` (thread TTL only; 0 is off).
 * A run never overlaps the one before it of the same kind; an error is logged, never thrown.
 */
export function startAssistantTimers(
  assistant: Pick<AssistantService, 'sweep' | 'pruneThreads'>,
  options: { pruneIntervalMs: number; logger: Pick<PinoLogger, 'warn'> },
): AssistantTimers {
  const inFlight = new Set<Promise<void>>();
  const busy = { sweep: false, prune: false };
  let stopped = false;
  const run = (kind: 'sweep' | 'prune') => {
    if (stopped || busy[kind]) return;
    busy[kind] = true;
    const now = new Date();
    const job = (async () => {
      try {
        await (kind === 'sweep' ? assistant.sweep(now) : assistant.pruneThreads(now));
      } catch (error) {
        options.logger.warn(
          { err: error },
          kind === 'sweep' ? 'Assistant sweep failed' : 'Assistant thread pruning failed',
        );
      } finally {
        busy[kind] = false;
      }
    })();
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
  };
  const sweepTimer = setInterval(() => run('sweep'), ASSISTANT_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  const pruneTimer =
    options.pruneIntervalMs > 0 ? setInterval(() => run('prune'), options.pruneIntervalMs) : undefined;
  pruneTimer?.unref();
  run('sweep');
  return {
    async stop() {
      stopped = true;
      clearInterval(sweepTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      await Promise.allSettled([...inFlight]);
    },
  };
}

export async function createContext(options: ContextOptions): Promise<ServerContext> {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel, { service: 'workflow-server' });
  const database = createDatabase(config.databaseUrl);
  if (options.migrate !== false) await runMigrations(database.pool);
  const repos = createRepositories(database.db);
  const registries = buildRegistries(options.nodePackages ?? (await loadNodePackages()));
  const cipher = new CredentialCipher(config.encryptionKeys);
  const http =
    options.http ??
    new HttpClient({
      ssrf: config.ssrf,
      userAgent: `${config.brand.name.replace(/[^\w.-]/g, '') || 'workflow'}/0.1`,
    });
  const codeRunner = new IsolatedVmCodeRunner({
    memoryLimitMb: config.code.memoryMb,
    timeoutMs: config.code.timeoutMs,
  });
  const pythonRunner = config.python.enabled
    ? new PyodideCodeRunner({
        memoryLimitMb: Math.max(config.code.memoryMb, MIN_PYTHON_MEMORY_MB),
        timeoutMs: config.code.timeoutMs,
        maxConcurrency: config.python.maxConcurrency,
        stdlibAllow: config.python.stdlibAllow,
        externalAllow: config.python.externalAllow,
        builtinsDeny: config.python.builtinsDeny,
        allowTransitiveImports: config.python.allowTransitiveImports,
        wheelsDir: config.python.wheelsDir || undefined,
      })
    : undefined;

  const queueMode = config.executionsMode === 'queue';
  const redisUrl = config.redisUrl;
  const redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }) : undefined;
  redis?.on('error', () => {});
  const bus: MessageBus =
    queueMode && redisUrl ? new RedisBus(redisUrl, config.queue.prefix) : new MemoryBus();
  const push = new PushService(bus);
  const queue = queueMode && redisUrl ? new ExecutionQueue(redisUrl, config.queue.prefix) : undefined;
  const leadership: Leadership =
    queueMode && redisUrl ? new RedisLeader(redisUrl, `${config.queue.prefix}:leader`) : new SingleLeader();
  const testWebhooks: TestWebhookStore =
    queueMode && redisUrl
      ? new RedisTestWebhookStore(redisUrl, config.queue.prefix)
      : new MemoryTestWebhookStore();

  const contextRef: { current?: ServerContext } = {};
  const serviceDeps: ServiceDeps = {
    config,
    database,
    repos,
    logger,
    context: () => {
      if (!contextRef.current) throw new Error('The server context is not ready yet');
      return contextRef.current;
    },
  };
  const folders = new FolderService(serviceDeps);
  const favorites = new FavoriteService(serviceDeps);
  const annotations = new AnnotationService(serviceDeps);
  const workflowImportUrl = new WorkflowImportUrlService(serviceDeps);
  const publishHistory = new PublishHistoryService(serviceDeps);
  const historyCompaction = new HistoryCompactionService(serviceDeps);
  const reviews = new WorkflowReviewService(serviceDeps);
  const dataTables = new DataTableService(serviceDeps);
  const secrets = new SecretsManager(serviceDeps, { secretProviderTypes: options.secretProviderTypes });
  const formAuth = new FormAuthService(serviceDeps);
  const formTokens = new FormTokenService(serviceDeps);
  const evaluations = new EvaluationService(serviceDeps);
  const mcpSessions = createMcpSessionStore({ config, logger, redis });
  const mcpTrigger = new McpTriggerService({ ...serviceDeps, sessions: mcpSessions });
  const mcpAuth = createMcpAuthHelper(serviceDeps.context);
  const aiBuilder = new AiBuilderService(serviceDeps, options.aiRuntime);
  // P5-67: the context keeps no copy of `aiRuntime`; the service hands it to `loadAiRuntime`
  const assistant = new AssistantService(serviceDeps, {
    aiRuntime: options.aiRuntime,
    extraTools: options.assistantTools,
  });
  const assistantApprovals = new AssistantApprovals(serviceDeps, options.assistantTools ?? []);
  const assistantDrafts = new AssistantDrafts(serviceDeps);
  const assistantSettings = new AssistantSettingsService(serviceDeps);
  // P6-03: the access service is FULL; the other five are C0 stubs whose methods throw until their lane
  const access = new AccessService(repos);
  const projects = new ProjectService(serviceDeps);
  const sharing = new SharingService(serviceDeps);
  const transfer = new TransferService(serviceDeps);
  const variables = new VariableService(serviceDeps);
  const roles = new RoleService(serviceDeps);
  const securitySettings = new SecuritySettingsService(serviceDeps);
  // P6 S2: C0 stubs whose per request methods throw until their lane; the PASSES seams keep today's behaviour
  const mailer = new Mailer(serviceDeps);
  const mfa = new MfaService(serviceDeps);
  const passwords = new PasswordService(serviceDeps);
  const members = new MemberService(serviceDeps);
  const apiKeys = new ApiKeyService(serviceDeps);
  const ssoSettings = new SsoSettingsService(serviceDeps);
  const ssoLogin = new SsoLoginService(serviceDeps);
  const saml = new SamlService(serviceDeps);
  const oidc = new OidcService(serviceDeps);
  const provisioning = new ProvisioningService(serviceDeps);
  const ldap = new LdapService(serviceDeps);
  const scim = new ScimService(serviceDeps);
  const privateCredentials = new PrivateCredentialService(serviceDeps);
  const oauthJwe = new OAuthJweService(serviceDeps);
  const credentialGate = new CredentialGateService(serviceDeps);
  let assistantTimers: AssistantTimers | undefined;
  const stopAssistantTimers = async () => {
    const timers = assistantTimers;
    assistantTimers = undefined;
    await timers?.stop();
  };

  const metrics = new Metrics({
    queueDepth: queue ? () => queue.depth() : undefined,
    activeWorkflows: async () => (await repos.workflows.listActiveAcrossTenants()).length,
  });
  const credentials = new CredentialService(repos, cipher, registries.credentialTypes);
  const auth = new AuthService(config, database, repos);
  // P6-01, P6-12, P6-18: the sign-in steps the SSO, LDAP and MFA services own
  auth.useSignInSteps({
    passwordTenants: (user, tenants, workspace) => ssoLogin.passwordTenants(user, tenants, workspace),
    directoryLogin: (input, meta) => ldap.loginWithDirectory(input, meta),
    directorySignIn: (match, meta) =>
      ssoLogin.signIn(match.tenant, match.profile, meta, { authMethod: 'ldap' }),
    mfaStep: (user, input) => mfa.verifyLoginStep(user, input),
    assertInviteAcceptable: (tenantId) => ssoLogin.assertInviteAcceptable(tenantId),
    assertSessionEntry: (authContext, tenantId) => ssoLogin.assertSessionEntry(authContext, tenantId),
  });
  const oauth1 = new OAuth1Service(config, repos, credentials, cipher, http, redis);
  const oauth2 = new OAuth2Service(config, repos, credentials, cipher, http);
  // P6-16: the callback decrypts a JWE token response (the stub keeps a plain one)
  oauth2.useJwe((tenantId, token, data) => oauthJwe.decryptResponse(tenantId, token, data));
  const executions = new ExecutionService({
    config,
    repos,
    nodeTypes: registries.nodeTypes,
    credentials,
    http,
    codeRunner,
    pythonRunner,
    dataTables,
    formTokens,
    formAuth,
    logger,
    push,
    bus,
    metrics,
    queue,
    serviceDeps,
  });
  const activeWorkflows = new ActiveWorkflowManager({
    config,
    database,
    repos,
    nodeTypes: registries.nodeTypes,
    executions,
    logger,
    bus,
    leadership,
    privateCredentials,
  });
  const webhooks = new WebhookService({
    config,
    repos,
    nodeTypes: registries.nodeTypes,
    executions,
    testWebhooks,
    push,
    metrics,
    logger,
    formTokens,
    formAuth,
    mcpTrigger,
    mcpAuth,
  });
  const workflows = new WorkflowService({
    config,
    database,
    repos,
    nodeTypes: registries.nodeTypes,
    executions,
    activeWorkflows,
    testWebhooks,
    favorites,
    publishHistory,
    reviews,
    formTokens,
    context: serviceDeps.context,
  });
  const workflowArchive = new WorkflowArchiveService(serviceDeps);
  const waitTracker = new WaitTracker(repos, executions, logger, config.waitTrackerIntervalMs);
  const pruner = new Pruner(config, repos, executions, logger);

  let started = false;
  let closed = false;
  const context: ServerContext = {
    config,
    logger,
    database,
    repos,
    registries,
    cipher,
    http,
    bus,
    push,
    redis,
    queue,
    leadership,
    metrics,
    credentials,
    auth,
    oauth1,
    oauth2,
    executions,
    activeWorkflows,
    testWebhooks,
    webhooks,
    workflows,
    waitTracker,
    pruner,
    folders,
    favorites,
    workflowArchive,
    annotations,
    workflowImportUrl,
    publishHistory,
    historyCompaction,
    reviews,
    dataTables,
    secrets,
    formAuth,
    formTokens,
    evaluations,
    mcpTrigger,
    mcpSessions,
    aiBuilder,
    assistant,
    assistantApprovals,
    assistantDrafts,
    assistantSettings,
    access,
    projects,
    sharing,
    transfer,
    variables,
    roles,
    securitySettings,
    mailer,
    mfa,
    passwords,
    members,
    apiKeys,
    ssoSettings,
    ssoLogin,
    saml,
    oidc,
    provisioning,
    ldap,
    scim,
    privateCredentials,
    oauthJwe,
    credentialGate,
    allowInsecureIdp: options.allowInsecureIdp === true,

    async startMain() {
      if (started) return;
      started = true;
      // triggers and resumed runs resolve credentials: the secrets must be loaded first
      await secrets.start();
      await executions.init();
      await evaluations.init();
      await activeWorkflows.init();
      if (!queueMode) {
        // the service also pushes the status change and starts error workflows (R42)
        const crashed = await executions.markCrashed();
        if (crashed > 0) logger.warn({ crashed }, 'Marked executions of a previous run as crashed');
      }
      // outside the regular-mode block: in queue mode it closes only runs no main touched for 5 minutes
      const interrupted = await evaluations.sweepInterrupted();
      if (interrupted > 0) logger.warn({ interrupted }, 'Marked test runs of a previous run as interrupted');
      // P5-03: idle MCP trigger sessions end on every main (each holds its own streams)
      mcpSessions.startSweep();
      await leadership.start(
        async () => {
          logger.info('This instance is the leader: starting triggers, wait tracker and pruning');
          await activeWorkflows.startAll();
          waitTracker.start();
          pruner.start();
          historyCompaction.start();
          // P6-12: LDAP syncs of the workspaces that are due
          ldap.startSweep();
          // P5-67: stale runs and expired cards every 30 s (one run now); thread TTL pruning
          await stopAssistantTimers();
          assistantTimers = startAssistantTimers(assistant, {
            pruneIntervalMs: config.assistant.pruneIntervalMs,
            logger,
          });
        },
        async () => {
          logger.warn('Leadership lost: stopping triggers, wait tracker and pruning');
          waitTracker.stop();
          pruner.stop();
          historyCompaction.stop();
          ldap.stopSweep();
          await stopAssistantTimers();
          await activeWorkflows.stopAll();
        },
      );
    },

    async startWorker() {
      if (!queue) throw new Error('Workers need EXECUTIONS_MODE=queue and REDIS_URL');
      if (!started) {
        started = true;
        await secrets.start();
        await executions.init();
      }
      queue.startWorker((job, meta) => executions.runQueued(job, meta), config.queue.concurrency);
      logger.info({ concurrency: config.queue.concurrency }, 'Worker is consuming the execution queue');
    },

    async close() {
      if (closed) return;
      closed = true;
      waitTracker.stop();
      pruner.stop();
      historyCompaction.stop();
      ldap.stopSweep();
      await stopAssistantTimers();
      await leadership.stop().catch(() => {});
      await activeWorkflows.close().catch(() => {});
      await queue?.close().catch(() => {});
      await evaluations.close().catch(() => {});
      await aiBuilder.close().catch(() => {});
      await assistant.close().catch(() => {});
      await mcpTrigger.close().catch(() => {});
      await mcpSessions.close().catch(() => {});
      await executions.close().catch(() => {});
      await testWebhooks.close().catch(() => {});
      await secrets.stop().catch(() => {});
      await bus.close().catch(() => {});
      await redis?.quit().catch(() => {});
      if (!options.http) await http.close().catch(() => {});
      await database.close().catch(() => {});
    },
  };
  contextRef.current = context;
  return context;
}
