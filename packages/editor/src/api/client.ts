/**
 * Thin JSON client for `/rest`. Unwraps `{ data }` envelopes and turns `{ error }` envelopes into
 * `ApiError`. The transport is swappable so the demo build can answer requests in-process.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiRequest {
  method: HttpMethod;
  /** path below `/rest`, e.g. `/workflows/123` */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** the workspace this tab shows; the server rejects the request when the session moved on */
  tenantId?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type Transport = (request: ApiRequest) => Promise<ApiResponse>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): URL {
  const url = new URL(`/rest${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

/** Browser transport. Mutating requests always carry a JSON body (CSRF rule: JSON content type). */
export const fetchTransport: Transport = async ({ method, path, query, body, signal, tenantId }) => {
  const mutating = method !== 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (mutating) headers['content-type'] = 'application/json';
  if (tenantId) headers['x-tenant-id'] = tenantId;
  const response = await fetch(buildUrl(path, query), {
    method,
    credentials: 'same-origin',
    headers,
    body: mutating ? JSON.stringify(body ?? {}) : undefined,
    signal,
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { code: 'invalid_response', message: `Unexpected response (${response.status})` } };
    }
  }
  return { status: response.status, body: parsed };
};

type UnauthorizedListener = () => void;
type TenantChangedListener = () => void;
type MfaEnrollmentListener = () => void;

let transport: Transport = fetchTransport;
const unauthorizedListeners = new Set<UnauthorizedListener>();
const tenantChangedListeners = new Set<TenantChangedListener>();
const mfaEnrollmentListeners = new Set<MfaEnrollmentListener>();
let currentTenantId: string | null = null;

export function setTransport(next: Transport): void {
  transport = next;
}

export function getTransport(): Transport {
  return transport;
}

/** Called whenever a request answers 401 (expired session), e.g. to send the user to sign-in. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/**
 * P6-18: called instead of the unauthorized listeners when a 401 says `mfa_enrollment_required`: the
 * workspace enforces two-step sign-in and this user has not set it up. The session stays valid.
 */
export function onMfaEnrollmentRequired(listener: MfaEnrollmentListener): () => void {
  mfaEnrollmentListeners.add(listener);
  return () => mfaEnrollmentListeners.delete(listener);
}

/** the error code of an answer body (`{ error: { code } }`), if any */
function errorCodeOf(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

/**
 * The workspace this tab shows (from `/auth/me` or a switch). Every request outside `/auth/*` names
 * it, so a switch made in another tab cannot redirect this tab's writes into the new workspace.
 */
export function setCurrentTenant(tenantId: string | null): void {
  currentTenantId = tenantId;
}

export function getCurrentTenant(): string | null {
  return currentTenantId;
}

/** Called when the server answers 409 `tenant_changed`: the session now uses another workspace. */
export function onTenantChanged(listener: TenantChangedListener): () => void {
  tenantChangedListeners.add(listener);
  return () => tenantChangedListeners.delete(listener);
}

/**
 * For connections that cannot read the 409 themselves (the push stream): asks `/auth/me` which
 * workspace the session uses and tells the tenant-changed listeners when it is not this tab's.
 */
export async function confirmTenant(): Promise<void> {
  const expected = currentTenantId;
  if (!expected) return;
  const { data } = await requestRaw({ method: 'GET', path: '/auth/me' });
  const actual = (data as { tenant?: { id?: string } } | undefined)?.tenant?.id;
  if (actual && actual !== expected && currentTenantId === expected) {
    for (const listener of tenantChangedListeners) listener();
  }
}

function toError(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  return new ApiError(
    status,
    error?.code ?? `http_${status}`,
    error?.message ?? `Request failed with status ${status}`,
    error?.details,
  );
}

export async function requestRaw(
  request: ApiRequest,
): Promise<{ data: unknown; nextCursor?: string | null; envelope?: Record<string, unknown> }> {
  let response: ApiResponse;
  const tenantId = request.path.startsWith('/auth/') ? undefined : (currentTenantId ?? undefined);
  try {
    response = await transport(tenantId ? { ...request, tenantId } : request);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'network_error',
      'Could not reach the server. Check your connection and try again.',
    );
  }
  if (response.status === 401 && !request.path.startsWith('/auth/')) {
    // P6-18: an enforced user without MFA keeps the session and goes to the setup, not to sign-in
    const listeners =
      errorCodeOf(response.body) === 'mfa_enrollment_required'
        ? mfaEnrollmentListeners
        : unauthorizedListeners;
    for (const listener of listeners) listener();
  }
  const failure =
    response.status < 200 || response.status >= 300 ? toError(response.status, response.body) : null;
  if (failure?.status === 409 && failure.code === 'tenant_changed') {
    for (const listener of tenantChangedListeners) listener();
  }
  if (failure) throw failure;
  const body = (response.body ?? {}) as { data?: unknown; nextCursor?: string | null };
  // `envelope`: the whole answer, for the few that carry fields beside `data` (P6-20 members' counts)
  return { data: body.data, nextCursor: body.nextCursor, envelope: body as Record<string, unknown> };
}

export async function request<T>(request: ApiRequest): Promise<T> {
  const { data } = await requestRaw(request);
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<T>({ method: 'GET', path, query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>({ method: 'POST', path, body }),
  patch: <T>(path: string, body?: unknown) => request<T>({ method: 'PATCH', path, body }),
  put: <T>(path: string, body?: unknown) => request<T>({ method: 'PUT', path, body }),
  delete: <T>(path: string) => request<T>({ method: 'DELETE', path }),
  async list<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) {
    const { data, nextCursor } = await requestRaw({ method: 'GET', path, query, signal });
    return { data: (data ?? []) as T[], nextCursor: nextCursor ?? null };
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
