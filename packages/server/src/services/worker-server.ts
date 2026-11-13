/**
 * P6-71 (S5 fix, metrics-1): the small HTTP server of a queue worker (n8n's WorkerServer). A worker serves no REST
 * or webhook traffic, so without it the families a worker feeds (events, executions, SSRF and DNS counters) could
 * never be scraped in queue mode. It answers `GET /healthz`, `GET /healthz/readiness` and `GET /metrics` (the same
 * bearer token as the main) and nothing else.
 *
 * It starts when `QUEUE_HEALTH_CHECK_ACTIVE` is on, or when any opt-in metrics family is on; the port is
 * `QUEUE_HEALTH_CHECK_PORT` (n8n's default 5679) on the server's `HOST`.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { type Config, ConfigError } from '../config';
import type { ServerContext } from '../context';
import { READ_TIMEOUT_MS, withTimeout } from './metrics-collectors';

export const DEFAULT_WORKER_PORT = 5679;

/** the opt-in families (not the two on by default, not the label toggles) */
const FAMILY_TOGGLES = [
  'includeApiEndpoints',
  'includeMessageEventBusMetrics',
  'includeQueueMetrics',
  'includeSchedulerMetrics',
  'includePollTriggerMetrics',
  'includeWorkflowStatistics',
  'includeSsrfMetrics',
  'includeDnsCacheMetrics',
  'includeWebhookMetrics',
  'includeFormMetrics',
  'includeDbPoolMetrics',
] as const;

const flag = (value: string | undefined): boolean =>
  value !== undefined && ['true', '1', 'yes'].includes(value.toLowerCase());

/** the port the worker's server listens on, or undefined when no server is wanted */
export function workerServerPort(
  config: Pick<Config, 'metrics'>,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const wanted = flag(env.QUEUE_HEALTH_CHECK_ACTIVE) || FAMILY_TOGGLES.some((key) => config.metrics[key]);
  if (!wanted) return undefined;
  const raw = env.QUEUE_HEALTH_CHECK_PORT;
  if (raw === undefined || raw === '') return DEFAULT_WORKER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('QUEUE_HEALTH_CHECK_PORT must be a port number from 1 to 65535');
  }
  return port;
}

export type WorkerServerContext = Pick<ServerContext, 'config' | 'database' | 'redis' | 'metrics'>;

/** starts the server; resolves once it listens. `close()` stops it. */
export async function startWorkerServer(
  ctx: WorkerServerContext,
  port: number,
): Promise<{ server: Server; close(): Promise<void> }> {
  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET') return send(res, 404, '{"error":"not_found"}');
      if (path === '/healthz') return send(res, 200, '{"status":"ok"}');
      if (path === '/healthz/readiness') {
        const checks: Record<string, 'ok' | 'error'> = {};
        try {
          await withTimeout(ctx.database.pool.query('select 1'), READ_TIMEOUT_MS);
          checks.database = 'ok';
        } catch {
          checks.database = 'error';
        }
        if (ctx.redis) {
          try {
            await withTimeout(ctx.redis.ping(), 2000);
            checks.redis = 'ok';
          } catch {
            checks.redis = 'error';
          }
        }
        const ok = Object.values(checks).every((v) => v === 'ok');
        return send(res, ok ? 200 : 503, JSON.stringify({ status: ok ? 'ok' : 'error', checks }));
      }
      if (path === '/metrics') {
        const token = ctx.config.metricsToken;
        if (token && req.headers.authorization !== `Bearer ${token}`) {
          return send(res, 401, '{"error":"unauthorized","message":"A metrics token is required"}');
        }
        return send(res, 200, await ctx.metrics.registry.metrics(), ctx.metrics.registry.contentType);
      }
      return send(res, 404, '{"error":"not_found"}');
    })().catch(() => {
      if (!res.headersSent) send(res, 500, '{"error":"server_error"}');
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: ctx.config.host }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
