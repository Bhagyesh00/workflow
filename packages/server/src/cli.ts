/**
 * Command line entry point (run with `node --no-node-snapshot --import tsx src/cli.ts <command>`):
 *   start    main process: HTTP API, webhooks, triggers (leader), executions in regular mode
 *   worker   queue worker (EXECUTIONS_MODE=queue); with QUEUE_HEALTH_CHECK_ACTIVE (or an opt-in METRICS_INCLUDE_*
 *            family on) it also serves /metrics and /healthz on QUEUE_HEALTH_CHECK_PORT (5679)
 *   migrate  apply database migrations
 *   seed     create a demo workspace, owner and sample workflow
 *   mfa:disable  turn a user's two-factor sign-in off (`--email <address>`)
 *   ldap:reset   clear a workspace's LDAP setup (`--tenant <slug>` and one of `--userId`, `--projectId`,
 *                `--deleteWorkflowsAndCredentials`)
 * P6-78 (S4 L11), each on one workspace (`--tenant <slug>`, except export:nodes); the exit code is the command's:
 *   export:workflow     export workflows as JSON (`--all` or `--id`, `--output`, `--pretty`, `--separate`)
 *   import:workflow     import workflows (`--input`, `--separate`, `--projectId`)
 *   list:workflow       list workflows (`--active`, `--onlyId`)
 *   publish:workflow    publish workflows (`--id` or `--all`)
 *   unpublish:workflow  unpublish workflows (`--id` or `--all`)
 *   export:credentials  export credentials (`--all` or `--id`, `--output`, `--separate`, `--decrypted`)
 *   import:credentials  import credentials (`--input`, `--projectId`)
 *   export:nodes        export the node types (`--output`)
 *   execute             run a workflow in this process (`--id`, `--rawOutput`)
 *   execute-batch       run several workflows (`--ids`, `--concurrency`, `--retries`, `--skipList`, `--output`)
 *   audit               the security audit (`--categories`, `--days-abandoned-workflow`)
 */
import { buildApp } from './app';
import { auditCommand } from './commands/audit';
import { type CommandIo, processIo } from './commands/command-io';
import { exportCredentialsCommand } from './commands/credentials-export';
import { importCredentialsCommand } from './commands/credentials-import';
import { executeCommand } from './commands/execute';
import { executeBatchCommand } from './commands/execute-batch';
import { ldapResetCommand } from './commands/ldap-reset';
import { mfaDisableCommand } from './commands/mfa-disable';
import { exportNodesCommand } from './commands/nodes-export';
import { exportWorkflowCommand } from './commands/workflow-export';
import { importWorkflowCommand } from './commands/workflow-import';
import { listWorkflowCommand } from './commands/workflow-list';
import { publishWorkflowCommand, unpublishWorkflowCommand } from './commands/workflow-publish';
import { ConfigError, loadConfig } from './config';
import { createContext, type ServerContext } from './context';
import { createDatabase, runMigrations } from './db/client';
import { createLogger } from './logger';
import { seed } from './seed';
import { startWorkerServer, workerServerPort } from './services/worker-server';

/** P6-78 (S4 L11): the data commands; each returns its exit code */
const DATA_COMMANDS: Record<string, (ctx: ServerContext, argv: string[], io?: CommandIo) => Promise<number>> =
  {
    'export:workflow': exportWorkflowCommand,
    'import:workflow': importWorkflowCommand,
    'list:workflow': listWorkflowCommand,
    'publish:workflow': publishWorkflowCommand,
    'unpublish:workflow': unpublishWorkflowCommand,
    'export:credentials': exportCredentialsCommand,
    'import:credentials': importCredentialsCommand,
    'export:nodes': exportNodesCommand,
    execute: executeCommand,
    'execute-batch': executeBatchCommand,
    audit: auditCommand,
  };

function onShutdown(close: () => Promise<void>, logger: { info(msg: string): void }) {
  let closing = false;
  const handler = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info(`Received ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

async function main(command: string): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: 'workflow-server', process: command });

  if (command === 'migrate') {
    const database = createDatabase(config.databaseUrl, { max: 1 });
    await runMigrations(database.pool);
    await database.close();
    logger.info('Migrations applied');
    return;
  }

  if (command === 'seed') {
    const ctx = await createContext({ config, logger });
    try {
      const result = await seed(ctx, {
        email: process.env.SEED_EMAIL,
        password: process.env.SEED_PASSWORD,
      });
      if (result.created) {
        process.stdout.write(
          [
            'Demo workspace created',
            `  URL:       ${config.baseUrl}`,
            `  Email:     ${result.email}`,
            `  Password:  ${result.password}`,
            `  Workspace: ${result.tenantSlug}`,
            '',
          ].join('\n'),
        );
      } else {
        process.stdout.write(`A user ${result.email} already exists (workspace "${result.tenantSlug}")\n`);
      }
    } finally {
      await ctx.close();
    }
    return;
  }

  // P6-18, P6-12: maintenance commands on a context with no listener (no triggers, no leader duties)
  if (command === 'mfa:disable' || command === 'ldap:reset') {
    const ctx = await createContext({ config, logger });
    try {
      const run = command === 'mfa:disable' ? mfaDisableCommand : ldapResetCommand;
      await run(ctx, process.argv.slice(3));
    } finally {
      await ctx.close();
    }
    return;
  }

  // P6-78: the data commands, on a context with no listener; the exit code is the command's
  const dataCommand = Object.hasOwn(DATA_COMMANDS, command) ? DATA_COMMANDS[command] : undefined;
  if (dataCommand) {
    const ctx = await createContext({ config, logger });
    try {
      process.exitCode = await dataCommand(ctx, process.argv.slice(3), processIo());
    } finally {
      await ctx.close();
    }
    return;
  }

  if (command === 'worker') {
    if (config.executionsMode !== 'queue') {
      throw new ConfigError('The worker command needs EXECUTIONS_MODE=queue (and REDIS_URL)');
    }
    const ctx = await createContext({ config, logger });
    await ctx.startWorker();
    // P6-71: the worker serves /metrics and the health paths when asked (n8n's WorkerServer)
    const port = workerServerPort(config);
    const health = port === undefined ? undefined : await startWorkerServer(ctx, port);
    if (health) logger.info({ port }, 'Worker server listening for metrics and health checks');
    onShutdown(async () => {
      await health?.close();
      await ctx.close();
    }, logger);
    return;
  }

  if (command === 'start') {
    let ctx: ServerContext | undefined;
    ctx = await createContext({ config, logger });
    const app = await buildApp(ctx);
    await ctx.startMain();
    await app.listen({ port: config.port, host: config.host });
    logger.info(
      { baseUrl: config.baseUrl, mode: config.executionsMode },
      `${config.brand.name} server listening on ${config.host}:${config.port}`,
    );
    onShutdown(async () => {
      await app.close();
      await ctx?.close();
      ctx = undefined;
    }, logger);
    return;
  }

  throw new ConfigError(
    `Unknown command "${command}". Use start, worker, migrate, seed, mfa:disable, ldap:reset, ${Object.keys(DATA_COMMANDS).join(', ')}.`,
  );
}

main(process.argv[2] ?? 'start').catch((error) => {
  process.stderr.write(`${error instanceof ConfigError ? error.message : (error?.stack ?? String(error))}\n`);
  process.exit(1);
});
