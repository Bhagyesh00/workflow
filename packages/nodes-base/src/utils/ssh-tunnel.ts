/**
 * SSH tunnel and TLS options for the Postgres and MySQL nodes (n8n's "SSH Tunnel" block and client
 * certificate fields). The SSH host goes through the SSRF guard (connectSocket); the database host is
 * resolved by the SSH server, so it is not checked here. The tunnel is a listener on 127.0.0.1 with a
 * random port that forwards each connection through the SSH connection (`direct-tcpip`) to the
 * database; the pool connects to that listener and closes the tunnel when it ends.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { BaseContext, DataObject } from '@workflow/workflow';
import ssh2 from 'ssh2';
import { formatPemBlock } from './pem';
import { connectSocket, remoteHost, remotePort, sshAuthConfig } from './remote-connect';

/** how long the TCP connect and the SSH handshake with sign-in may take */
const TUNNEL_READY_MS = 20_000;
/** keep an idle tunnel alive through firewalls */
const KEEPALIVE_MS = 15_000;

type TunnelContext = Pick<BaseContext, 'helpers'> & { signal?: AbortSignal };

export interface SshTunnel {
  /** always the loopback address of the local listener */
  host: string;
  port: number;
  close: () => Promise<void>;
}

/** true when the credential has the SSH Tunnel switch on */
export function sshTunnelEnabled(creds: DataObject): boolean {
  return creds.sshTunnel === true || creds.sshTunnel === 'true';
}

/**
 * Open the tunnel for `target` (the database host and port as the SSH server sees them). Rejects with
 * a fixed text when the SSH host cannot be reached or refuses the sign-in; the text never holds the
 * password, key or passphrase.
 */
export async function openSshTunnel(
  ctx: TunnelContext,
  creds: DataObject,
  target: { host: string; port: number },
): Promise<SshTunnel> {
  const sshHost = remoteHost(creds.sshHost, 'SSH tunnel');
  const sshPort = remotePort(creds.sshPort, 22);
  const usePrivateKey = creds.sshAuthenticateWith === 'privateKey';
  if (usePrivateKey && !String(creds.privateKey ?? '').trim())
    throw new Error("Couldn't open the SSH tunnel: the credential has no private key");
  const auth = sshAuthConfig(
    {
      username: creds.sshUser ?? '',
      password: creds.sshPassword ?? '',
      privateKey: creds.privateKey ?? '',
      passphrase: creds.passphrase ?? '',
    },
    usePrivateKey,
  );

  const sock = await connectSocket(ctx, sshHost, sshPort, TUNNEL_READY_MS);
  const client = new ssh2.Client();
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', reject);
      client.connect({
        sock,
        readyTimeout: TUNNEL_READY_MS,
        keepaliveInterval: KEEPALIVE_MS,
        ...auth,
      });
    });
  } catch (error) {
    client.end();
    sock.destroy();
    throw new Error(`Couldn't open the SSH tunnel to ${sshHost}:${sshPort}: ${(error as Error).message}`);
  }
  // errors after sign-in surface through the connection that hit them
  client.on('error', () => undefined);

  const open = new Set<net.Socket>();
  const listener = net.createServer((local) => {
    open.add(local);
    local.once('close', () => open.delete(local));
    local.on('error', () => undefined);
    local.pause();
    client.forwardOut('127.0.0.1', local.remotePort ?? 0, target.host, target.port, (error, channel) => {
      if (error) {
        local.destroy();
        return;
      }
      channel.on('error', () => local.destroy());
      local.once('close', () => channel.destroy());
      channel.once('close', () => local.destroy());
      local.pipe(channel).pipe(local);
      local.resume();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (error) {
    client.end();
    sock.destroy();
    throw new Error(`Couldn't open the SSH tunnel: ${(error as Error).message}`);
  }
  listener.on('error', () => undefined);

  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= new Promise<void>((resolve) => {
      for (const local of open) local.destroy();
      client.end();
      sock.destroy();
      listener.close(() => resolve());
    });
    return closed;
  };
  // the SSH connection dropping ends the tunnel: new connections would only hang
  client.once('close', () => void close());
  ctx.signal?.addEventListener('abort', () => void close(), { once: true });
  const { port } = listener.address() as net.AddressInfo;
  return { host: '127.0.0.1', port, close };
}

export interface SqlTlsCredentials extends DataObject {
  ssl?: string;
  caCertificate?: string;
  clientPrivateKey?: string;
  clientCertificate?: string;
}

/**
 * TLS options for the SQL drivers. `disable` gives none. `allow` encrypts without checking the server
 * (our name for n8n's "ignore SSL issues"); `require` checks the server against the CA when one is
 * set, else the system roots. The client certificate and key (PEM, re-wrapped so a value pasted on one
 * line works) are sent in both encrypting modes. `serverName` is the host the user entered: through
 * a tunnel the socket goes to 127.0.0.1, so the TLS server name and the name check use it instead.
 */
export function sqlTlsOptions(
  creds: SqlTlsCredentials,
  serverName: string,
): tls.ConnectionOptions | undefined {
  if (creds.ssl !== 'allow' && creds.ssl !== 'require') return undefined;
  const key = String(creds.clientPrivateKey ?? '').trim();
  const cert = String(creds.clientCertificate ?? '').trim();
  const options: tls.ConnectionOptions = {
    rejectUnauthorized: creds.ssl === 'require',
    ...(key && cert ? { key: formatPemBlock(key), cert: formatPemBlock(cert) } : {}),
  };
  if (creds.ssl === 'require') {
    if (creds.caCertificate) options.ca = formatPemBlock(String(creds.caCertificate));
    if (!net.isIP(serverName)) options.servername = serverName;
    options.checkServerIdentity = (_host, certificate) => tls.checkServerIdentity(serverName, certificate);
  }
  return options;
}
