/**
 * The MySQL credential test: sign in with the credential (through the SSRF-guarded pool of the MySQL
 * node, so the SSH tunnel and TLS options apply) and run `SELECT 1`. A failure answers with a fixed
 * text chosen from the error code, never with the server's own text.
 */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';

const OK: NodeCredentialTestResult = { status: 'OK', message: 'Connection tested successfully' };
const CONNECT_TIMEOUT_SECONDS = 15;

function failure(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? '');
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR')
    return 'MySQL refused the user name or password';
  if (code === 'ER_DBACCESS_DENIED_ERROR') return 'MySQL refused access to the database';
  if (code === 'ER_BAD_DB_ERROR') return "The database doesn't exist";
  if (code === 'ECONNREFUSED') return "Couldn't connect to MySQL: the connection was refused";
  if (code === 'ENOTFOUND') return "Couldn't connect to MySQL: the host was not found";
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT')
    return "Couldn't connect to MySQL: the connection timed out";
  if (code === 'ECONNRESET' || code === 'PROTOCOL_CONNECTION_LOST')
    return "Couldn't connect to MySQL: the connection was closed";
  if (code.startsWith('ER_')) return 'MySQL refused the sign-in';
  const text = (error as Error)?.message ?? '';
  if (/ssl|tls|certificate/i.test(text)) return "Couldn't connect to MySQL over TLS";
  return "Couldn't connect to MySQL";
}

export async function mysqlCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  // loaded when used: the MySQL node imports this file for its `methods`
  const { mysqlPool } = await import('../nodes/apps/sql/MySql.node');
  let pool: Awaited<ReturnType<typeof mysqlPool>> | undefined;
  const abort = () => void pool?.end().catch(() => undefined);
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      pool = await mysqlPool(
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
