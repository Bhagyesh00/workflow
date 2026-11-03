/**
 * Wires configuration, database, Redis, registries and services for one process
 * (a main serving HTTP, or a queue worker).
 */
import { CredentialCipher, HttpClient, IsolatedVmCodeRunner } from '@workflow/core';
import type { NodePackage } from '@workflow/workflow';
import { Redis } from 'ioredis';
import type { Config } from './config';
import { createDatabase, type Database, runMigrations } from './db/client';
import { createLogger, type PinoLogger } from './logger';
import { buildRegistries, loadNodePackages, type Registries } from './node-packages';
import { createRepositories, type Repositories } from './repositories';
import { ActiveWorkflowManager } from './services/active-workflows';
import { AnnotationService } from './services/annotations';
import { AuthService } from './services/auth';
import { MemoryBus, type MessageBus, PushService, RedisBus } from './services/bus';
import { CredentialService } from './services/credentials';
import { ExecutionService } from './services/executions';
import { FavoriteService } from './services/favorites';
import { FolderService } from './services/folders';
import { HistoryCompactionService } from './services/history-compaction';
import { Pruner, WaitTracker } from './services/maintenance';
import { Metrics } from './services/metrics';
import { OAuth1Service } from './services/oauth1';
import { OAuth2Service } from './services/oauth2';
import { PublishHistoryService } from './services/publish-history';
import { ExecutionQueue, type Leadership, RedisLeader, SingleLeader } from './services/queue';
import {
  MemoryTestWebhookStore,
  RedisTestWebhookStore,
  type TestWebhookStore,
} from './services/test-webhooks';
import { WebhookService } from './services/webhooks';
import { WorkflowArchiveService } from './services/workflow-archive';
import { WorkflowImportUrlService } from './services/workflow-import-url';
import { WorkflowReviewService } from './services/workflow-reviews';
import { WorkflowService } from './services/workflows';

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

  const metrics = new Metrics({
    queueDepth: queue ? () => queue.depth() : undefined,
    activeWorkflows: async () => (await repos.workflows.listActiveAcrossTenants()).length,
  });
  const credentials = new CredentialService(repos, cipher, registries.credentialTypes);
  const auth = new AuthService(config, database, repos);
  const oauth1 = new OAuth1Service(config, repos, credentials, cipher, http, redis);
  const oauth2 = new OAuth2Service(config, repos, credentials, cipher, http);
  const executions = new ExecutionService({
    config,
    repos,
    nodeTypes: registries.nodeTypes,
    credentials,
    http,
    codeRunner,
    logger,
    push,
    bus,
    metrics,
    queue,
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

    async startMain() {
      if (started) return;
      started = true;
      await executions.init();
      await activeWorkflows.init();
      if (!queueMode) {
        // the service also pushes the status change and starts error workflows (R42)
        const crashed = await executions.markCrashed();
        if (crashed > 0) logger.warn({ crashed }, 'Marked executions of a previous run as crashed');
      }
      await leadership.start(
        async () => {
          logger.info('This instance is the leader: starting triggers, wait tracker and pruning');
          await activeWorkflows.startAll();
          waitTracker.start();
          pruner.start();
          historyCompaction.start();
        },
        async () => {
          logger.warn('Leadership lost: stopping triggers, wait tracker and pruning');
          waitTracker.stop();
          pruner.stop();
          historyCompaction.stop();
          await activeWorkflows.stopAll();
        },
      );
    },

    async startWorker() {
      if (!queue) throw new Error('Workers need EXECUTIONS_MODE=queue and REDIS_URL');
      if (!started) {
        started = true;
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
      await leadership.stop().catch(() => {});
      await activeWorkflows.close().catch(() => {});
      await queue?.close().catch(() => {});
      await executions.close().catch(() => {});
      await testWebhooks.close().catch(() => {});
      await bus.close().catch(() => {});
      await redis?.quit().catch(() => {});
      if (!options.http) await http.close().catch(() => {});
      await database.close().catch(() => {});
    },
  };
  contextRef.current = context;
  return context;
}
