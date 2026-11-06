/**
 * The nodemailer transport of an `smtp` credential. SMTP is not HTTP, so the host is resolved and
 * checked against the SSRF policy with `resolveAllowedHost`, and nodemailer connects only to those
 * checked addresses.
 */
import net from 'node:net';
import type { DataObject, NodeHelpers } from '@workflow/workflow';
import nodemailer, { type Transporter } from 'nodemailer';

export interface SmtpCredentials extends DataObject {
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  disableStartTls?: boolean;
  hostName?: string;
}

export async function createSmtpTransport(
  ctx: { helpers: Pick<NodeHelpers, 'resolveAllowedHost'> },
  creds: SmtpCredentials,
  options: { allowUnauthorizedCerts?: boolean } = {},
): Promise<Transporter> {
  const host = String(creds.host ?? '').trim();
  if (!host) throw new Error('The SMTP credential has no host');
  const allowed = await ctx.helpers.resolveAllowedHost(host);
  const port = Number(creds.port ?? (creds.secure === false ? 587 : 465));
  return nodemailer.createTransport({
    // nodemailer takes the TLS server name from `host`, so it stays the name the user entered
    host,
    port,
    // every connection goes only to the checked addresses: nodemailer resolving the name again
    // could be sent elsewhere by a DNS rebind
    getSocket: (_options, callback) =>
      callback(null, {
        connection: net.connect({ host, port, lookup: allowed.lookup, autoSelectFamily: true }),
      }),
    secure: creds.secure !== false,
    ignoreTLS: creds.secure === false && Boolean(creds.disableStartTls),
    name: creds.hostName ? String(creds.hostName) : undefined,
    auth: creds.user ? { user: String(creds.user), pass: String(creds.password ?? '') } : undefined,
    tls: { rejectUnauthorized: !options.allowUnauthorizedCerts },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });
}
