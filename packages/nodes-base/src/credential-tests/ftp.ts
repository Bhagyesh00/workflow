/**
 * The FTP and SFTP credential test. FTP: sign in to a checked address of the host (basic-ftp gets the
 * IP literal, so a DNS rebind cannot redirect it). SFTP: sign in over SSH through the checked socket
 * and open the SFTP subsystem. A failure answers with a fixed text, never with the server's own text.
 */

import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';
import { FTPError } from 'basic-ftp';
import ssh2 from 'ssh2';
import { createFtpClient } from '../utils/file-transfer';
import { connectSocket, remoteHost, remotePort, sshAuthConfig } from '../utils/remote-connect';
import { sshFailure } from './ssh';

const OK: NodeCredentialTestResult = { status: 'OK', message: 'Connection tested successfully' };
const TIMEOUT_MS = 15_000;

function ftpFailure(error: unknown): string {
  if (error instanceof FTPError) {
    const code = Number(error.code);
    if (code === 530 || code === 331 || code === 332) return 'FTP refused the user name or password';
    return 'FTP refused the sign-in';
  }
  const code = String((error as { code?: unknown })?.code ?? '');
  if (code === 'ECONNREFUSED') return "Couldn't connect over FTP: the connection was refused";
  if (code === 'ETIMEDOUT') return "Couldn't connect over FTP: the connection timed out";
  if (code === 'ECONNRESET') return "Couldn't connect over FTP: the connection was closed";
  if (/timeout|timed out/i.test((error as Error)?.message ?? ''))
    return "Couldn't connect over FTP: the connection timed out";
  return "Couldn't connect over FTP";
}

async function testFtp(ctx: CredentialTestContext, creds: DataObject): Promise<NodeCredentialTestResult> {
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  let port: number;
  try {
    const host = remoteHost(creds.host, 'FTP');
    port = remotePort(creds.port, 21);
    addresses = (await ctx.helpers.resolveAllowedHost(host)).addresses as typeof addresses;
  } catch (error) {
    // our own texts: a bad port or host, the SSRF guard
    return { status: 'Error', message: (error as Error).message };
  }
  const client = createFtpClient(TIMEOUT_MS);
  const abort = () => client.close();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    let lastError: unknown;
    for (const address of addresses) {
      try {
        client.ftp.ipFamily = address.family;
        await client.access({
          host: address.address,
          port,
          user: creds.username ? String(creds.username) : undefined,
          password: creds.username ? String(creds.password ?? '') : undefined,
        });
        return OK;
      } catch (error) {
        lastError = error;
        // the server answered (wrong password, ...): another address of the same host would not help
        if (error instanceof FTPError) break;
      }
    }
    return { status: 'Error', message: ftpFailure(lastError) };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    client.close();
  }
}

async function testSftp(ctx: CredentialTestContext, creds: DataObject): Promise<NodeCredentialTestResult> {
  let sock: Awaited<ReturnType<typeof connectSocket>> | undefined;
  let client: ssh2.Client | undefined;
  const abort = () => {
    client?.end();
    sock?.destroy();
  };
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      const host = remoteHost(creds.host, 'SFTP');
      const port = remotePort(creds.port, 22);
      sock = await connectSocket(
        { helpers: ctx.helpers as never, signal: ctx.signal },
        host,
        port,
        TIMEOUT_MS,
      );
    } catch (error) {
      return { status: 'Error', message: (error as Error).message };
    }
    const connection = new ssh2.Client();
    client = connection;
    try {
      await new Promise<void>((resolve, reject) => {
        connection.once('ready', () => resolve());
        connection.once('error', reject);
        connection.once('close', () => reject(new Error('the connection closed')));
        // as the SFTP node: the key first, the password along with it
        connection.connect({ sock, readyTimeout: TIMEOUT_MS, ...sshAuthConfig(creds, true, true) });
      });
    } catch (error) {
      return { status: 'Error', message: sshFailure(error) };
    }
    try {
      await new Promise<void>((resolve, reject) =>
        connection.sftp((error, channel) => {
          if (error) return reject(error);
          channel.end();
          resolve();
        }),
      );
    } catch {
      return { status: 'Error', message: "The server doesn't offer SFTP" };
    }
    return OK;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    client?.end();
    sock?.destroy();
  }
}

export async function ftpCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  return credential.type === 'sftp' ? testSftp(ctx, credential.data) : testFtp(ctx, credential.data);
}
