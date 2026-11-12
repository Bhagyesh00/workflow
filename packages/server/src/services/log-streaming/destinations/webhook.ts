/**
 * P6-60 (S5 L4): the webhook destination type: one HTTP request per event (n8n's webhook destination), always through
 * `deps.http` (the SSRF guard checks the first URL and every redirect hop at connect). The body is the event message as
 * JSON; the method, query and header pairs, credential auth, the TLS switch, redirects and the timeout come from the
 * destination's settings.
 *
 * Differences from n8n, on purpose:
 * - no proxy and no socket pool options (a tenant-chosen proxy would be an SSRF path);
 * - redirects are off by default; n8n's limit of 21 applies only where the credential's domain list is checked, while a
 *   plain follow stops at undici's own 20;
 * - a credential, a header value, a query value and a `user:password@` part are never sent over plain `http://`;
 * - `allowUnauthorizedCerts` is the only switch that skips certificate verification.
 *
 * A failure is an error whose text holds no header value, query value, credential or answer body.
 */
import { applyAuthentication, type CredentialsProvider, createCredentialHelpers } from '@workflow/core';
import {
  assertCredentialUrlAllowed,
  type DataObject,
  getCredentialAllowedDomains,
  type HttpFullResponse,
  type HttpRequestOptions,
  redactSecrets,
  type WebhookDestinationSettings,
} from '@workflow/workflow';
import { DESTINATION_CREDENTIAL_TYPES } from '../credential-check';
import { destinationMessage } from '../payload';
import type { DestinationFactory, DestinationSender, SenderDeps } from '../types';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH']);
const ARRAY_FORMATS = new Set(['brackets', 'indices', 'repeat']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_PAIRS = 50;
const MAX_PAIR_TEXT = 8192;
const MAX_URL = 2048;
const MAX_REDIRECTS = 21;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5000;
const ERROR_MAX = 1000;

const PLAIN_HTTP_SECRET =
  "Couldn't use plain http:// for a webhook that sends a header value, a query value, a password or a credential. Use an https:// URL.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Pair = { name: string; value: string };

/** the settings with every default applied; what the sender and the validator both read */
interface Normalized {
  url: URL;
  method: WebhookDestinationSettings['method'];
  query: Pair[];
  headers: Pair[];
  sendPayload: boolean;
  mustMatch: boolean;
  expectedStatusCode: number;
  allowUnauthorizedCerts: boolean;
  arrayFormat: WebhookDestinationSettings['options']['queryParameterArrays'];
  followRedirects: boolean;
  maxRedirects: number;
  timeout: number;
}

type Parsed = { ok: true; value: Normalized } | { ok: false; text: string };

function readPairs(
  raw: unknown,
  switchedOn: boolean,
  label: string,
  nameCheck: (name: string) => boolean,
): Pair[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    return `Couldn't read the ${label} parameters: send a list of name and value pairs.`;
  if (raw.length > MAX_PAIRS) return `Couldn't use more than ${MAX_PAIRS} ${label} parameters.`;
  const pairs: Pair[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      return `Couldn't read the ${label} parameters: each needs a name and a value.`;
    }
    const value = entry.value === undefined || entry.value === null ? '' : entry.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return `Couldn't read the ${label} parameters: each value must be text.`;
    }
    const text = String(value);
    if (!entry.name || entry.name.length > MAX_PAIR_TEXT || !nameCheck(entry.name)) {
      return `Couldn't use the ${label} parameter name: it is empty or holds characters a ${label} name cannot have.`;
    }
    if (text.length > MAX_PAIR_TEXT)
      return `Couldn't use a ${label} parameter value over ${MAX_PAIR_TEXT} characters.`;
    pairs.push({ name: entry.name, value: text });
  }
  return switchedOn ? pairs : [];
}

function integerIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function normalize(settings: unknown): Parsed {
  if (!isRecord(settings)) return { ok: false, text: "Couldn't read the webhook settings." };
  const fail = (text: string): Parsed => ({ ok: false, text });

  if (typeof settings.url !== 'string' || !settings.url.trim() || settings.url.length > MAX_URL) {
    return fail("Couldn't use the webhook URL: enter an http:// or https:// URL.");
  }
  let url: URL;
  try {
    url = new URL(settings.url.trim());
  } catch {
    return fail("Couldn't use the webhook URL: enter an http:// or https:// URL.");
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return fail("Couldn't use the webhook URL: enter an http:// or https:// URL.");
  }

  const method = settings.method === undefined ? 'POST' : String(settings.method).toUpperCase();
  if (!METHODS.has(method)) return fail("Couldn't use this method: choose GET, POST, PUT or PATCH.");

  const query = readPairs(
    settings.queryParameters,
    settings.sendQuery === true,
    'query',
    (name) => name.length > 0,
  );
  if (typeof query === 'string') return fail(query);
  const headers = readPairs(settings.headerParameters, settings.sendHeaders === true, 'header', (name) =>
    HEADER_NAME.test(name),
  );
  if (typeof headers === 'string') return fail(headers);

  let expectedStatusCode = 200;
  if (settings.expectedStatusCode !== undefined) {
    const code = integerIn(settings.expectedStatusCode, 100, 599);
    if (code === null) return fail("Couldn't use the expected status code: enter a number from 100 to 599.");
    expectedStatusCode = code;
  }

  const options = settings.options === undefined ? {} : settings.options;
  if (!isRecord(options)) return fail("Couldn't read the webhook options.");
  let arrayFormat: Normalized['arrayFormat'] = 'brackets';
  if (options.queryParameterArrays !== undefined) {
    if (
      typeof options.queryParameterArrays !== 'string' ||
      !ARRAY_FORMATS.has(options.queryParameterArrays)
    ) {
      return fail("Couldn't use this array format: choose brackets, indices or repeat.");
    }
    arrayFormat = options.queryParameterArrays as Normalized['arrayFormat'];
  }
  let timeout = DEFAULT_TIMEOUT_MS;
  if (options.timeout !== undefined) {
    const value = integerIn(options.timeout, 1, MAX_TIMEOUT_MS);
    if (value === null)
      return fail(`Couldn't use this timeout: enter milliseconds from 1 to ${MAX_TIMEOUT_MS}.`);
    timeout = value;
  }
  let followRedirects = false;
  let maxRedirects = MAX_REDIRECTS;
  if (options.redirect !== undefined) {
    if (!isRecord(options.redirect)) return fail("Couldn't read the redirect settings.");
    if (options.redirect.followRedirects !== undefined)
      followRedirects = options.redirect.followRedirects === true;
    if (options.redirect.maxRedirects !== undefined) {
      const value = integerIn(options.redirect.maxRedirects, 0, MAX_REDIRECTS);
      if (value === null)
        return fail(`Couldn't use this redirect limit: enter a number from 0 to ${MAX_REDIRECTS}.`);
      maxRedirects = value;
    }
  }

  return {
    ok: true,
    value: {
      url,
      method: method as Normalized['method'],
      query,
      headers,
      sendPayload: settings.sendPayload !== false,
      mustMatch: settings.responseCodeMustMatch === true,
      expectedStatusCode,
      allowUnauthorizedCerts: options.allowUnauthorizedCerts === true,
      arrayFormat,
      followRedirects,
      maxRedirects,
      timeout,
    },
  };
}

/** whether the request carries a value that must not travel over plain http:// (credential excluded) */
function carriesSecret(value: Normalized): boolean {
  if (value.url.username || value.url.password) return true;
  for (const [, v] of value.url.searchParams) if (v) return true;
  return [...value.query, ...value.headers].some((pair) => pair.value !== '');
}

/** null when the settings are valid, else the 400 text (a secret over plain http:// is refused, its value never named) */
export function validateWebhookSettings(settings: unknown): string | null {
  const parsed = normalize(settings);
  if (!parsed.ok) return parsed.text;
  if (parsed.value.url.protocol === 'http:' && carriesSecret(parsed.value)) return PLAIN_HTTP_SECRET;
  return null;
}

/** the `qs` of the request: a repeated name becomes an array in the destination's format */
function queryOf(pairs: Pair[], format: Normalized['arrayFormat']): Record<string, unknown> {
  const grouped = new Map<string, string[]>();
  for (const { name, value } of pairs) grouped.set(name, [...(grouped.get(name) ?? []), value]);
  const qs: Record<string, unknown> = {};
  for (const [name, values] of grouped) {
    if (values.length === 1) qs[name] = values[0];
    else if (format === 'repeat') qs[name] = values;
    else if (format === 'brackets') qs[`${name}[]`] = values;
    else {
      for (const [index, value] of values.entries()) qs[`${name}[${index}]`] = value;
    }
  }
  return qs;
}

function headersOf(pairs: Pair[]): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const { name, value } of pairs) {
    const key = name.toLowerCase();
    const before = headers[key];
    headers[key] = before === undefined ? value : [...(Array.isArray(before) ? before : [before]), value];
  }
  return headers;
}

const cut = (text: string) => redactSecrets(text).slice(0, ERROR_MAX);

/** an error text from the client: the reason only (a connect code when fetch hides it), never a URL query */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return 'the request failed';
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.message} (${code})` : error.message;
}

const MISMATCH = /^Credential ".*" is of type /;

/**
 * The destination's credential, decrypted now: found by id in the destination's workspace (another workspace's
 * id is not found), one of the generic HTTP auth types. The destination has no project, so the type policy is
 * judged for the workspace.
 */
async function loadCredential(
  deps: SenderDeps,
  tenantId: string,
  credentialId: string,
  known: { type?: string },
): Promise<{ type: string; data: DataObject }> {
  const provider: CredentialsProvider = deps.credentials.provider(tenantId, tenantId, {
    allow: [credentialId],
  });
  const candidates = known.type ? [known.type] : [...DESTINATION_CREDENTIAL_TYPES];
  for (const type of candidates) {
    try {
      const data = await provider.get({ id: credentialId, name: '' }, type);
      known.type = type;
      return { type, data };
    } catch (error) {
      if (error instanceof Error && MISMATCH.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error('the credential is not a generic HTTP authentication credential');
}

export const createWebhookSender: DestinationFactory = (deps, destination): DestinationSender => {
  const known: { type?: string } = {};
  return {
    async send(event) {
      if (destination.type !== 'webhook')
        throw new Error("Couldn't send: this destination is not a webhook.");
      const parsed = normalize(destination.settings);
      if (!parsed.ok) throw new Error(parsed.text);
      const config = parsed.value;
      const { credentialId } = destination;
      if (config.url.protocol === 'http:' && (credentialId || carriesSecret(config))) {
        throw new Error(PLAIN_HTTP_SECRET);
      }

      let request: HttpRequestOptions = {
        url: config.url.toString(),
        method: config.method,
        headers: headersOf(config.headers),
        qs: queryOf(config.query, config.arrayFormat),
        ...(config.sendPayload && config.method !== 'GET'
          ? {
              body: destinationMessage(event, {
                anonymizeAuditMessages: destination.anonymizeAuditMessages,
              }),
              bodyType: 'json' as const,
            }
          : {}),
        responseType: 'text',
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        timeout: config.timeout,
        followRedirects: config.followRedirects,
        maxRedirects: config.maxRedirects,
        // the one switch that skips certificate verification
        ...(config.allowUnauthorizedCerts ? { skipSslCertificateValidation: true } : {}),
      };

      if (credentialId) {
        try {
          const { type, data } = await loadCredential(deps, destination.tenantId, credentialId, known);
          // the URL was typed by the workspace's admin: the credential's `none` mode applies, and a domain list
          // holds for the first URL and every redirect hop
          const allowedDomains = getCredentialAllowedDomains(data, { userUrl: true });
          assertCredentialUrlAllowed(request.url, allowedDomains);
          if (allowedDomains) request = { ...request, allowedDomains, credentialScope: 'userUrl' };
          request = await applyAuthentication(
            deps.credentials.resolvedType(type),
            data,
            request,
            createCredentialHelpers(deps.http, allowedDomains),
          );
        } catch (error) {
          throw new Error(cut(`Couldn't use the credential of this destination: ${reasonOf(error)}`));
        }
      }

      let response: HttpFullResponse<unknown>;
      try {
        response = (await deps.http.request(request)) as HttpFullResponse<unknown>;
      } catch (error) {
        throw new Error(cut(`Couldn't reach the webhook: ${reasonOf(error)}`));
      }

      const status = response.statusCode;
      if (config.mustMatch) {
        if (status !== config.expectedStatusCode) {
          throw new Error(`The webhook answered with HTTP ${status}, expected ${config.expectedStatusCode}.`);
        }
        return;
      }
      if (status >= 300 && status < 400 && !config.followRedirects) {
        throw new Error(`The webhook answered with a redirect (HTTP ${status}) and redirects are off.`);
      }
      if (status < 200 || status >= 300) throw new Error(`The webhook answered with HTTP ${status}.`);
    },
  };
};
