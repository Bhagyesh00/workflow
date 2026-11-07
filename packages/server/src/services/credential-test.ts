/**
 * `POST /credentials/test`: run the credential type's test request with the given data, through
 * the SSRF-guarded HttpClient and `applyAuthentication` (or the OAuth2 token).
 */
import {
  applyAuthentication,
  createCredentialHelpers,
  type HttpClient,
  HttpError,
  type NodeTypes,
  type OAuth2Data,
  oauth2Request,
} from '@workflow/core';
import {
  assertCredentialUrlAllowed,
  type CredentialTestContext,
  type DataObject,
  evaluateSimple,
  getCredentialAllowedDomains,
  type HttpFullResponse,
  type HttpRequestOptions,
  isExpression,
  type Logger,
  type NodeCredentialTestResult,
} from '@workflow/workflow';
import type { CredentialService } from './credentials';

export interface CredentialTestResult {
  status: 'OK' | 'Error';
  message: string;
}

/** what a node's `methods.credentialTest` hook needs */
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

/** a node's own test runs for at most this long, then its signal aborts */
const NODE_TEST_TIMEOUT_MS = 30_000;

type NodeCredentialTest = (
  ctx: CredentialTestContext,
  credential: { type: string; data: DataObject },
) => Promise<NodeCredentialTestResult>;

/**
 * The `methods.credentialTest` function of the node type whose credential entry names `type` (or a
 * type it extends) with `testedBy`, with the credential entry that matched.
 */
function findNodeTest(
  credentials: CredentialService,
  type: string,
  nodeTypes: NodeTypes,
): NodeCredentialTest | undefined {
  let inherited: NodeCredentialTest | undefined;
  for (const node of nodeTypes.list()) {
    for (const entry of node.description.credentials ?? []) {
      if (!entry.testedBy) continue;
      const fn = node.methods?.credentialTest?.[entry.testedBy];
      if (!fn) continue;
      if (entry.name === type) return fn;
      if (!inherited && credentials.types.isA(type, entry.name)) inherited = fn;
    }
  }
  return inherited;
}

async function runNodeTest(
  test: NonNullable<ReturnType<typeof findNodeTest>>,
  http: HttpClient,
  type: string,
  data: DataObject,
  opts: CredentialTestOptions,
): Promise<CredentialTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NODE_TEST_TIMEOUT_MS);
  const ctx: CredentialTestContext = {
    helpers: {
      resolveAllowedHost: (host) => http.resolveAllowedHost(host),
      assertHostAllowed: (host) => http.assertHostAllowed(host),
    },
    logger: opts.logger,
    signal: controller.signal,
    getTenantId: () => opts.tenantId,
  };
  try {
    const result = await Promise.race([
      test(ctx, { type, data }),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }),
      ),
    ]);
    const message = typeof result?.message === 'string' ? result.message : '';
    return result?.status === 'OK'
      ? { status: 'OK', message: message || 'Connection tested successfully' }
      : { status: 'Error', message: message || "Couldn't test the credential" };
  } catch {
    // the node's own functions answer with their own texts; anything thrown is not shown
    return {
      status: 'Error',
      message: controller.signal.aborted ? 'The connection test timed out' : "Couldn't test the credential",
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function testCredential(
  credentials: CredentialService,
  http: HttpClient,
  type: string,
  data: DataObject,
  opts?: CredentialTestOptions,
): Promise<CredentialTestResult> {
  const resolvedType = credentials.resolvedType(type);
  const full = credentials.withDefaults(type, data);
  // a client-credentials type with its own `authenticate` gets its token there, as node-context.ts does
  const ownTokenFlow =
    typeof resolvedType.authenticate === 'function' && full.grantType === 'clientCredentials';
  const isOAuth2 = credentials.types.isA(type, 'oAuth2Api') && !ownTokenFlow;
  const isOAuth1 = credentials.types.isA(type, 'oAuth1Api');
  // a node that names a test function for this credential type runs it instead of a request
  const nodeTest = opts ? findNodeTest(credentials, type, opts.nodeTypes) : undefined;
  if (nodeTest && opts) return runNodeTest(nodeTest, http, type, full, opts);
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
        await applyAuthentication(resolvedType, full, base, createCredentialHelpers(http, allowedDomains)),
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
