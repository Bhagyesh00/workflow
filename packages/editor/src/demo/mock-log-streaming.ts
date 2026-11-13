/**
 * P6-64 (L8): the demo's log streaming routes, the REST paths of the server's routes/log-streaming.ts as the
 * editor's `logStreamingApi` calls them (api/endpoints.ts). GET `/eventbus/destination` lists
 * (`eventBusDestination:list`) or, with `?id=`, answers one destination (`:read`); POST saves (`:create`, or
 * `:update` when the body has the id of a saved destination); DELETE (`:delete`) and POST `/eventbus/testmessage`
 * (`:test`) take `?id=`. A saved secret never comes back: the values of headers and query parameters, the query
 * values of the webhook URL and the key of a Sentry DSN are blank on read, and a blank on save keeps the saved
 * value while the scheme, host and port of the URL or DSN are unchanged. Nothing is sent anywhere: a test event
 * is delivered unless the host of the URL, DSN or syslog host ends in `.invalid`, which fails with a reachability
 * text. State is per workspace and lives in the registering backend.
 */
import { DEFAULT_CIRCUIT_BREAKER, EVENT_CATALOG, type LogDestinationType } from '@workflow/workflow';
import type { LogDestination } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { copy, HttpError } from './mock-http';

const TYPES: readonly LogDestinationType[] = ['webhook', 'syslog', 'sentry'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH'];
const PROTOCOLS = ['udp', 'tcp', 'tls'];

type Stored = LogDestination;

const bad = (message: string) => new HttpError(400, 'invalid_body', message);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseUrl(text: unknown, what: string, protocols: string[]): URL {
  let url: URL;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    throw bad(`${what} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) throw bad(`${what} must start with ${protocols.join(' or ')}`);
  if (!url.hostname) throw bad(`${what} needs a host`);
  return url;
}

const sameOrigin = (a: URL, b: URL): boolean =>
  a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;

/** the URL with every query value blank (the server's answer) */
function maskUrl(text: string): string {
  const url = new URL(text);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '');
  url.password = '';
  return url.toString();
}

/** the DSN without its key (the user part) */
function maskDsn(text: string): string {
  const url = new URL(text);
  url.username = '';
  url.password = '';
  return url.toString();
}

function hostOf(settings: Record<string, unknown>): string {
  for (const key of ['url', 'dsn']) {
    const value = settings[key];
    if (typeof value === 'string' && value) {
      try {
        return new URL(value).hostname;
      } catch {
        return '';
      }
    }
  }
  return typeof settings.host === 'string' ? settings.host : '';
}

/** the saved rows with a blank value take the saved value of the row with the same name */
function keepRowSecrets(
  incoming: unknown,
  saved: unknown,
  keep: boolean,
  label: string,
): Array<{ name: string; value: string }> {
  if (incoming === undefined) return [];
  if (!Array.isArray(incoming)) throw bad(`${label} must be a list`);
  const old = new Map<string, string>();
  if (keep && Array.isArray(saved))
    for (const row of saved as Array<{ name: string; value: string }>) old.set(row.name, row.value);
  return incoming.map((row) => {
    if (!isRecord(row) || typeof row.name !== 'string' || !row.name.trim())
      throw bad(`Every ${label} needs a name`);
    const value = typeof row.value === 'string' ? row.value : '';
    return { name: row.name.trim(), value: value === '' ? (old.get(row.name.trim()) ?? '') : value };
  });
}

function checkSettings(
  type: LogDestinationType,
  raw: unknown,
  saved: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!isRecord(raw)) throw bad('settings must be an object');
  const s = copy(raw);
  if (type === 'webhook') {
    const url = parseUrl(s.url, 'The URL', ['http:', 'https:']);
    const savedUrl = typeof saved?.url === 'string' ? new URL(saved.url) : null;
    const keep = Boolean(savedUrl && sameOrigin(url, savedUrl));
    // a blank query value of the URL keeps the saved one
    if (savedUrl && keep)
      for (const [key, value] of [...url.searchParams.entries()])
        if (value === '' && savedUrl.searchParams.has(key))
          url.searchParams.set(key, savedUrl.searchParams.get(key) ?? '');
    // a blank password of the URL keeps the saved one
    if (savedUrl && keep && !url.password && savedUrl.password) url.password = savedUrl.password;
    if (!METHODS.includes(String(s.method))) throw bad('The method must be GET, POST, PUT or PATCH');
    s.url = url.toString();
    s.queryParameters = keepRowSecrets(s.queryParameters, saved?.queryParameters, keep, 'query parameter');
    s.headerParameters = keepRowSecrets(s.headerParameters, saved?.headerParameters, keep, 'header');
    const code = Number(s.expectedStatusCode ?? 200);
    if (!Number.isInteger(code) || code < 100 || code > 599)
      throw bad('The expected status code must be between 100 and 599');
    s.expectedStatusCode = code;
    return s;
  }
  if (type === 'syslog') {
    if (typeof s.host !== 'string' || !s.host.trim()) throw bad('The syslog host is required');
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw bad('The port must be between 1 and 65535');
    if (!PROTOCOLS.includes(String(s.protocol))) throw bad('The protocol must be udp, tcp or tls');
    const facility = Number(s.facility);
    if (!Number.isInteger(facility) || facility < 0 || facility > 23)
      throw bad('The facility must be between 0 and 23');
    if (s.protocol === 'tls' && !(typeof s.tlsCa === 'string' && s.tlsCa.trim()))
      throw bad('A CA certificate is required for TLS');
    s.host = s.host.trim();
    s.port = port;
    s.facility = facility;
    return s;
  }
  const dsn = parseUrl(s.dsn, 'The DSN', ['http:', 'https:']);
  const savedDsn = typeof saved?.dsn === 'string' ? new URL(saved.dsn) : null;
  if (!dsn.username && savedDsn?.username && sameOrigin(dsn, savedDsn)) dsn.username = savedDsn.username;
  s.dsn = dsn.toString();
  return s;
}

/** the destination as the API answers it: every secret blank */
function present(dest: Stored): Stored {
  const out = copy(dest);
  const settings = out.settings as unknown as Record<string, unknown>;
  if (out.type === 'webhook') {
    settings.url = maskUrl(String(settings.url));
    for (const key of ['queryParameters', 'headerParameters'])
      settings[key] = (settings[key] as Array<{ name: string; value: string }>).map((row) => ({
        name: row.name,
        value: '',
      }));
  } else if (out.type === 'sentry') {
    settings.dsn = maskDsn(String(settings.dsn));
  }
  return out;
}

export function registerLogStreamingRoutes(backend: MockBackend): void {
  const byTenant = new Map<string, Stored[]>();
  const listOf = (tenantId: string): Stored[] => {
    let list = byTenant.get(tenantId);
    if (!list) {
      list = [];
      byTenant.set(tenantId, list);
    }
    return list;
  };
  const idOf = (query: Record<string, string>): string => {
    const id = query.id;
    if (!id) throw bad('The destination id is required');
    return id;
  };
  const find = (tenantId: string, id: string): Stored => {
    const found = listOf(tenantId).find((d) => d.id === id);
    if (!found) throw new HttpError(404, 'not_found', 'Log destination not found');
    return found;
  };

  backend.on('GET', '/eventbus/eventnames', () => {
    backend.requireScope('eventBusDestination:list');
    return EVENT_CATALOG.map((entry) => entry.name);
  });

  backend.on('GET', '/eventbus/destination', ({ query }) => {
    const { tenant } = backend.auth();
    if (query.id) {
      backend.requireScope('eventBusDestination:read');
      return present(find(tenant.id, query.id));
    }
    backend.requireScope('eventBusDestination:list');
    return listOf(tenant.id).map(present);
  });

  backend.on('POST', '/eventbus/destination', ({ body }) => {
    const { tenant } = backend.auth();
    const type = body.type as LogDestinationType;
    if (!TYPES.includes(type)) throw bad('The type must be webhook, syslog or sentry');
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) throw bad('The label is required');
    const list = listOf(tenant.id);
    const existing = typeof body.id === 'string' ? list.find((d) => d.id === body.id) : undefined;
    backend.requireScope(existing ? 'eventBusDestination:update' : 'eventBusDestination:create');
    if (existing && existing.type !== type) throw bad('The type of a destination cannot change');
    const events = body.subscribedEvents;
    if (events !== undefined && (!Array.isArray(events) || events.some((e) => typeof e !== 'string')))
      throw bad('subscribedEvents must be a list of event names');
    const breaker = isRecord(body.circuitBreaker) ? body.circuitBreaker : DEFAULT_CIRCUIT_BREAKER;
    const maxFailures = Number(breaker.maxFailures);
    const failureWindowMs = Number(breaker.failureWindowMs);
    if (!Number.isInteger(maxFailures) || maxFailures < 1) throw bad('Max failures must be 1 or more');
    if (!Number.isFinite(failureWindowMs) || failureWindowMs < 1000)
      throw bad('The failure window must be 1 second or more');
    const settings = checkSettings(
      type,
      body.settings,
      existing ? (existing.settings as unknown as Record<string, unknown>) : undefined,
    );
    const next = {
      id: existing?.id ?? (typeof body.id === 'string' && body.id ? body.id : newId()),
      type,
      label,
      enabled: body.enabled === true,
      subscribedEvents: (events as string[] | undefined) ?? [],
      anonymizeAuditMessages: body.anonymizeAuditMessages === true,
      credentialId: type === 'webhook' && typeof body.credentialId === 'string' ? body.credentialId : null,
      circuitBreaker: { maxFailures, failureWindowMs },
      settings,
      lastError: existing?.lastError ?? null,
      droppedEvents: existing?.droppedEvents ?? 0,
    } as unknown as Stored;
    if (existing) list[list.indexOf(existing)] = next;
    else list.push(next);
    return present(next);
  });

  backend.on('DELETE', '/eventbus/destination', ({ query }) => {
    const { tenant } = backend.requireScope('eventBusDestination:delete');
    const found = find(tenant.id, idOf(query));
    byTenant.set(
      tenant.id,
      listOf(tenant.id).filter((d) => d !== found),
    );
    return { deleted: true };
  });

  backend.on('POST', '/eventbus/testmessage', ({ query }) => {
    const { tenant } = backend.requireScope('eventBusDestination:test');
    const found = find(tenant.id, idOf(query));
    const host = hostOf(found.settings as unknown as Record<string, unknown>);
    if (host.endsWith('.invalid')) {
      found.lastError = `Could not reach ${host}`;
      return { success: false, error: found.lastError };
    }
    found.lastError = null;
    return { success: true };
  });
}
