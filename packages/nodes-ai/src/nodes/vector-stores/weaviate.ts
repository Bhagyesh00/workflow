/**
 * Weaviate Vector Store. Plain REST and GraphQL, no vendor SDK and no gRPC: the gRPC channel of
 * Weaviate's client opens its own sockets, which the SSRF guard cannot cover, so n8n's gRPC host, port
 * and proxy fields are not built. Every call goes through the credential helper.
 * - insert: `POST /v1/batch/objects` (per-object `result.errors` checked); the collection is created on
 *   first insert (`vectorizer: none`, multi-tenancy on when a tenant is set) and the tenant too;
 * - search: GraphQL `Get` with `nearVector`, or `hybrid` when a hybrid option is set (weaviate-graphql.ts
 *   builds it from validated parts); the score is Weaviate's distance on a vector search (lower is
 *   closer) and the fused score on a hybrid search (higher is better), as in n8n;
 * - Clear Data deletes the collection, or only the tenant when one is set.
 */
import type {
  AiDocument,
  BaseContext,
  DataObject,
  HttpFullResponse,
  HttpRequestOptions,
  ListSearchResult,
  LoadOptionsContext,
  NodeProperty,
} from '@workflow/workflow';
import { isResourceLocatorValue, NodeOperationError } from '@workflow/workflow';
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  clearStoreOption,
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type ScoredDocument,
  type VectorBackend,
} from './vector-store-factory';
import {
  type AdditionalField,
  buildGetQuery,
  type FusionType,
  type HybridSearch,
  isFusionType,
  parseWhereFilter,
  WEAVIATE_CLASS_NAME,
  WEAVIATE_PROPERTY_NAME,
  WEAVIATE_QUERY_PROPERTY,
  WeaviateQueryError,
  type WeaviateWhere,
} from './weaviate-graphql';

/** Weaviate tenant names */
const TENANT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** property names Weaviate reserves; metadata under these names is stored as `meta_<name>` */
const RESERVED_PROPERTIES = new Set(['id', '_id', '_additional']);
/** objects per batch request */
const BATCH_SIZE = 100;
/** flattened metadata nesting we follow; deeper values are stored as JSON text */
const MAX_METADATA_DEPTH = 5;
const MAX_TIMEOUT_SECONDS = 3600;

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

/** A metadata key as a property name part: other characters become `_`. */
function sanitizeKey(key: string): string {
  return key.replace(/[^_0-9A-Za-z]/g, '_') || '_';
}

/** A top-level property name: valid start, and Weaviate's reserved names moved to `meta_<name>`. */
function propertyName(key: string): string {
  let name = sanitizeKey(key);
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return RESERVED_PROPERTIES.has(name) ? `meta_${name}` : name;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function flattenInto(target: DataObject, value: unknown, name: string, depth: number): void {
  if (value === null || value === undefined) return;
  if (isPrimitive(value)) {
    target[name] = value;
    return;
  }
  if (Array.isArray(value)) {
    const first = typeof value[0];
    const sameKind = value.length > 0 && value.every((v) => isPrimitive(v) && typeof v === first);
    target[name] = sameKind ? (value as Array<string | number | boolean>) : JSON.stringify(value);
    return;
  }
  if (typeof value === 'object' && depth < MAX_METADATA_DEPTH) {
    for (const [key, inner] of Object.entries(value as DataObject)) {
      flattenInto(target, inner, `${name}_${sanitizeKey(key)}`, depth + 1);
    }
    return;
  }
  target[name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Object properties of a document: the text under `textKey`, the metadata flattened into valid
 * property names (nested keys joined with `_`, other characters become `_`). The text wins over a
 * metadata key of the same name.
 */
export function weaviateProperties(document: AiDocument, textKey: string): DataObject {
  const metadata: DataObject = {};
  for (const [key, value] of Object.entries(document.metadata ?? {})) {
    flattenInto(metadata, value, propertyName(key), 0);
  }
  delete metadata[textKey];
  return { [textKey]: document.pageContent, ...metadata };
}

// ---------------------------------------------------------------------------------------------
// Connection and options
// ---------------------------------------------------------------------------------------------

/** REST base URL from the credential: Weaviate Cloud is https only (a bare host gets https). */
export function weaviateBaseUrl(credentials: DataObject): string {
  const raw = String(credentials.url ?? '').trim();
  if (!raw) throw new Error('Enter the Weaviate URL in the credential');
  const cloud = credentials.connection_type !== 'custom_connection';
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme || !cloud ? raw : `https://${raw}`);
  } catch {
    throw new Error('The Weaviate URL in the credential is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The Weaviate URL must start with http:// or https://');
  }
  if (cloud && url.protocol !== 'https:') throw new Error('A Weaviate Cloud URL must use https');
  if (url.username || url.password) {
    throw new Error('Put the API key in its credential field, not in the Weaviate URL');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function locatorText(raw: unknown): string {
  return String((isResourceLocatorValue(raw) ? raw.value : raw) ?? '').trim();
}

function seconds(value: unknown, fallback: number): number {
  const n = Number(value);
  const s =
    value !== undefined && value !== null && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.round(Math.min(s, MAX_TIMEOUT_SECONDS) * 1000);
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

interface HybridOptions {
  query: string;
  explain: boolean;
  alpha?: number;
  properties?: string[];
  fusionType?: FusionType;
  maxVectorDistance?: number;
  autocut?: number;
}

interface WeaviateOptions {
  className: string;
  tenant?: string;
  textKey: string;
  metadataKeys: string[];
  skipInitChecks: boolean;
  initTimeout: number;
  insertTimeout: number;
  queryTimeout: number;
  /** set when any hybrid option is set */
  hybrid?: HybridOptions;
}

/** Reads and validates the node's options; throws plain errors with the user-facing text. */
function readOptions(className: string, options: DataObject): WeaviateOptions {
  if (!WEAVIATE_CLASS_NAME.test(className)) {
    throw new Error(
      'Enter a Weaviate collection name that starts with an upper-case letter and holds only letters, digits and "_"',
    );
  }
  const tenant = isSet(options.tenant) ? String(options.tenant).trim() : undefined;
  if (tenant !== undefined && tenant !== '' && !TENANT_NAME.test(tenant)) {
    throw new Error('A tenant name holds 1 to 64 letters, digits, "_" or "-"');
  }
  const textKey = isSet(options.textKey) ? String(options.textKey).trim() : 'text';
  if (!WEAVIATE_PROPERTY_NAME.test(textKey)) {
    throw new Error(
      'The text key must be a property name: letters, digits and "_", not starting with a digit',
    );
  }
  const metadataKeys = [
    ...new Set(
      String(options.metadataKeys ?? 'source,page')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
  for (const key of metadataKeys) {
    if (!WEAVIATE_PROPERTY_NAME.test(key) || RESERVED_PROPERTIES.has(key)) {
      throw new Error(`Invalid metadata key: ${key.slice(0, 100)}`);
    }
  }

  const hybridSet =
    isSet(options.hybridQuery) ||
    options.hybridExplainScore === true ||
    isSet(options.fusionType) ||
    isSet(options.alpha) ||
    isSet(options.queryProperties) ||
    (isSet(options.autoCutLimit) && Number(options.autoCutLimit) !== 0) ||
    (isSet(options.maxVectorDistance) && Number(options.maxVectorDistance) !== 0);
  let hybrid: HybridOptions | undefined;
  if (hybridSet) {
    hybrid = {
      query: isSet(options.hybridQuery) ? String(options.hybridQuery) : '',
      explain: options.hybridExplainScore === true,
    };
    if (isSet(options.fusionType)) {
      if (!isFusionType(options.fusionType)) {
        throw new Error(`Unsupported fusion type: ${String(options.fusionType).slice(0, 100)}`);
      }
      hybrid.fusionType = options.fusionType;
    }
    if (isSet(options.alpha)) {
      const alpha = Number(options.alpha);
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
        throw new Error('Alpha must be a number from 0 to 1');
      hybrid.alpha = alpha;
    }
    if (isSet(options.queryProperties)) {
      const properties = String(options.queryProperties)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      for (const p of properties) {
        if (!WEAVIATE_QUERY_PROPERTY.test(p)) throw new Error(`Invalid query property: ${p.slice(0, 100)}`);
      }
      if (properties.length) hybrid.properties = properties;
    }
    if (isSet(options.maxVectorDistance) && Number(options.maxVectorDistance) !== 0) {
      const distance = Number(options.maxVectorDistance);
      if (!Number.isFinite(distance) || distance < 0) {
        throw new Error('Max Vector Distance must be a number of 0 or more');
      }
      hybrid.maxVectorDistance = distance;
    }
    if (isSet(options.autoCutLimit) && Number(options.autoCutLimit) !== 0) {
      const autocut = Number(options.autoCutLimit);
      if (!Number.isInteger(autocut) || autocut < 1)
        throw new Error('Auto Cut Limit must be a whole number of 1 or more');
      hybrid.autocut = autocut;
    }
  }
  return {
    className,
    tenant: tenant || undefined,
    textKey,
    metadataKeys,
    skipInitChecks: options.skip_init_checks === true,
    initTimeout: seconds(options.timeout_init, 2),
    insertTimeout: seconds(options.timeout_insert, 90),
    queryTimeout: seconds(options.timeout_query, 30),
    hybrid,
  };
}

/** Weaviate's error text from a response body: `{ error: [{ message }] }`, `{ message }` or GraphQL `errors`. */
function weaviateMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; errors?: unknown; message?: unknown };
    const list = Array.isArray(b.error) ? b.error : Array.isArray(b.errors) ? b.errors : undefined;
    if (list?.length) {
      return list
        .slice(0, 3)
        .map((e) => String((e as { message?: unknown })?.message ?? JSON.stringify(e)))
        .join('; ');
    }
    if (typeof b.message === 'string') return b.message;
    if (typeof b.error === 'string') return b.error;
  }
  return typeof body === 'string' ? body : JSON.stringify(body ?? '');
}

function clip(text: string): string {
  return redactSecrets(text).slice(0, 500);
}

// ---------------------------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------------------------

/** Lists the collections of the Weaviate instance, filtered by the typed text. */
async function weaviateCollectionsSearch(
  ctx: LoadOptionsContext,
  filter?: string,
): Promise<ListSearchResult> {
  const credentials = await ctx.getCredentials('weaviateApi', 0);
  const response = (await ctx.helpers.httpRequestWithAuthentication(
    'weaviateApi',
    { url: `${weaviateBaseUrl(credentials)}/v1/schema` },
    0,
  )) as { classes?: Array<{ class?: unknown }> };
  const needle = (filter ?? '').trim().toLowerCase();
  const names = (response.classes ?? [])
    .map((c) => String(c.class ?? ''))
    .filter((name) => name && (!needle || name.toLowerCase().includes(needle)))
    .sort((a, b) => a.localeCompare(b));
  return { results: names.map((name) => ({ name, value: name })) };
}

const sharedOptions: NodeProperty[] = [
  {
    displayName: 'Tenant Name',
    name: 'tenant',
    type: 'string',
    default: '',
    description:
      'Tenant of a multi-tenant collection. On insert a new collection is created with multi-tenancy on, and a missing tenant is added.',
  },
  {
    displayName: 'Text Key',
    name: 'textKey',
    type: 'string',
    default: 'text',
    description: 'Property that holds the document text',
  },
  {
    displayName: 'Skip Init Checks',
    name: 'skip_init_checks',
    type: 'boolean',
    default: false,
    description: 'Whether to skip the readiness check before the first request',
  },
  {
    displayName: 'Init Timeout',
    name: 'timeout_init',
    type: 'number',
    default: 2,
    typeOptions: { minValue: 1 },
    description: 'Seconds to wait for the readiness check',
  },
  {
    displayName: 'Insert Timeout',
    name: 'timeout_insert',
    type: 'number',
    default: 90,
    typeOptions: { minValue: 1 },
    description: 'Seconds to wait for each insert or schema request',
  },
  {
    displayName: 'Query Timeout',
    name: 'timeout_query',
    type: 'number',
    default: 30,
    typeOptions: { minValue: 1 },
    description: 'Seconds to wait for each query',
  },
];

const retrieveOptions: NodeProperty[] = [
  {
    displayName: 'Metadata Keys',
    name: 'metadataKeys',
    type: 'string',
    default: 'source,page',
    description:
      'Comma-separated properties returned as metadata with the text. Keys the collection does not have are left out.',
  },
  {
    displayName: 'Hybrid: Query Text',
    name: 'hybridQuery',
    type: 'string',
    default: '',
    description:
      "Text for a keyword search combined with the vector search. When empty and another hybrid option is set, the search text is used. Without hybrid options the search is by vector only and the score is Weaviate's distance (lower is closer); a hybrid search returns the fused score (higher is better).",
  },
  {
    displayName: 'Hybrid: Explain Score',
    name: 'hybridExplainScore',
    type: 'boolean',
    default: false,
    description: 'Whether to add how the hybrid score was fused to the metadata, as explainScore',
  },
  {
    displayName: 'Hybrid: Fusion Type',
    name: 'fusionType',
    type: 'options',
    default: 'RelativeScore',
    options: [
      { name: 'Relative Score', value: 'RelativeScore' },
      { name: 'Ranked', value: 'Ranked' },
    ],
    description: 'How the keyword and vector results are combined',
  },
  {
    displayName: 'Hybrid: Auto Cut Limit',
    name: 'autoCutLimit',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0 },
    description: 'Cut the results after this many jumps in score; 0 turns it off',
  },
  {
    displayName: 'Hybrid: Alpha',
    name: 'alpha',
    type: 'number',
    default: 0.5,
    typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
    description: 'Weight of the vector search against the keyword search: 1 is pure vector, 0 pure keyword',
  },
  {
    displayName: 'Hybrid: Query Properties',
    name: 'queryProperties',
    type: 'string',
    default: '',
    placeholder: 'question^2,answer',
    description: 'Comma-separated properties the keyword search reads, each with an optional weight',
  },
  {
    displayName: 'Hybrid: Max Vector Distance',
    name: 'maxVectorDistance',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0 },
    description: 'Largest distance the vector part of a hybrid search accepts; 0 turns it off',
  },
  ...sharedOptions,
];

export const VectorStoreWeaviateNode = createVectorStoreNode({
  name: 'ai.vectorStoreWeaviate',
  displayName: 'Weaviate Vector Store',
  description: 'Stores documents in a Weaviate collection and searches them by similarity',
  icon: 'simple:weaviate',
  credentials: [{ name: 'weaviateApi', required: true }],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'json',
  properties: [
    {
      displayName: 'Weaviate Collection',
      name: 'weaviateCollection',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'Created on the first insert when missing',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a collection...',
          typeOptions: { searchListMethod: 'weaviateCollectionsSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'e.g. Documents' },
      ],
    },
  ],
  insertOptions: [
    {
      ...clearStoreOption,
      displayName: 'Clear Data',
      description: 'Whether to delete the collection, or only the tenant when one is set, before inserting',
    },
    ...sharedOptions,
  ],
  retrieveOptions,
  methods: { listSearch: { weaviateCollectionsSearch } },
  async open(ctx, itemIndex) {
    const fail = (message: string, description?: string) =>
      new NodeOperationError(ctx.getNode(), message, { itemIndex, ...(description ? { description } : {}) });
    const rawOptions = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    let opts: WeaviateOptions;
    let base: string;
    try {
      opts = readOptions(locatorText(ctx.getNodeParameter('weaviateCollection', itemIndex, '')), rawOptions);
      base = weaviateBaseUrl(await ctx.getCredentials('weaviateApi', itemIndex));
    } catch (error) {
      throw fail(errorMessage(error));
    }
    return { backend: weaviateBackend(ctx, itemIndex, base, opts, fail) };
  },
});

type Fail = (message: string, description?: string) => NodeOperationError;

interface CollectionInfo {
  properties: Set<string>;
  multiTenancy: boolean;
}

function weaviateBackend(
  ctx: BaseContext,
  itemIndex: number,
  base: string,
  opts: WeaviateOptions,
  fail: Fail,
): VectorBackend {
  const classPath = `${base}/v1/schema/${encodeURIComponent(opts.className)}`;
  let ready = opts.skipInitChecks;
  let collection: CollectionInfo | null | undefined;
  let prepared = false;

  /** One request; any status comes back, so Weaviate's own message can be shown. */
  const call = async (options: HttpRequestOptions, action: string): Promise<HttpFullResponse<unknown>> => {
    try {
      return (await ctx.helpers.httpRequestWithAuthentication(
        'weaviateApi',
        { ...options, ignoreHttpStatusErrors: true, returnFullResponse: true },
        itemIndex,
      )) as HttpFullResponse<unknown>;
    } catch (error) {
      throw fail(`Couldn't ${action}: ${clip(errorMessage(error))}`);
    }
  };
  const ok = (response: HttpFullResponse<unknown>) => response.statusCode >= 200 && response.statusCode < 300;
  const refused = (response: HttpFullResponse<unknown>, action: string) =>
    fail(
      `Couldn't ${action}: Weaviate answered ${response.statusCode}`,
      clip(weaviateMessage(response.body)),
    );

  const ensureReady = async () => {
    if (ready) return;
    const response = await call(
      { url: `${base}/v1/.well-known/ready`, timeout: opts.initTimeout, responseType: 'text' },
      'reach Weaviate',
    );
    if (!ok(response)) throw fail(`Weaviate is not ready (status ${response.statusCode})`);
    ready = true;
  };

  const readCollection = async (): Promise<CollectionInfo | null> => {
    if (collection !== undefined) return collection;
    const response = await call(
      { url: classPath, timeout: opts.queryTimeout },
      'read the Weaviate collection',
    );
    if (response.statusCode === 404) return (collection = null);
    if (!ok(response)) throw refused(response, 'read the Weaviate collection');
    const body = response.body as {
      class?: unknown;
      properties?: Array<{ name?: unknown }>;
      multiTenancyConfig?: { enabled?: unknown };
    } | null;
    if (!body || typeof body !== 'object' || !body.class) return (collection = null);
    collection = {
      properties: new Set((body.properties ?? []).map((p) => String(p?.name ?? ''))),
      multiTenancy: body.multiTenancyConfig?.enabled === true,
    };
    return collection;
  };

  const ensureTenant = async (tenant: string) => {
    const tenantsPath = `${classPath}/tenants`;
    const listed = await call({ url: tenantsPath, timeout: opts.queryTimeout }, 'read the Weaviate tenants');
    if (!ok(listed)) throw refused(listed, 'read the Weaviate tenants');
    const names = Array.isArray(listed.body)
      ? listed.body.map((t) => String((t as { name?: unknown })?.name ?? ''))
      : [];
    if (names.includes(tenant)) return;
    const created = await call(
      { url: tenantsPath, method: 'POST', body: [{ name: tenant }], timeout: opts.insertTimeout },
      'add the Weaviate tenant',
    );
    if (!ok(created) && !/already exists/i.test(weaviateMessage(created.body))) {
      throw refused(created, 'add the Weaviate tenant');
    }
  };

  /** Creates the collection and the tenant when missing (insert only). */
  const prepareInsert = async () => {
    if (prepared) return;
    const existing = await readCollection();
    if (!existing) {
      const created = await call(
        {
          url: `${base}/v1/schema`,
          method: 'POST',
          timeout: opts.insertTimeout,
          body: {
            class: opts.className,
            vectorizer: 'none',
            properties: [{ name: opts.textKey, dataType: ['text'] }],
            ...(opts.tenant ? { multiTenancyConfig: { enabled: true } } : {}),
          },
        },
        'create the Weaviate collection',
      );
      if (!ok(created) && !/already exists/i.test(weaviateMessage(created.body))) {
        throw refused(created, 'create the Weaviate collection');
      }
      collection = undefined;
    } else if (opts.tenant && !existing.multiTenancy) {
      throw fail(
        `The Weaviate collection "${opts.className}" has no multi-tenancy, so it cannot hold a tenant`,
        'Remove Tenant Name, or use a collection created with multi-tenancy.',
      );
    } else if (!opts.tenant && existing.multiTenancy) {
      throw fail(`The Weaviate collection "${opts.className}" uses multi-tenancy: set Tenant Name`);
    }
    if (opts.tenant) await ensureTenant(opts.tenant);
    prepared = true;
  };

  return {
    async add(documents, vectors, ids) {
      if (!documents.length) return;
      if (ids?.some((id) => !UUID.test(id))) throw fail('Weaviate object IDs must be UUIDs');
      await ensureReady();
      await prepareInsert();
      for (let start = 0; start < documents.length; start += BATCH_SIZE) {
        const objects = documents.slice(start, start + BATCH_SIZE).map((document, i) => ({
          class: opts.className,
          properties: weaviateProperties(document, opts.textKey),
          vector: vectors[start + i],
          ...(opts.tenant ? { tenant: opts.tenant } : {}),
          ...(ids?.[start + i] ? { id: ids[start + i] } : {}),
        }));
        const response = await call(
          { url: `${base}/v1/batch/objects`, method: 'POST', body: { objects }, timeout: opts.insertTimeout },
          'insert into Weaviate',
        );
        if (!ok(response)) throw refused(response, 'insert into Weaviate');
        const results = Array.isArray(response.body) ? response.body : [];
        const errors = results
          .map(
            (o) =>
              (o as { result?: { errors?: { error?: Array<{ message?: unknown }> } } })?.result?.errors
                ?.error,
          )
          .filter((e): e is Array<{ message?: unknown }> => Array.isArray(e) && e.length > 0);
        if (errors.length) {
          throw fail(
            `Weaviate rejected ${errors.length} of ${objects.length} objects: ${clip(String(errors[0][0]?.message ?? 'unknown error'))}`,
          );
        }
      }
    },

    async search(vector, k, filter, text) {
      let where: WeaviateWhere | undefined;
      try {
        if (filter && Object.keys(filter).length) where = parseWhereFilter(filter);
      } catch (error) {
        throw fail(errorMessage(error));
      }
      await ensureReady();
      const info = await readCollection();
      if (!info) throw fail(`Weaviate collection "${opts.className}" not found`);
      if (!info.properties.has(opts.textKey)) {
        throw fail(
          `The Weaviate collection "${opts.className}" has no property "${opts.textKey}"`,
          'Set Text Key to the property that holds the document text.',
        );
      }
      const metadataKeys = opts.metadataKeys.filter(
        (key) => key !== opts.textKey && info.properties.has(key),
      );
      const hybridText = opts.hybrid ? opts.hybrid.query || text || '' : '';
      const hybrid: HybridSearch | undefined =
        opts.hybrid && hybridText
          ? {
              query: hybridText,
              vector,
              alpha: opts.hybrid.alpha,
              properties: opts.hybrid.properties,
              fusionType: opts.hybrid.fusionType,
              maxVectorDistance: opts.hybrid.maxVectorDistance,
            }
          : undefined;
      const explain = !!hybrid && opts.hybrid?.explain === true;
      const additional: AdditionalField[] = hybrid
        ? ['score', ...(explain ? (['explainScore'] as const) : [])]
        : ['distance'];
      let query: string;
      try {
        query = buildGetQuery({
          className: opts.className,
          limit: k,
          properties: [opts.textKey, ...metadataKeys],
          additional,
          ...(hybrid ? { hybrid, autocut: opts.hybrid?.autocut } : { nearVector: vector }),
          tenant: opts.tenant,
          where,
        });
      } catch (error) {
        if (error instanceof WeaviateQueryError) throw fail(error.message);
        throw error;
      }
      const response = await call(
        { url: `${base}/v1/graphql`, method: 'POST', body: { query }, timeout: opts.queryTimeout },
        'query Weaviate',
      );
      if (!ok(response)) throw refused(response, 'query Weaviate');
      const body = response.body as { data?: { Get?: Record<string, unknown> }; errors?: unknown };
      if (Array.isArray(body?.errors) && body.errors.length) {
        throw fail(`Weaviate query failed: ${clip(weaviateMessage(body))}`);
      }
      const rows = body?.data?.Get?.[opts.className];
      if (!Array.isArray(rows)) return [];
      return rows.map((row): ScoredDocument => {
        const object = (row ?? {}) as DataObject & { _additional?: DataObject };
        const metadata: DataObject = {};
        for (const key of metadataKeys) {
          if (object[key] !== null && object[key] !== undefined) metadata[key] = object[key];
        }
        const extra = object._additional ?? {};
        if (explain && extra.explainScore !== undefined && extra.explainScore !== null) {
          metadata.explainScore = extra.explainScore;
        }
        const score = Number(hybrid ? extra.score : extra.distance);
        if (!Number.isFinite(score)) throw fail('Weaviate returned a result without a score');
        return { document: { pageContent: String(object[opts.textKey] ?? ''), metadata }, score };
      });
    },

    async clear() {
      await ensureReady();
      const response = opts.tenant
        ? await call(
            {
              url: `${classPath}/tenants`,
              method: 'DELETE',
              body: [opts.tenant],
              timeout: opts.insertTimeout,
            },
            'remove the Weaviate tenant',
          )
        : await call(
            { url: classPath, method: 'DELETE', timeout: opts.insertTimeout },
            'delete the Weaviate collection',
          );
      // a missing collection or tenant is already clear
      if (!ok(response) && response.statusCode !== 404 && response.statusCode !== 422) {
        throw refused(
          response,
          opts.tenant ? 'remove the Weaviate tenant' : 'delete the Weaviate collection',
        );
      }
      collection = undefined;
      prepared = false;
    },
  };
}
