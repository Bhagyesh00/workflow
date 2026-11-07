/**
 * Redis Vector Store (P5-41): documents are hashes in a Redis query-engine index, searched by KNN.
 * One version: the metadata filter is a query expression (`@topic:{news} @price:[0 100]`).
 *
 * Layout (as n8n): one hash per document with the text (Content Key), the metadata as JSON (Metadata
 * Key), the vector as float32 bytes (Embedding Key) and every scalar metadata value as a hash field of
 * its own so a filter can name it. The index is `ON HASH PREFIX 1 <prefix>` with a FLAT cosine vector.
 *
 * Commands go through the shared ioredis client with `call` (no second Redis package). Index, prefix
 * and field names are checked against one pattern before any command; the user's filter is only ever
 * the query string of FT.SEARCH, the search text is embedded and never sent.
 */
import { randomUUID } from 'node:crypto';
import {
  type AiDocument,
  type BaseContext,
  type DataObject,
  isResourceLocatorValue,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import type { Redis } from 'ioredis';
import { sharedRedis } from '../../shared/connections';
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type ScoredDocument,
  type VectorBackend,
} from './vector-store-factory';

const NAME = /^[A-Za-z0-9_:.-]{1,128}$/;
const DEFAULT_PREFIX = 'doc:';
const DEFAULT_CONTENT_KEY = 'text';
const DEFAULT_METADATA_KEY = 'metadata';
const DEFAULT_EMBEDDING_KEY = 'embedding';
const SCORE_FIELD = 'score';
const FIELD_TYPES = ['tag', 'text', 'numeric', 'geo'] as const;
type FieldType = (typeof FIELD_TYPES)[number];
const MAX_FILTER_LENGTH = 4000;
const MAX_TOP_K = 10_000;
const MAX_INFERRED_FIELDS = 64;
const MAX_LISTED_INDEXES = 1000;
const MISSING_INDEX = /unknown.{0,20}index|no such index|index.{0,40}not found/i;

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

const keyOptions: NodeProperty[] = [
  {
    displayName: 'Content Key',
    name: 'contentKey',
    type: 'string',
    default: DEFAULT_CONTENT_KEY,
    description: 'Hash field that holds the document text',
  },
  {
    displayName: 'Metadata Key',
    name: 'metadataKey',
    type: 'string',
    default: DEFAULT_METADATA_KEY,
    description: 'Hash field that holds the document metadata as JSON',
  },
  {
    displayName: 'Embedding Key',
    name: 'embeddingKey',
    type: 'string',
    default: DEFAULT_EMBEDDING_KEY,
    description: 'Hash field that holds the vector',
  },
];

const insertOptions: NodeProperty[] = [
  {
    displayName: 'Key Prefix',
    name: 'keyPrefix',
    type: 'string',
    default: DEFAULT_PREFIX,
    description:
      'Prefix of the hash keys. It is set when the index is created; an existing index keeps its own prefix.',
  },
  ...keyOptions,
  {
    displayName: 'Time-To-Live',
    name: 'ttl',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0 },
    description: 'Seconds after which the inserted documents expire. 0 keeps them.',
  },
  {
    displayName: 'Overwrite Documents',
    name: 'overwriteDocuments',
    type: 'boolean',
    default: false,
    description: 'Whether to drop the index and all of its documents before inserting',
  },
  {
    displayName: 'Metadata Schema',
    name: 'metadataSchema',
    type: 'json',
    default: '',
    typeOptions: { rows: 4 },
    description:
      'Metadata fields to index when the index is created, as a JSON array of {"name", "type": "tag" | "text" | "numeric" | "geo", "options"}. When empty, the fields are taken from the documents.',
  },
];

const retrieveOptions: NodeProperty[] = [
  ...keyOptions,
  {
    displayName: 'Metadata Filter',
    name: 'metadataFilter',
    type: 'string',
    default: '',
    description:
      'A query expression that narrows the search, for example @category:{electronics} @price:[0 100]. Every field it names must be in the index.',
  },
];

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function locatorText(raw: unknown): string {
  return String((isResourceLocatorValue(raw) ? raw.value : raw) ?? '').trim();
}

function fail(ctx: BaseContext, itemIndex: number, message: string, description?: string): never {
  throw new NodeOperationError(ctx.getNode(), message, { itemIndex, description });
}

function isPlainObject(value: unknown): value is DataObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOption(options: DataObject, name: string, fallback: string): string {
  const value = options[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

interface SchemaField {
  name: string;
  type: FieldType;
  sortable?: boolean;
  separator?: string;
  caseSensitive?: boolean;
  weight?: number;
  noStem?: boolean;
}

/** `metadataSchema` as n8n reads it: a JSON array of {name, type, options}. */
function parseSchema(
  ctx: BaseContext,
  itemIndex: number,
  raw: unknown,
  reserved: Set<string>,
): SchemaField[] | undefined {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      fail(ctx, itemIndex, `Invalid metadata schema JSON: ${errorMessage(error)}`);
    }
  }
  if (!Array.isArray(value)) fail(ctx, itemIndex, 'Invalid metadata schema: must be a JSON array');
  const fields: SchemaField[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) fail(ctx, itemIndex, 'Invalid metadata schema: every field must be an object');
    const name = String(entry.name ?? '');
    if (!NAME.test(name)) {
      fail(
        ctx,
        itemIndex,
        `Invalid metadata schema: field name "${name.slice(0, 128)}" is not valid`,
        NAME_HINT,
      );
    }
    if (reserved.has(name)) {
      fail(
        ctx,
        itemIndex,
        `Invalid metadata schema: "${name}" is the Content, Metadata or Embedding Key`,
        'Choose another field name.',
      );
    }
    const type = String(entry.type ?? '');
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      fail(
        ctx,
        itemIndex,
        `Invalid metadata schema: field type "${type.slice(0, 64)}" is not valid. Must be one of: ${FIELD_TYPES.join(', ')}`,
        `Field "${name}".`,
      );
    }
    const field: SchemaField = { name, type: type as FieldType };
    const options = entry.options;
    if (options !== undefined && options !== null) {
      if (!isPlainObject(options))
        fail(ctx, itemIndex, `Invalid metadata schema: options of "${name}" must be an object`);
      for (const [key, option] of Object.entries(options)) {
        if (key === 'sortable' && typeof option === 'boolean') field.sortable = option;
        else if (key === 'separator' && type === 'tag' && typeof option === 'string' && option.length === 1) {
          field.separator = option;
        } else if (key === 'caseSensitive' && type === 'tag' && typeof option === 'boolean') {
          field.caseSensitive = option;
        } else if (key === 'weight' && type === 'text' && typeof option === 'number' && option > 0) {
          field.weight = option;
        } else if (key === 'noStem' && type === 'text' && typeof option === 'boolean') field.noStem = option;
        else
          fail(
            ctx,
            itemIndex,
            `Invalid metadata schema: option "${key.slice(0, 64)}" of "${name}" is not valid`,
          );
      }
    }
    fields.push(field);
  }
  return fields;
}

const NAME_HINT = 'Use letters, digits and the characters _ : . - (up to 128).';

interface Settings {
  index: string;
  prefix: string;
  contentKey: string;
  metadataKey: string;
  embeddingKey: string;
  ttl: number;
  overwrite: boolean;
  schema?: SchemaField[];
  filter: string;
}

function readSettings(ctx: BaseContext, itemIndex: number): Settings {
  const index = locatorText(ctx.getNodeParameter('redisIndex', itemIndex, ''));
  if (!index) fail(ctx, itemIndex, 'Select a Redis index');
  if (!NAME.test(index)) fail(ctx, itemIndex, `Invalid index name "${index.slice(0, 128)}"`, NAME_HINT);
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;

  const named = (option: string, label: string, fallback: string): string => {
    const value = stringOption(options, option, fallback);
    if (!NAME.test(value)) fail(ctx, itemIndex, `Invalid ${label} "${value.slice(0, 128)}"`, NAME_HINT);
    return value;
  };
  const prefix = named('keyPrefix', 'Key Prefix', DEFAULT_PREFIX);
  const contentKey = named('contentKey', 'Content Key', DEFAULT_CONTENT_KEY);
  const metadataKey = named('metadataKey', 'Metadata Key', DEFAULT_METADATA_KEY);
  const embeddingKey = named('embeddingKey', 'Embedding Key', DEFAULT_EMBEDDING_KEY);
  const keys = new Set([contentKey, metadataKey, embeddingKey]);
  if (keys.size < 3 || keys.has(SCORE_FIELD)) {
    fail(
      ctx,
      itemIndex,
      'Content Key, Metadata Key and Embedding Key must be different',
      `They must also differ from "${SCORE_FIELD}".`,
    );
  }

  let ttl = 0;
  if (options.ttl !== undefined && options.ttl !== null && options.ttl !== '') {
    ttl = Number(options.ttl);
    if (!Number.isInteger(ttl) || ttl < 0) {
      fail(ctx, itemIndex, 'Time-To-Live must be a whole number of seconds, 0 or more');
    }
  }

  const filter = typeof options.metadataFilter === 'string' ? options.metadataFilter.trim() : '';
  if (filter.length > MAX_FILTER_LENGTH) {
    fail(ctx, itemIndex, `The Metadata Filter is longer than ${MAX_FILTER_LENGTH} characters`);
  }

  return {
    index,
    prefix,
    contentKey,
    metadataKey,
    embeddingKey,
    ttl,
    overwrite: options.overwriteDocuments === true,
    schema: parseSchema(ctx, itemIndex, options.metadataSchema, keys),
    filter,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading what Redis answers
// ---------------------------------------------------------------------------------------------

/** The value after `key` in a flat [key, value, key, value] reply. */
function after(list: unknown, key: string): unknown {
  if (!Array.isArray(list)) return undefined;
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (String(list[i]).toLowerCase() === key) return list[i + 1];
  }
  return undefined;
}

interface IndexInfo {
  prefix?: string;
  /** vector size the index was created with, when the reply names it */
  dimensions?: number;
}

function readInfo(reply: unknown, embeddingKey: string): IndexInfo {
  const prefixes = after(after(reply, 'index_definition'), 'prefixes');
  const prefix = Array.isArray(prefixes) && prefixes.length ? String(prefixes[0]) : undefined;
  let dimensions: number | undefined;
  const attributes = after(reply, 'attributes');
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      if (String(after(attribute, 'identifier')) !== embeddingKey) continue;
      const dim = Number(after(attribute, 'dim'));
      if (Number.isInteger(dim) && dim > 0) dimensions = dim;
    }
  }
  return { prefix, dimensions };
}

/**
 * The returned fields of each hit of an FT.SEARCH reply. Redis 8 answers with a map
 * (`results: [{id, extra_attributes: [field, value, ...]}]`), older servers with
 * `[total, key, [field, value, ...], ...]`.
 */
function searchRows(reply: unknown): unknown[] {
  if (!Array.isArray(reply)) return [];
  const results = after(reply, 'results');
  if (Array.isArray(results)) return results.map((hit) => after(hit, 'extra_attributes'));
  const rows: unknown[] = [];
  for (let i = 1; i + 1 < reply.length; i += 2) rows.push(reply[i + 1]);
  return rows;
}

function inferType(value: unknown): FieldType | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return 'numeric';
  if (typeof value === 'boolean') return 'tag';
  if (typeof value === 'string') return 'text';
  return undefined;
}

/** A scalar metadata value as the text of a hash field; lists of scalars become comma-separated tags. */
function hashValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (
    Array.isArray(value) &&
    value.length &&
    value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))
  ) {
    return value.join(',');
  }
  return undefined;
}

function schemaArgs(field: SchemaField): string[] {
  const args = [field.name, field.type.toUpperCase()];
  if (field.type === 'tag') {
    if (field.separator) args.push('SEPARATOR', field.separator);
    if (field.caseSensitive) args.push('CASESENSITIVE');
  }
  if (field.type === 'text') {
    if (field.weight) args.push('WEIGHT', String(field.weight));
    if (field.noStem) args.push('NOSTEM');
  }
  if (field.sortable) args.push('SORTABLE');
  return args;
}

function inferSchema(documents: AiDocument[], reserved: Set<string>): SchemaField[] {
  const found = new Map<string, FieldType>();
  for (const document of documents) {
    for (const [name, value] of Object.entries(document.metadata ?? {})) {
      if (found.has(name) || reserved.has(name) || !NAME.test(name)) continue;
      const type = inferType(value);
      if (type && found.size < MAX_INFERRED_FIELDS) found.set(name, type);
    }
  }
  return [...found].map(([name, type]) => ({ name, type }));
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

function redisFailure(ctx: BaseContext, itemIndex: number, what: string, error: unknown): never {
  throw new NodeOperationError(ctx.getNode(), `${what}: ${redactSecrets(errorMessage(error))}`, {
    itemIndex,
  });
}

function missingIndex(ctx: BaseContext, itemIndex: number, index: string): never {
  fail(
    ctx,
    itemIndex,
    `Index ${index} not found`,
    'Please check that the index exists in your Redis instance',
  );
}

function openBackend(ctx: BaseContext, itemIndex: number, client: Redis, settings: Settings): VectorBackend {
  const { index, contentKey, metadataKey, embeddingKey } = settings;
  const reserved = new Set([contentKey, metadataKey, embeddingKey]);
  let overwritePending = settings.overwrite;
  let known: IndexInfo | undefined;

  const infoOf = async (): Promise<IndexInfo | undefined> => {
    try {
      return readInfo(await client.call('FT.INFO', index), embeddingKey);
    } catch (error) {
      if (MISSING_INDEX.test(errorMessage(error))) return undefined;
      return redisFailure(ctx, itemIndex, 'Redis could not read the index', error);
    }
  };

  const create = async (documents: AiDocument[], dimensions: number): Promise<IndexInfo> => {
    const schema = settings.schema ?? inferSchema(documents, reserved);
    try {
      await client.call(
        'FT.CREATE',
        index,
        'ON',
        'HASH',
        'PREFIX',
        '1',
        settings.prefix,
        'SCHEMA',
        contentKey,
        'TEXT',
        metadataKey,
        'TEXT',
        embeddingKey,
        'VECTOR',
        'FLAT',
        '6',
        'TYPE',
        'FLOAT32',
        'DIM',
        String(dimensions),
        'DISTANCE_METRIC',
        'COSINE',
        ...schema.flatMap(schemaArgs),
      );
    } catch (error) {
      return redisFailure(ctx, itemIndex, 'Redis could not create the index', error);
    }
    return { prefix: settings.prefix, dimensions };
  };

  const hashArgs = (document: AiDocument, vector: number[]): Array<string | Buffer> => {
    const metadata = document.metadata ?? {};
    const args: Array<string | Buffer> = [
      contentKey,
      document.pageContent,
      metadataKey,
      JSON.stringify(metadata),
    ];
    for (const [name, value] of Object.entries(metadata)) {
      const text = hashValue(value);
      if (text !== undefined && NAME.test(name) && !reserved.has(name) && name !== SCORE_FIELD) {
        args.push(name, text);
      }
    }
    args.push(embeddingKey, Buffer.from(new Float32Array(vector).buffer));
    return args;
  };

  return {
    async add(documents, vectors, ids) {
      if (!documents.length) return;
      if (overwritePending && !ids) {
        overwritePending = false;
        try {
          await client.call('FT.DROPINDEX', index, 'DD');
        } catch (error) {
          if (!MISSING_INDEX.test(errorMessage(error))) {
            redisFailure(ctx, itemIndex, 'Redis could not drop the index', error);
          }
        }
        known = undefined;
      }
      known ??= await infoOf();
      if (!known) {
        if (ids) missingIndex(ctx, itemIndex, index);
        known = await create(documents, vectors[0].length);
      }
      const size = vectors[0].length;
      if (known.dimensions !== undefined && known.dimensions !== size) {
        fail(
          ctx,
          itemIndex,
          `The index "${index}" holds vectors of ${known.dimensions} dimensions but the embeddings have ${size}`,
          'Use the embeddings model the index was built with, or another index.',
        );
      }
      const prefix = known.prefix ?? settings.prefix;
      const transaction = client.multi();
      documents.forEach((document, i) => {
        const key = `${prefix}${ids ? ids[i] : randomUUID()}`;
        if (ids && !NAME.test(ids[i]))
          fail(ctx, itemIndex, `Invalid ID "${ids[i].slice(0, 128)}"`, NAME_HINT);
        if (ids) transaction.call('DEL', key);
        transaction.call('HSET', key, ...hashArgs(document, vectors[i]));
        if (settings.ttl > 0) transaction.call('EXPIRE', key, String(settings.ttl));
      });
      try {
        const results = await transaction.exec();
        const failed = results?.find(([error]) => error);
        if (failed?.[0]) throw failed[0];
      } catch (error) {
        redisFailure(ctx, itemIndex, 'Redis could not store the documents', error);
      }
    },

    async search(vector, k) {
      const limit = Math.max(1, Math.min(MAX_TOP_K, Math.trunc(k)));
      const query = `(${settings.filter || '*'})=>[KNN ${limit} @${embeddingKey} $B AS ${SCORE_FIELD}]`;
      let reply: unknown;
      try {
        reply = await client.call(
          'FT.SEARCH',
          index,
          query,
          'PARAMS',
          '2',
          'B',
          Buffer.from(new Float32Array(vector).buffer),
          'SORTBY',
          SCORE_FIELD,
          'LIMIT',
          '0',
          String(limit),
          'RETURN',
          '3',
          contentKey,
          metadataKey,
          SCORE_FIELD,
          'DIALECT',
          '2',
        );
      } catch (error) {
        if (MISSING_INDEX.test(errorMessage(error))) return missingIndex(ctx, itemIndex, index);
        return redisFailure(ctx, itemIndex, 'Redis search failed', error);
      }
      const found: ScoredDocument[] = [];
      for (const fields of searchRows(reply)) {
        const content = after(fields, contentKey);
        let metadata: DataObject = {};
        try {
          const parsed: unknown = JSON.parse(String(after(fields, metadataKey) ?? '{}'));
          if (isPlainObject(parsed)) metadata = parsed;
        } catch {
          // metadata written by another tool: keep the text, drop the metadata
        }
        found.push({
          document: { pageContent: String(content ?? ''), metadata },
          score: 1 - Number(after(fields, SCORE_FIELD)),
        });
      }
      return found;
    },
  };
}

/** Lists the query-engine indexes of the database, filtered by the typed text. */
async function redisIndexSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const { value: client, release } = await sharedRedis(ctx, 0);
  try {
    const listed = (await client.call('FT._LIST')) as unknown[];
    const needle = (filter ?? '').trim().toLowerCase();
    const names = listed
      .map(String)
      .filter((name) => !needle || name.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_LISTED_INDEXES);
    return { results: names.map((name) => ({ name, value: name })) };
  } catch (error) {
    throw new Error(`Could not list the Redis indexes: ${redactSecrets(errorMessage(error))}`);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------------------------

export const VectorStoreRedisNode = createVectorStoreNode({
  name: 'ai.vectorStoreRedis',
  displayName: 'Redis Vector Store',
  description: 'Stores documents in a Redis vector index and searches them by similarity',
  icon: 'simple:redis',
  credentials: [{ name: 'redis', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'none',
  properties: [
    {
      displayName: 'Redis Index',
      name: 'redisIndex',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'Insert creates the index when it does not exist',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select an index...',
          typeOptions: { searchListMethod: 'redisIndexSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'Index name' },
      ],
    },
  ],
  insertOptions,
  retrieveOptions,
  methods: { listSearch: { redisIndexSearch } },
  async open(ctx, itemIndex) {
    const settings = readSettings(ctx, itemIndex);
    const { value: client, release } = await sharedRedis(ctx, itemIndex);
    return { backend: openBackend(ctx, itemIndex, client, settings), close: release };
  },
});
