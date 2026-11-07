/** The client credentials token request and the token answer every grant shares. */
import type { AccessToken, ClientCredentialsInput, HttpRequestOptions } from '@workflow/workflow';

const DEFAULT_SECONDS = 3600;

/**
 * The client goes in the form unless `authentication` is `header`: Azure takes it in the form. No redirect
 * is followed: a 307 would carry the secret to the next host.
 */
export function clientCredentialsRequest(input: ClientCredentialsInput): HttpRequestOptions {
  const inHeader = input.authentication === 'header';
  return {
    url: input.tokenUrl,
    method: 'POST',
    bodyType: 'form-urlencoded',
    headers: { accept: 'application/json' },
    followRedirects: false,
    ...(inHeader ? { auth: { username: input.clientId, password: input.clientSecret } } : {}),
    body: {
      grant_type: 'client_credentials',
      ...(inHeader ? {} : { client_id: input.clientId, client_secret: input.clientSecret }),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
    },
  };
}

function readJson(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function readSeconds(value: unknown): number {
  const seconds =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_SECONDS;
}

/** the error names nothing from the answer: a token host may echo what it was sent */
export function parseAccessToken(body: unknown): AccessToken {
  const answer = readJson(body);
  const fields = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const token = fields.access_token;
  if (typeof token !== 'string' || !token) throw new Error('The token answer holds no access token');
  return { token, expiresInSeconds: readSeconds(fields.expires_in) };
}
