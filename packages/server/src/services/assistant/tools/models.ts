/**
 * Assistant tools: the public model catalog (P5-69, lane L6). `search_models` (viewer) lists recent chat
 * models of one provider from models.dev, as n8n's model catalog does: text in and text out, not
 * deprecated, newest release first, then by id; at most 10.
 *
 * The catalog is read through the guarded `ctx.http` (`allowedDomains: ['models.dev']`, 5 s, body capped at
 * 20 MB) and kept in memory for every workspace (public data): fresh for an hour; when a refresh fails, a
 * snapshot up to 24 hours old is answered as `stale`; older ones are never answered
 * (`catalog_unavailable`). One refresh runs at a time; a caller that stops waiting does not stop it.
 * Everything in the catalog is outside text (`untrusted: 'models-dev'`) and says nothing about what a
 * credential can reach (`credentialAccess: 'not_checked'`).
 */
import type { HttpClient } from '@workflow/core';
import { z } from 'zod';
import type { AssistantToolDefinition } from '../types';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODEL_CATALOG_LIMITS = {
  freshMs: 60 * 60 * 1000,
  maxStaleMs: 24 * 60 * 60 * 1000,
  timeoutMs: 5000,
  maxBytes: 20 * 1024 * 1024,
} as const;

const GUIDANCE =
  'A first list from a public catalog, not checked against any credential. When a credential for the provider exists, list its models with get_node_parameter_options instead. A model missing here may still exist, and a price here does not mean free access. Do not swap a working or requested model because of this list.';

export type SearchModelsStatus = 'ok' | 'unknown_provider' | 'no_matching_models' | 'catalog_unavailable';

export interface CatalogModelResult {
  id: string;
  name: string;
  releaseDate: string | null;
  status: string | null;
  toolCalling: boolean | null;
  reasoning: boolean | null;
  modalities: { input: string[] | null; output: string[] | null };
  limits: { context: number | null; output: number | null };
  pricing: {
    currency: 'USD';
    unit: 'per_million_tokens';
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  } | null;
}

export interface SearchModelsResult {
  status: SearchModelsStatus;
  provider: string;
  models: CatalogModelResult[];
  hasMore: boolean;
  source: string;
  fetchedAt: string | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
  credentialAccess: 'not_checked';
  guidance: string;
}

/** one model as the catalog lists it (only the fields read here) */
interface RawModel {
  id: string;
  name: string;
  release_date?: unknown;
  status?: unknown;
  tool_call?: unknown;
  reasoning?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
}

type Catalog = Map<string, RawModel[]>;

const TEXT_CHARS = 200;
const str = (value: unknown): string | null =>
  typeof value === 'string' && value ? value.slice(0, TEXT_CHARS) : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const strings = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 50))
    : null;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** a valid `YYYY-MM-DD` date, else null */
function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? null : value;
}

/** the catalog's providers with their models; entries of the wrong shape are left out */
export function parseCatalog(data: unknown): Catalog {
  const catalog: Catalog = new Map();
  if (!isObject(data)) return catalog;
  for (const [key, provider] of Object.entries(data)) {
    if (!isObject(provider) || !isObject(provider.models)) continue;
    const models: RawModel[] = [];
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (!isObject(model)) continue;
      const id = typeof model.id === 'string' && model.id ? model.id : modelKey;
      const name = typeof model.name === 'string' && model.name ? model.name : id;
      models.push({ ...(model as Partial<RawModel>), id, name });
    }
    catalog.set(key.toLowerCase(), models);
  }
  return catalog;
}

function toResult(model: RawModel): CatalogModelResult {
  const cost = isObject(model.cost) ? model.cost : undefined;
  const modalities = isObject(model.modalities) ? model.modalities : undefined;
  const limit = isObject(model.limit) ? model.limit : undefined;
  return {
    id: model.id.slice(0, TEXT_CHARS),
    name: model.name.slice(0, TEXT_CHARS),
    releaseDate: isoDate(model.release_date),
    status: str(model.status),
    toolCalling: bool(model.tool_call),
    reasoning: bool(model.reasoning),
    modalities: { input: strings(modalities?.input), output: strings(modalities?.output) },
    limits: { context: num(limit?.context), output: num(limit?.output) },
    pricing: cost
      ? {
          currency: 'USD',
          unit: 'per_million_tokens',
          input: num(cost.input),
          output: num(cost.output),
          cacheRead: num(cost.cache_read),
          cacheWrite: num(cost.cache_write),
        }
      : null,
  };
}

function compareModels(a: CatalogModelResult, b: CatalogModelResult): number {
  if (a.releaseDate !== b.releaseDate) {
    if (a.releaseDate === null) return 1;
    if (b.releaseDate === null) return -1;
    return a.releaseDate > b.releaseDate ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** the response body as text, refused past `maxBytes` (a stream, a buffer or, from a fake, a value) */
async function readBody(body: unknown, maxBytes: number): Promise<unknown> {
  if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
    const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) throw new Error('The model catalog is too large');
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      await iterator.return?.(undefined)?.catch(() => undefined);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  if (typeof body === 'string' || body instanceof Uint8Array) {
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    if (size > maxBytes) throw new Error('The model catalog is too large');
    return JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
  }
  return body;
}

/** waits for `promise`, or rejects when `signal` aborts (the promise itself goes on) */
async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('The run was stopped'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export interface SearchModelsInput {
  provider: string;
  query?: string;
  limit?: number;
}

/** the shared models.dev catalog; `now` is the clock (tests pass a fake one) */
export class ModelCatalog {
  private snapshot?: { catalog: Catalog; fetchedAt: number };
  private refreshing?: Promise<void>;

  constructor(private readonly now: () => number = Date.now) {}

  /** forgets the snapshot (a test starts from an empty cache) */
  clear(): void {
    this.snapshot = undefined;
  }

  async search(
    http: HttpClient,
    input: SearchModelsInput,
    signal?: AbortSignal,
  ): Promise<SearchModelsResult> {
    signal?.throwIfAborted();
    const provider = input.provider.trim().toLowerCase();
    const query = input.query?.trim().toLowerCase() ?? '';
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 10);
    const base = {
      provider,
      models: [] as CatalogModelResult[],
      hasMore: false,
      source: MODELS_DEV_URL,
      credentialAccess: 'not_checked' as const,
      guidance: GUIDANCE,
    };

    if (!this.snapshot || this.now() - this.snapshot.fetchedAt >= MODEL_CATALOG_LIMITS.freshMs) {
      // shared by every caller: one caller stopping must not stop the refresh
      this.refreshing ??= this.refresh(http).finally(() => {
        this.refreshing = undefined;
      });
      await untilAborted(this.refreshing, signal);
    }

    const snapshot = this.snapshot;
    const age = snapshot ? this.now() - snapshot.fetchedAt : Number.POSITIVE_INFINITY;
    if (!snapshot || age >= MODEL_CATALOG_LIMITS.maxStaleMs) {
      return { ...base, status: 'catalog_unavailable', fetchedAt: null, freshness: 'unavailable' };
    }
    const meta = {
      ...base,
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
      freshness: age < MODEL_CATALOG_LIMITS.freshMs ? ('fresh' as const) : ('stale' as const),
    };
    const listed = snapshot.catalog.get(provider);
    if (!listed) return { ...meta, status: 'unknown_provider' };

    const models = listed
      .filter((model) => {
        const modalities = isObject(model.modalities) ? model.modalities : undefined;
        const takes = strings(modalities?.input) ?? [];
        const gives = strings(modalities?.output) ?? [];
        return model.status !== 'deprecated' && takes.includes('text') && gives.includes('text');
      })
      .filter(
        (model) =>
          !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
      )
      .map(toResult)
      .sort(compareModels);
    return {
      ...meta,
      status: models.length > 0 ? 'ok' : 'no_matching_models',
      models: models.slice(0, limit),
      hasMore: models.length > limit,
    };
  }

  private async refresh(http: HttpClient): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_CATALOG_LIMITS.timeoutMs);
    timer.unref?.();
    try {
      const response = (await http.request(
        {
          url: MODELS_DEV_URL,
          method: 'GET',
          headers: { accept: 'application/json' },
          responseType: 'stream',
          timeout: MODEL_CATALOG_LIMITS.timeoutMs,
          allowedDomains: ['models.dev'],
        },
        controller.signal,
      )) as unknown;
      const data = await untilAborted(readBody(response, MODEL_CATALOG_LIMITS.maxBytes), controller.signal);
      const catalog = parseCatalog(data);
      // an empty catalog means the source changed shape: keep the last good one
      if (catalog.size > 0) this.snapshot = { catalog, fetchedAt: this.now() };
    } catch {
      // keep the last good snapshot; `search` says whether it may still be answered
    } finally {
      clearTimeout(timer);
    }
  }
}

/** the one catalog of this process */
export const assistantModelCatalog = new ModelCatalog();

const searchModelsInput = z.object({
  provider: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('Catalog provider id, e.g. "openai", "anthropic", "google", "openrouter", "mistral"'),
  query: z.string().trim().max(100).optional().describe('Part of a model id or name, e.g. "claude"'),
  limit: z.number().int().min(1).max(10).optional().describe('How many models, 1 to 10 (default 10)'),
});

const searchModelsTool: AssistantToolDefinition<z.infer<typeof searchModelsInput>> = {
  name: 'search_models',
  description:
    'Look up recent chat models of one provider in the public models.dev catalog when no credential of that provider exists to list them. Not a check of what a credential can use.',
  input: searchModelsInput,
  minRole: 'viewer',
  untrusted: 'models-dev',
  async handler(ctx, run, input) {
    return assistantModelCatalog.search(ctx.http, input, run.signal);
  },
};

export const modelsTools: AssistantToolDefinition[] = [searchModelsTool];
