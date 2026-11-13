/**
 * P6-61 (S5 L5): the syslog destination type: RFC 5424 lines over UDP, TCP or TLS. Every socket goes to an address
 * `ctx.http.resolveAllowedHost` returned (resolved and checked, every address): UDP resolves per send, TCP and TLS
 * once per connection, and both connect through the pinned `lookup` (inline, as the Git SSH transport and the LDAP
 * directory do; no shared helper exists). TLS checks the certificate against the host name the admin typed (a name
 * only, never an IP literal), with the destination's own CA and verification always on.
 *
 * Two n8n behaviours are not copied: n8n always sends facility Local0 (ours uses the destination's facility), and
 * n8n puts the server's host name in the line (ours sends the NILVALUE: no platform host name goes to a tenant).
 * Never in a line: credentials, headers, tenant ids, node input or output.
 */
import { X509Certificate } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import type { SyslogDestinationSettings } from '@workflow/workflow';
import type { StreamEvent } from '../../events/stream';
import type { DestinationFactory, DestinationSender, SenderDeps, StoredDestination } from '../types';

const DEFAULT_APP_NAME = 'workflow';
const DEFAULT_FACILITY = 16;
const CONNECT_TIMEOUT_MS = 5000;
/** a stream write that has not drained in this long means the peer stopped reading */
const WRITE_TIMEOUT_MS = 5000;
/** the test send waits this long for a late refusal or reset before it answers */
const TEST_WAIT_MS = 500;
const MAX_DATAGRAM_BYTES = 65_000;
const MAX_STREAM_LINE_BYTES = 1_000_000;
const MAX_APP_NAME = 48;
const MAX_MSGID = 32;
const MAX_CA_BYTES = 100_000;
const SEVERITY_ERROR = 3;
const SEVERITY_DEBUG = 7;
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

type Settings = SyslogDestinationSettings;

/** null when valid, else the 400 text */
export function validateSyslogSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'The syslog settings are required';
  }
  const s = settings as Record<string, unknown>;
  const host = typeof s.host === 'string' ? s.host.trim() : '';
  if (!host) return 'The syslog host is required';
  if (host.length > 253 || /[\s/@?#\\]/.test(host))
    return 'The syslog host must be a host name or an address';
  const port = s.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return 'The port must be between 1 and 65535';
  }
  if (s.protocol !== 'udp' && s.protocol !== 'tcp' && s.protocol !== 'tls') {
    return 'The protocol must be udp, tcp or tls';
  }
  const facility = s.facility ?? DEFAULT_FACILITY;
  if (typeof facility !== 'number' || !Number.isInteger(facility) || facility < 0 || facility > 23) {
    return 'The facility must be between 0 and 23';
  }
  const appName = s.app_name;
  if (appName !== undefined && appName !== '') {
    if (typeof appName !== 'string' || appName.length > MAX_APP_NAME || !/^[\x21-\x7e]+$/.test(appName)) {
      return `The app name must be 1 to ${MAX_APP_NAME} characters without spaces`;
    }
  }
  if (s.eol !== undefined && s.eol !== '\n' && s.eol !== '\r\n') return 'The line ending must be LF or CRLF';
  const ca = s.tlsCa;
  if (ca !== undefined && ca !== null && typeof ca !== 'string') return 'The CA certificate must be text';
  if (s.protocol === 'tls' && !(typeof ca === 'string' && ca.trim())) {
    return 'A CA certificate is required for TLS';
  }
  if (typeof ca === 'string' && ca.trim()) {
    if (ca.length > MAX_CA_BYTES) return 'The CA certificate is too large';
    const blocks = ca.match(PEM_CERT);
    if (!blocks) return 'The CA certificate must be a PEM certificate';
    try {
      for (const block of blocks) new X509Certificate(block);
    } catch {
      return 'The CA certificate must be a PEM certificate';
    }
  }
  return null;
}

/** RFC 5424 MSGID: printable ASCII without spaces, at most 32 characters; NILVALUE when nothing is left */
function msgIdOf(eventName: string): string {
  const cleaned = eventName.replace(/[^\x21-\x7e]/g, '').slice(0, MAX_MSGID);
  return cleaned || '-';
}

/**
 * `<pri>1 timestamp - app_name - msgid - json`: HOSTNAME, PROCID and STRUCTURED-DATA are NILVALUE. PRI is the
 * destination's facility times 8 plus the severity: Error when the event name ends with `error`, else Debug.
 */
export function formatSyslogLine(settings: Settings, event: StreamEvent, maxBytes: number): string {
  const facility = Number.isInteger(settings.facility) ? settings.facility : DEFAULT_FACILITY;
  const severity = event.eventName.toLowerCase().endsWith('error') ? SEVERITY_ERROR : SEVERITY_DEBUG;
  const parsed = Date.parse(event.ts);
  const timestamp = Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
  const appName = settings.app_name?.trim() || DEFAULT_APP_NAME;
  const head = `<${facility * 8 + severity}>1 ${timestamp} - ${appName} - ${msgIdOf(event.eventName)} - `;
  const body = (payload: unknown) =>
    JSON.stringify({
      id: event.id,
      ts: event.ts,
      eventName: event.eventName,
      message: event.message,
      payload,
    });
  let line = head + body(event.payload);
  if (Buffer.byteLength(line) > maxBytes) line = head + body({ truncated: true });
  return line;
}

interface Connection {
  socket: net.Socket;
  /** the first error of this socket, kept for the test send's wait */
  error?: Error;
  closed: boolean;
}

const bareHost = (host: string) => host.trim().replace(/^\[|\]$/g, '');

class SyslogSender implements DestinationSender {
  private connection: Promise<Connection> | undefined;
  private current: Connection | undefined;
  private closing = false;

  constructor(
    private readonly deps: SenderDeps,
    private readonly settings: Settings,
  ) {}

  async send(event: StreamEvent, options: { test?: boolean }): Promise<void> {
    if (this.closing) throw new Error('The syslog destination is closed');
    if (this.settings.protocol === 'udp') {
      await this.sendDatagram(formatSyslogLine(this.settings, event, MAX_DATAGRAM_BYTES));
    } else {
      const eol = this.settings.eol === '\r\n' ? '\r\n' : '\n';
      await this.sendStream(
        formatSyslogLine(this.settings, event, MAX_STREAM_LINE_BYTES) + eol,
        options.test,
      );
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const pending = this.connection;
    this.connection = undefined;
    const open = this.current;
    this.current = undefined;
    open?.socket.destroy();
    if (pending) await pending.then((c) => c.socket.destroy()).catch(() => undefined);
  }

  /** resolved and checked on every send; the datagram goes to the first checked address */
  private async sendDatagram(line: string): Promise<void> {
    const host = bareHost(this.settings.host);
    const allowed = await this.deps.http.resolveAllowedHost(host);
    const target = allowed.addresses[0];
    if (!target) throw new Error('The syslog host did not resolve');
    const socket = dgram.createSocket(target.family === 6 ? 'udp6' : 'udp4');
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.send(Buffer.from(line, 'utf8'), this.settings.port, target.address, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } finally {
      socket.close();
    }
  }

  private async sendStream(data: string, test: boolean | undefined): Promise<void> {
    const connection = await this.connect();
    await new Promise<void>((resolve, reject) => {
      // a peer that accepts the connection and stops reading never fires the write callback: give up, drop the
      // socket (the next send reconnects) and let the manager count the failure
      const timer = setTimeout(() => {
        // 'close' fires a tick later: mark it now so the next send reconnects instead of writing to a dead socket
        connection.closed = true;
        if (this.current === connection) this.current = undefined;
        connection.socket.destroy();
        reject(new Error('The syslog server did not take the event within 5 seconds'));
      }, WRITE_TIMEOUT_MS);
      connection.socket.write(data, 'utf8', (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
    if (!test) return;
    await new Promise((resolve) => setTimeout(resolve, TEST_WAIT_MS));
    if (connection.error) throw connection.error;
    if (connection.closed) throw new Error('The syslog server closed the connection');
  }

  private connect(): Promise<Connection> {
    const existing = this.current;
    if (existing && !existing.closed) return Promise.resolve(existing);
    this.connection ??= this.open().finally(() => {
      this.connection = undefined;
    });
    return this.connection;
  }

  private async open(): Promise<Connection> {
    const { port, protocol, tlsCa } = this.settings;
    const host = bareHost(this.settings.host);
    // throws SsrfBlockedError for a host the policy refuses, before any socket opens
    const allowed = await this.deps.http.resolveAllowedHost(host);
    const socket =
      protocol === 'tls'
        ? tls.connect({
            host,
            port,
            lookup: allowed.lookup,
            // the certificate is checked against the name the admin typed, never an address
            servername: net.isIP(host) ? undefined : host,
            ca: tlsCa,
            minVersion: 'TLSv1.2',
          })
        : net.connect({ host, port, lookup: allowed.lookup });
    const connection: Connection = { socket, closed: false };
    socket.setKeepAlive(true);
    socket.unref();
    return await new Promise<Connection>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error('The syslog server did not answer within 5 seconds')),
        CONNECT_TIMEOUT_MS,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.on('error', (error) => {
        connection.error ??= error;
        fail(error);
      });
      socket.on('close', () => {
        connection.closed = true;
        if (this.current === connection) this.current = undefined;
      });
      socket.once(protocol === 'tls' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        settled = true;
        this.current = connection;
        resolve(connection);
      });
    });
  }
}

export const createSyslogSender: DestinationFactory = (
  deps: SenderDeps,
  destination: StoredDestination,
): DestinationSender => new SyslogSender(deps, destination.settings as Settings);
