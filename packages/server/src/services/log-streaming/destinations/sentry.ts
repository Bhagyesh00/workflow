/**
 * P6-62 (S5 L6): the sentry destination type: one Sentry envelope per event, POSTed to the DSN's
 * `<prefix>/api/<project>/envelope/` through `deps.http` (the SSRF guard, TLS checked against the platform's trust
 * store, no SDK). A redirect is never followed: the send fails. `tracesSampleRate` is accepted and unused (as n8n:
 * only messages are captured). Never in an envelope, error or log: the DSN key beyond the auth header, node data.
 */
import { randomBytes } from 'node:crypto';
import type { SentryDestinationSettings } from '@workflow/workflow';
import { redactSecrets } from '@workflow/workflow';
import type { StreamEvent } from '../../events/stream';
import type { DestinationFactory, DestinationSender, SenderDeps, StoredDestination } from '../types';

const APP_TAG = 'workflow';
const CLIENT = 'workflow-log-streaming';
const SEND_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 1000;
const MAX_DSN_CHARS = 2048;

interface ParsedDsn {
  key: string;
  /** scheme and authority, no trailing slash */
  origin: string;
  /** the path before the project id, '' or '/a/b' */
  prefix: string;
  project: string;
}

function parseDsn(dsn: unknown): ParsedDsn | string {
  if (typeof dsn !== 'string' || !dsn.trim()) return 'The Sentry DSN is required';
  if (dsn.length > MAX_DSN_CHARS) return 'The Sentry DSN is too long';
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return 'The Sentry DSN must be a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'The Sentry DSN must start with https:// or http://';
  if (!url.username) return 'The Sentry DSN needs a public key before the @';
  let key: string;
  try {
    key = decodeURIComponent(url.username);
  } catch {
    return 'The Sentry DSN key is not valid';
  }
  if (!url.hostname) return 'The Sentry DSN needs a host';
  if (url.search || url.hash) return 'The Sentry DSN must not have a query or fragment';
  const segments = url.pathname.split('/').filter(Boolean);
  const project = segments.pop();
  if (!project || !/^\d+$/.test(project)) return 'The Sentry DSN must end with a numeric project id';
  if (segments.some((s) => !/^[A-Za-z0-9._~-]+$/.test(s))) return 'The Sentry DSN path is not valid';
  return {
    key,
    origin: `${url.protocol}//${url.host}`,
    prefix: segments.length ? `/${segments.join('/')}` : '',
    project,
  };
}

/** null when the settings are valid, else the 400 text */
export function validateSentrySettings(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'The Sentry settings are required';
  }
  const s = settings as Record<string, unknown>;
  const parsed = parseDsn(s.dsn);
  if (typeof parsed === 'string') return parsed;
  if (typeof s.sendPayload !== 'boolean') return 'Send payload must be true or false';
  const rate = s.tracesSampleRate;
  if (rate !== undefined && rate !== null && (typeof rate !== 'number' || !(rate >= 0 && rate <= 1))) {
    return 'The traces sample rate must be between 0 and 1';
  }
  return null;
}

const cut = (text: string) => redactSecrets(text).slice(0, MAX_ERROR_CHARS);

class SentrySender implements DestinationSender {
  constructor(
    private readonly deps: SenderDeps,
    private readonly destination: StoredDestination,
  ) {}

  async send(event: StreamEvent): Promise<void> {
    const settings = this.destination.settings as SentryDestinationSettings;
    const parsed = parseDsn(settings.dsn);
    if (typeof parsed === 'string') throw new Error(parsed);
    const release = this.deps.config.version;
    const environment = this.deps.config.environment;
    const eventId = randomBytes(16).toString('hex');
    const timestamp = Date.parse(event.ts);
    const body = {
      event_id: eventId,
      timestamp: (Number.isNaN(timestamp) ? Date.now() : timestamp) / 1000,
      platform: 'node',
      level: event.eventName.toLowerCase().endsWith('error') ? 'error' : 'log',
      message: event.message || event.eventName,
      logger: this.destination.label,
      release,
      environment,
      tags: { event: event.eventName, logger: this.destination.label, app: APP_TAG },
      extra: settings.sendPayload ? event.payload : undefined,
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(body),
    ].join('\n');
    try {
      const response = (await this.deps.http.request(
        {
          method: 'POST',
          url: `${parsed.origin}${parsed.prefix}/api/${parsed.project}/envelope/`,
          headers: {
            'content-type': 'application/x-sentry-envelope',
            'x-sentry-auth': `Sentry sentry_version=7, sentry_client=${CLIENT}/${release}, sentry_key=${parsed.key}`,
          },
          body: envelope,
          bodyType: 'raw',
          followRedirects: false,
          returnFullResponse: true,
          timeout: SEND_TIMEOUT_MS,
        },
        undefined,
      )) as { statusCode: number };
      if (response.statusCode >= 300) {
        throw new Error(
          response.statusCode < 400
            ? `Sentry answered with a redirect (${response.statusCode}), which is not followed`
            : `Sentry answered with status ${response.statusCode}`,
        );
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The Sentry send failed';
      throw new Error(cut(text.split(parsed.key).join('')));
    }
  }
}

export const createSentrySender: DestinationFactory = (
  deps: SenderDeps,
  destination: StoredDestination,
): DestinationSender => new SentrySender(deps, destination);
