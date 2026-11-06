/**
 * The SSH credential test (sshPassword and sshPrivateKey): open a connection to the checked address
 * of the host and sign in. The command-free handshake is the whole test. A failure answers with a
 * fixed text, never with the server's own text.
 */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';
import ssh2 from 'ssh2';
import { connectSocket, remoteHost, remotePort, sshAuthConfig, sshFailure } from '../utils/remote-connect';

export { sshFailure };

const READY_TIMEOUT_MS = 15_000;

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
