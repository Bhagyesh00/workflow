/**
 * The SMTP credential test: connect to the checked address of the host, start TLS as the credential
 * says and sign in (nodemailer `verify`). No mail is sent. A failure answers with a fixed text, never
 * with the server's own text.
 */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';
import { createSmtpTransport, type SmtpCredentials } from '../utils/smtp-transport';

const TIMEOUT_MS = 20_000;

function failure(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? '');
  if (code === 'EAUTH') return 'The SMTP server refused the user name or password';
  if (code === 'ECONNREFUSED') return "Couldn't connect to the SMTP server: the connection was refused";
  if (code === 'ENOTFOUND' || code === 'EDNS')
    return "Couldn't connect to the SMTP server: the host was not found";
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT')
    return "Couldn't connect to the SMTP server: the connection timed out";
  if (code === 'ESOCKET' || code === 'ECONNRESET')
    return /tls|ssl|certificate|wrong version/i.test((error as Error)?.message ?? '')
      ? "Couldn't connect to the SMTP server over TLS"
      : "Couldn't connect to the SMTP server: the connection was closed";
  if (code === 'EPROTOCOL') return 'The SMTP server refused the connection';
  return "Couldn't connect to the SMTP server";
}

export async function smtpCredentialTest(
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let transport: Awaited<ReturnType<typeof createSmtpTransport>>;
  try {
    transport = await createSmtpTransport(ctx, credential.data as SmtpCredentials);
  } catch (error) {
    // our own texts: a missing host, the SSRF guard
    return { status: 'Error', message: (error as Error).message };
  }
  // nodemailer's verify cannot be cancelled: the test stops waiting on a cancel or after the bound,
  // and closing the transport drops the socket
  let stop: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(Object.assign(new Error('stopped'), { code: 'ETIMEDOUT' }));
  });
  stopped.catch(() => undefined);
  const timer = setTimeout(stop, TIMEOUT_MS);
  const abort = () => {
    stop();
    transport.close();
  };
  if (ctx.signal.aborted) abort();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    await Promise.race([transport.verify(), stopped]);
    return { status: 'OK', message: 'Connection tested successfully' };
  } catch (error) {
    return { status: 'Error', message: failure(error) };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', abort);
    transport.close();
  }
}
