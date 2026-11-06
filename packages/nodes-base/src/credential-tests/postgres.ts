/**
 * The Postgres credential test: sign in with the credential (through the SSRF-guarded pool of the
 * Postgres node, so the SSH tunnel and TLS options apply) and run `SELECT 1`. A failure answers with
 * a fixed text chosen from the SQLSTATE or the socket error code, never with the server's own text.
 */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';

const OK: NodeCredentialTestResult = { status: 'OK', message: 'Connection tested successfully' };
const CONNECT_TIMEOUT_SECONDS = 15;

function failure(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? '');
  if (code === '28P01' || code === '28000') return 'Postgres refused the user name or password';
  if (code === '3D000') return "The database doesn't exist";
  if (code.startsWith('28')) return 'Postgres refused the sign-in';
  if (code === 'ECONNREFUSED') return "Couldn't connect to Postgres: the connection was refused";
  if (code === 'ENOTFOUND') return "Couldn't connect to Postgres: the host was not found";
  if (code === 'ETIMEDOUT') return "Couldn't connect to Postgres: the connection timed out";
  if (code === 'ECONNRESET') return "Couldn't connect to Postgres: the connection was closed";
  const text = (error as Error)?.message ?? '';
  if (/timeout|timed out/i.test(text)) return "Couldn't connect to Postgres: the connection timed out";
  if (/ssl|tls|certificate/i.test(text)) return "Couldn't connect to Postgres over TLS";
  return "Couldn't connect to Postgres";
}

export async function postgresCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  // loaded when used: the Postgres node imports this file for its `methods`
  const { postgresPool } = await import('../nodes/apps/sql/Postgres.node');
  let pool: Awaited<ReturnType<typeof postgresPool>> | undefined;
  const abort = () => void pool?.end().catch(() => undefined);
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      pool = await postgresPool(
        {
          getCredentials: async () => credential.data as never,
          helpers: ctx.helpers as never,
          signal: ctx.signal,
        },
        { connectionTimeoutSeconds: CONNECT_TIMEOUT_SECONDS },
      );
    } catch (error) {
      // our own texts: a missing host, the SSRF guard, the SSH tunnel
      return { status: 'Error', message: (error as Error).message };
    }
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      return { status: 'Error', message: failure(error) };
    }
    return OK;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    await pool?.end().catch(() => undefined);
  }
}
