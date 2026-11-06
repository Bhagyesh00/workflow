/**
 * `POST /credentials/test`: run the credential type's test request with the given data, through
 * the SSRF-guarded HttpClient and `applyAuthentication` (or the OAuth2 token).
 */
import {
  applyAuthentication,
  type HttpClient,
  HttpError,
  type NodeTypes,
  type OAuth2Data,
  oauth2Request,
} from '@workflow/core';
import {
  assertCredentialUrlAllowed,
  type DataObject,
  evaluateSimple,
  getCredentialAllowedDomains,
  type HttpFullResponse,
  type HttpRequestOptions,
  isExpression,
  type Logger,
} from '@workflow/workflow';
import type { CredentialService } from './credentials';

export interface CredentialTestResult {
  status: 'OK' | 'Error';
  message: string;
}

/** what a node's `methods.credentialTest` hook needs (unused until L22) */
export interface CredentialTestOptions {
  nodeTypes: NodeTypes;
  tenantId: string;
  logger: Logger;
}

function resolveTemplates<T>(value: T, credentials: DataObject): T {
  if (isExpression(value))
    return evaluateSimple(value, { $credentials: credentials }, { timeoutMs: 500 }) as T;
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, credentials)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        resolveTemplates(k, credentials),
        resolveTemplates(v, credentials),
      ]),
    ) as T;
  }
  return value;
}

export async function testCredential(
  credentials: CredentialService,
  http: HttpClient,
  type: string,
  data: DataObject,
  _opts?: CredentialTestOptions,
): Promise<CredentialTestResult> {
  const resolvedType = credentials.resolvedType(type);
  const full = credentials.withDefaults(type, data);
  const isOAuth2 = credentials.types.isA(type, 'oAuth2Api');
  const isOAuth1 = credentials.types.isA(type, 'oAuth1Api');
  if (!resolvedType.test) {
    if (isOAuth1) {
      const connected = Boolean((full.oauthTokenData as DataObject | undefined)?.oauth_token);
      return connected
        ? { status: 'OK', message: 'The account is connected' }
        : { status: 'Error', message: 'The account is not connected yet' };
    }
    if (isOAuth2) {
      const connected = Boolean((full.oauthTokenData as DataObject | undefined)?.access_token);
      return connected
        ? { status: 'OK', message: 'The account is connected' }
        : { status: 'Error', message: 'The account is not connected yet' };
    }
    return { status: 'OK', message: 'This credential type has no connection test' };
  }
  try {
    const request = resolveTemplates(resolvedType.test.request, full) as HttpRequestOptions;
    const base: HttpRequestOptions = {
      ...request,
      timeout: Math.min(request.timeout ?? 15_000, 30_000),
      ignoreHttpStatusErrors: true,
      returnFullResponse: true,
    };
    // the credential's allowed domains hold for its own test request too: the first URL here, and
    // every redirect hop in the client (`none` does not apply: the test URL is not a user-typed URL)
    const allowedDomains = getCredentialAllowedDomains(full, { userUrl: false });
    assertCredentialUrlAllowed(base.url, allowedDomains);
    if (allowedDomains) base.allowedDomains = allowedDomains;
    let response: HttpFullResponse;
    if (isOAuth2) {
      response = (await oauth2Request(http, full as OAuth2Data, base, async () => {})) as HttpFullResponse;
    } else {
      response = (await http.request(
        await applyAuthentication(resolvedType, full, base),
      )) as HttpFullResponse;
    }
    for (const rule of resolvedType.test.rules ?? []) {
      if (rule.type === 'responseCode' && response.statusCode === rule.value) {
        return { status: 'Error', message: rule.message };
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { status: 'Error', message: `The service answered with HTTP ${response.statusCode}` };
    }
    return { status: 'OK', message: 'Connection tested successfully' };
  } catch (error) {
    if (error instanceof HttpError) {
      return { status: 'Error', message: `The service answered with HTTP ${error.statusCode}` };
    }
    return { status: 'Error', message: (error as Error).message };
  }
}
