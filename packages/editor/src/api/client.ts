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
export const fetchTransport: Transport = async ({ method, path, query, body, signal }) => {
  const mutating = method !== 'GET';
  const response = await fetch(buildUrl(path, query), {
    method,
    credentials: 'same-origin',
    headers: mutating
      ? { 'content-type': 'application/json', accept: 'application/json' }
      : { accept: 'application/json' },
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

let transport: Transport = fetchTransport;
const unauthorizedListeners = new Set<UnauthorizedListener>();

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
): Promise<{ data: unknown; nextCursor?: string | null }> {
  let response: ApiResponse;
  try {
    response = await transport(request);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'network_error',
      'Could not reach the server. Check your connection and try again.',
    );
  }
  if (response.status === 401 && !request.path.startsWith('/auth/')) {
    for (const listener of unauthorizedListeners) listener();
  }
  if (response.status < 200 || response.status >= 300) throw toError(response.status, response.body);
  const body = (response.body ?? {}) as { data?: unknown; nextCursor?: string | null };
  return { data: body.data, nextCursor: body.nextCursor };
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
