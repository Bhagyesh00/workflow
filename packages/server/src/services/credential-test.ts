/**
 * `POST /credentials/test`: run the credential type's test request with the given data, through
 * the SSRF-guarded HttpClient and `applyAuthentication` (or the OAuth2 token).
 */
import {
  applyAuthentication,
  type HttpClient,
  HttpError,
  type OAuth2Data,
  oauth2Request,
} from '@workflow/core';
import {
  type DataObject,
  evaluateSimple,
  type HttpFullResponse,
  type HttpRequestOptions,
  isExpression,
} from '@workflow/workflow';
import type { CredentialService } from './credentials';

export interface CredentialTestResult {
  status: 'OK' | 'Error';
  message: string;
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
): Promise<CredentialTestResult> {
  const resolvedType = credentials.resolvedType(type);
  const full = credentials.withDefaults(type, data);
  const isOAuth2 = credentials.types.isA(type, 'oAuth2Api');
  if (!resolvedType.test) {
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
