/**
 * Command line entry point (run with `node --no-node-snapshot --import tsx src/cli.ts <command>`):
 *   start    main process: HTTP API, webhooks, triggers (leader), executions in regular mode
 *   worker   queue worker (EXECUTIONS_MODE=queue)
 *   migrate  apply database migrations
 *   seed     create a demo workspace, owner and sample workflow
 */
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createContext, type ServerContext } from './context';
import { createDatabase, runMigrations } from './db/client';
import { createLogger } from './logger';
import { seed } from './seed';

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

  if (command === 'worker') {
    if (config.executionsMode !== 'queue') {
      throw new ConfigError('The worker command needs EXECUTIONS_MODE=queue (and REDIS_URL)');
    }
    const ctx = await createContext({ config, logger });
    await ctx.startWorker();
    onShutdown(() => ctx.close(), logger);
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

  throw new ConfigError(`Unknown command "${command}". Use start, worker, migrate or seed.`);
}

main(process.argv[2] ?? 'start').catch((error) => {
  process.stderr.write(`${error instanceof ConfigError ? error.message : (error?.stack ?? String(error))}\n`);
  process.exit(1);
});
