/**
 * The SSH credential test (sshPassword and sshPrivateKey): open a connection to the checked address
 * of the host and sign in. The command-free handshake is the whole test. A failure answers with a
 * fixed text, never with the server's own text.
 */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';
import ssh2 from 'ssh2';
import { connectSocket, remoteHost, remotePort, sshAuthConfig } from '../utils/remote-connect';

const READY_TIMEOUT_MS = 15_000;

export function sshFailure(error: unknown): string {
  const text = (error as Error)?.message ?? '';
  const level = (error as { level?: string })?.level;
  if (level === 'client-authentication' || /authentication methods failed/i.test(text))
    return 'SSH refused the user name, password or key';
  if (/privatekey|private key|passphrase|parse|decrypt/i.test(text))
    return 'The private key is not valid or its passphrase is wrong';
  if (/timed out|timeout/i.test(text)) return "Couldn't connect over SSH: the connection timed out";
  if (level === 'client-socket' || /connection closed/i.test(text))
    return "Couldn't connect over SSH: the connection was closed";
  return "Couldn't complete the SSH handshake";
}

export async function sshCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  const creds = credential.data;
  const usePrivateKey = credential.type === 'sshPrivateKey';
  let sock: Awaited<ReturnType<typeof connectSocket>> | undefined;
  let client: ssh2.Client | undefined;
  const abort = () => {
    client?.end();
    sock?.destroy();
  };
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      const host = remoteHost(creds.host, 'SSH');
      const port = remotePort(creds.port, 22);
      sock = await connectSocket(
        { helpers: ctx.helpers as never, signal: ctx.signal },
        host,
        port,
        READY_TIMEOUT_MS,
      );
    } catch (error) {
      // our own texts: a bad port or host, the SSRF guard, the socket error code
      return { status: 'Error', message: (error as Error).message };
    }
    const connection = new ssh2.Client();
    client = connection;
    try {
      await new Promise<void>((resolve, reject) => {
        connection.once('ready', () => resolve());
        connection.once('error', reject);
        connection.once('close', () => reject(new Error('the connection closed')));
        connection.connect({ sock, readyTimeout: READY_TIMEOUT_MS, ...sshAuthConfig(creds, usePrivateKey) });
      });
    } catch (error) {
      return { status: 'Error', message: sshFailure(error) };
    }
    return { status: 'OK', message: 'Connection tested successfully' };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    client?.end();
    sock?.destroy();
  }
}
