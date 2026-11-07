/**
 * MongoDB Atlas Vector Store: documents in a MongoDB collection, searched with `$vectorSearch`.
 * Layout as n8n: `{ <text field>, <embedding field>, ...metadata }` with the metadata at the top
 * level; a Namespace is stored in `metadata.namespace`. The user creates the vector search index;
 * the node creates only the collection. Every filter path must be declared in that index as
 * `type: 'filter'`. The client goes through the SSRF guard of shared/mongo.ts.
 *
 * The Post Filter Pipeline is user JSON run on the server, so only reading stages are allowed and
 * operators that run server-side code are refused at any depth.
 */
import {
  type BaseContext,
  type DataObject,
  isResourceLocatorValue,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { type Collection, type Document, ObjectId } from 'mongodb';
import { mongoDbConnectionTest, sanitizeMongoError, sharedMongo } from '../../shared/mongo';
import {
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type ScoredDocument,
  type VectorBackend,
} from './vector-store-factory';

const CREDENTIAL = 'mongoDb';
const COLLECTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;
/** text and embedding fields: one top-level field */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** filter paths: dotted field names */
const FIELD_PATH = /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/;
const MAX_FIELD_PATH = 200;
const MAX_INDEX_NAME = 256;
const NAMESPACE_PATH = 'metadata.namespace';
/** Atlas caps numCandidates at 10,000 */
const MAX_CANDIDATES = 10_000;
const AGGREGATE_MAX_MS = 60_000;
const MAX_LISTED_COLLECTIONS = 1000;

/** stages a post filter may hold: they only read, reshape or order the search results */
const ALLOWED_STAGES = new Set([
  '$match',
  '$project',
  '$set',
  '$addFields',
  '$unset',
  '$sort',
  '$limit',
  '$skip',
  '$count',
]);
/** stages refused by name: they write data, run server-side code or read other collections */
const REFUSED_STAGES = new Set(['$out', '$merge', '$function', '$accumulator', '$where', '$lookup']);
/** operators that run server-side code, refused at any depth of a filter or post stage */
const REFUSED_OPERATORS = new Set(['$where', '$function', '$accumulator']);
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

const namespaceOption: NodeProperty = {
  displayName: 'Namespace',
  name: 'namespace',
  type: 'string',
  default: '',
  description:
    'Logical partition of the documents, stored in metadata.namespace. Searching by namespace needs the vector search index to declare metadata.namespace as a field of type "filter".',
};

const clearNamespaceOption: NodeProperty = {
  displayName: 'Clear Namespace',
  name: 'clearNamespace',
  type: 'boolean',
  default: false,
  description: 'Whether to delete the documents of the namespace before inserting (needs a Namespace)',
};

const preFilterOption: NodeProperty = {
  displayName: 'Pre Filter',
  name: 'preFilter',
  type: 'json',
  default: '',
  typeOptions: { rows: 4 },
  description:
    'A MongoDB filter for $vectorSearch, for example {"category": {"$eq": "news"}}. Every field it names must be declared in the vector search index as type "filter".',
};

const postFilterPipelineOption: NodeProperty = {
  displayName: 'Post Filter Pipeline',
  name: 'postFilterPipeline',
  type: 'json',
  default: '',
  typeOptions: { rows: 4 },
  description: `Aggregation stages run on the search results, as a JSON array, for example [{"$match": {"score": {"$gte": 0.5}}}]. Allowed stages: ${[...ALLOWED_STAGES].join(', ')}.`,
};

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function locatorText(raw: unknown): string {
  return String((isResourceLocatorValue(raw) ? raw.value : raw) ?? '').trim();
}

function isPlainObject(value: unknown): value is DataObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fail(ctx: BaseContext, itemIndex: number, message: string, description?: string): never {
  throw new NodeOperationError(ctx.getNode(), message, { itemIndex, description });
}

function collectionParameter(ctx: BaseContext, itemIndex: number): string {
  const name = locatorText(ctx.getNodeParameter('mongoCollection', itemIndex, ''));
  if (!name) fail(ctx, itemIndex, 'Enter a MongoDB collection');
  if (!COLLECTION_NAME.test(name) || name.startsWith('system.')) {
    fail(
      ctx,
      itemIndex,
      `Invalid collection name "${name.slice(0, 120)}"`,
      'Use letters, digits, underscores, dots and dashes; names starting with "system." are reserved.',
    );
  }
  return name;
}

function fieldParameter(ctx: BaseContext, itemIndex: number, name: string, label: string, fallback: string) {
  const value = String(ctx.getNodeParameter(name, itemIndex, fallback) ?? '').trim() || fallback;
  if (!FIELD_NAME.test(value) || value === '_id') {
    fail(
      ctx,
      itemIndex,
      `Invalid ${label} field "${value.slice(0, 64)}"`,
      'Use one top-level field name: letters, digits, underscores and dashes, not starting with a digit.',
    );
  }
  return value;
}

/** Walks `value` (depth and size bounded) and refuses every operator that runs server-side code. */
function assertSafeJson(ctx: BaseContext, itemIndex: number, value: unknown, label: string): void {
  let nodes = 0;
  const walk = (current: unknown, depth: number): void => {
    if (current === null || typeof current !== 'object') return;
    if (depth > MAX_JSON_DEPTH) fail(ctx, itemIndex, `The ${label} is nested too deeply`);
    if (++nodes > MAX_JSON_NODES) fail(ctx, itemIndex, `The ${label} is too large`);
    if (Array.isArray(current)) {
      for (const entry of current) walk(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(current as DataObject)) {
      if (REFUSED_OPERATORS.has(key)) {
        fail(
          ctx,
          itemIndex,
          `The ${label} may not use ${key}`,
          'Operators that run code on the server are refused.',
        );
      }
      walk(entry, depth + 1);
    }
  };
  walk(value, 0);
}

function parseJsonParameter(ctx: BaseContext, itemIndex: number, raw: unknown, label: string): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return raw;
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return fail(ctx, itemIndex, `The ${label} is not valid JSON`);
  }
}

function readPreFilter(ctx: BaseContext, itemIndex: number, raw: unknown): DataObject | undefined {
  const value = parseJsonParameter(ctx, itemIndex, raw, 'pre filter');
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail(ctx, itemIndex, 'The pre filter must be a JSON object');
  assertSafeJson(ctx, itemIndex, value, 'pre filter');
  return Object.keys(value).length ? value : undefined;
}

function readPostStages(ctx: BaseContext, itemIndex: number, raw: unknown): Document[] {
  const value = parseJsonParameter(ctx, itemIndex, raw, 'post filter pipeline');
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(ctx, itemIndex, 'The post filter pipeline must be a JSON array of stages');
  for (const stage of value) {
    const keys = isPlainObject(stage) ? Object.keys(stage) : [];
    if (keys.length !== 1) {
      fail(
        ctx,
        itemIndex,
        'Each post filter stage must be an object with one stage name, like {"$match": {}}',
      );
    }
    const name = keys[0];
    if (REFUSED_STAGES.has(name)) {
      fail(
        ctx,
        itemIndex,
        `The post filter stage ${name} is not allowed`,
        'Stages that write data, run code on the server or read other collections are refused.',
      );
    }
    if (!ALLOWED_STAGES.has(name)) {
      fail(
        ctx,
        itemIndex,
        `The post filter stage ${name.slice(0, 64)} is not allowed`,
        `Allowed stages: ${[...ALLOWED_STAGES].join(', ')}.`,
      );
    }
  }
  assertSafeJson(ctx, itemIndex, value, 'post filter pipeline');
  return value as Document[];
}

/** Pre filter, Metadata Filter (as `$eq` on each field) and namespace, joined with `$and`. */
function mergeFilters(
  ctx: BaseContext,
  itemIndex: number,
  preFilter: DataObject | undefined,
  metadataFilter: DataObject | undefined,
  namespace: string,
): DataObject | undefined {
  const parts: DataObject[] = [];
  if (preFilter) parts.push(preFilter);
  for (const [path, value] of Object.entries(metadataFilter ?? {})) {
    if (!FIELD_PATH.test(path) || path.length > MAX_FIELD_PATH) {
      fail(ctx, itemIndex, `Invalid metadata filter field "${path.slice(0, 64)}"`);
    }
    parts.push({ [path]: { $eq: value } });
  }
  if (namespace) parts.push({ [NAMESPACE_PATH]: { $eq: namespace } });
  if (!parts.length) return undefined;
  const merged = parts.length === 1 ? parts[0] : { $and: parts };
  assertSafeJson(ctx, itemIndex, merged, 'search filter');
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const UNDECLARED_PATH = /Path '([^']{1,300})' needs to be indexed as (\w+)/;

function mongoErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** The server's error as the user should see it: a missing filter field named, secrets removed. */
function toNodeError(
  ctx: BaseContext,
  itemIndex: number,
  error: unknown,
  credentials: DataObject,
  indexName: string,
): Error {
  if (error instanceof NodeOperationError) return error;
  const sanitized = sanitizeMongoError(error, credentials);
  const undeclared = UNDECLARED_PATH.exec(sanitized.message);
  if (undeclared) {
    const [, path, type] = undeclared;
    return new NodeOperationError(
      ctx.getNode(),
      `The field "${path}" is not declared in the vector search index "${indexName}"`,
      {
        itemIndex,
        description: `Filters of $vectorSearch work only on fields the index declares with type "${type}". Add {"type": "${type}", "path": "${path}"} to the fields of the index.`,
      },
    );
  }
  return new NodeOperationError(ctx.getNode(), sanitized.message, { itemIndex });
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** an id typed by the user: a 24-hex id is the ObjectId MongoDB gave the document on insert */
function documentKey(id: string): ObjectId | string {
  return /^[0-9a-fA-F]{24}$/.test(id) ? new ObjectId(id) : id;
}

function toStored(
  pageContent: string,
  metadata: DataObject | undefined,
  vector: number[],
  textKey: string,
  embeddingKey: string,
  namespace: string,
): Document {
  const fields: Document = { ...(metadata ?? {}) };
  // the text, the vector and the id are the node's own fields
  delete fields._id;
  delete fields[textKey];
  delete fields[embeddingKey];
  if (namespace) {
    const nested = isPlainObject(fields.metadata) ? fields.metadata : {};
    fields.metadata = { ...nested, namespace };
  }
  return { [textKey]: pageContent, [embeddingKey]: vector, ...fields };
}

function fromStored(row: Document, textKey: string, embeddingKey: string): ScoredDocument {
  const { _id, score, ...rest } = row;
  const text = rest[textKey];
  delete rest[textKey];
  delete rest[embeddingKey];
  const metadata: DataObject = { ...(rest as DataObject) };
  if (_id !== undefined && _id !== null) metadata._id = String(_id);
  return {
    document: {
      pageContent: typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text),
      metadata,
    },
    score: typeof score === 'number' ? score : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// List search
// ---------------------------------------------------------------------------------------------

/** Lists the collections of the credential's database, filtered by the typed text. */
async function mongoCollectionSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const credentials: DataObject = await ctx.getCredentials(CREDENTIAL, 0);
  const { value: handle, release } = await sharedMongo(ctx, 0, CREDENTIAL);
  try {
    if (!handle.databaseName) throw new Error('Database name must be provided in the credentials');
    const listed = await handle.client
      .db(handle.databaseName)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray();
    const needle = (filter ?? '').trim().toLowerCase();
    const names = listed
      .map((c) => String(c.name ?? ''))
      .filter((name) => name && !name.startsWith('system.'))
      .filter((name) => !needle || name.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_LISTED_COLLECTIONS);
    return { results: names.map((name) => ({ name, value: name })) };
  } catch (error) {
    throw sanitizeMongoError(error, credentials);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------------------------

export const VectorStoreMongoDBAtlasNode = createVectorStoreNode({
  name: 'ai.vectorStoreMongoDBAtlas',
  displayName: 'MongoDB Atlas Vector Store',
  description: 'Stores documents in a MongoDB Atlas collection and searches them with $vectorSearch',
  icon: 'simple:mongodb',
  credentials: [{ name: CREDENTIAL, required: true, testedBy: 'mongoDbConnectionTest' }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'metadata',
  methods: { credentialTest: { mongoDbConnectionTest }, listSearch: { mongoCollectionSearch } },
  properties: [
    {
      displayName: 'MongoDB Collection',
      name: 'mongoCollection',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: "Collection of the credential's database; created on the first insert when missing",
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a collection...',
          typeOptions: { searchListMethod: 'mongoCollectionSearch', searchable: true },
        },
        { displayName: 'Name', name: 'name', type: 'string', placeholder: 'e.g. my_collection' },
      ],
    },
    {
      displayName: 'Embedding',
      name: 'embedding',
      type: 'string',
      default: 'embedding',
      required: true,
      description: 'Field that holds the embedding vector (the path of the vector field of the index)',
    },
    {
      displayName: 'Metadata Field',
      name: 'metadata_field',
      type: 'string',
      default: 'text',
      required: true,
      description: 'Field that holds the text of a document',
    },
    {
      displayName: 'Vector Index Name',
      name: 'vectorIndexName',
      type: 'string',
      default: '',
      required: true,
      description:
        'Name of the Atlas Vector Search index of the collection, with a vector field on the Embedding field',
    },
  ],
  insertOptions: [clearNamespaceOption, namespaceOption],
  retrieveOptions: [namespaceOption, preFilterOption, postFilterPipelineOption],
  async open(ctx, itemIndex) {
    const mode = String(ctx.getNodeParameter('mode', itemIndex, 'retrieve') ?? 'retrieve');
    const collectionName = collectionParameter(ctx, itemIndex);
    const embeddingKey = fieldParameter(ctx, itemIndex, 'embedding', 'Embedding', 'embedding');
    const textKey = fieldParameter(ctx, itemIndex, 'metadata_field', 'Metadata Field', 'text');
    if (embeddingKey === textKey) fail(ctx, itemIndex, 'The Embedding and Metadata Field fields must differ');
    const indexName = String(ctx.getNodeParameter('vectorIndexName', itemIndex, '') ?? '').trim();
    if (mode !== 'insert' && mode !== 'update' && !indexName)
      fail(ctx, itemIndex, 'Enter the vector index name');
    if (indexName.length > MAX_INDEX_NAME) fail(ctx, itemIndex, 'The vector index name is too long');
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const namespace = typeof options.namespace === 'string' ? options.namespace.trim() : '';
    const searching = mode !== 'insert' && mode !== 'update';
    const preFilter = searching ? readPreFilter(ctx, itemIndex, options.preFilter) : undefined;
    const postStages = searching ? readPostStages(ctx, itemIndex, options.postFilterPipeline) : [];
    const clearNamespace = mode === 'insert' && options.clearNamespace === true;
    if (clearNamespace && !namespace) {
      fail(
        ctx,
        itemIndex,
        'Clear Namespace needs a Namespace',
        'Enter the namespace whose documents to delete.',
      );
    }

    const credentials: DataObject = await ctx.getCredentials(CREDENTIAL, itemIndex);
    const { value: handle, release } = await sharedMongo(ctx, itemIndex, CREDENTIAL);
    const nodeError = (error: unknown) => toNodeError(ctx, itemIndex, error, credentials, indexName);
    const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        throw nodeError(error);
      }
    };

    let collection: Collection<Document & { _id?: ObjectId | string }>;
    try {
      if (!handle.databaseName) {
        fail(ctx, itemIndex, 'Database name must be provided in the credentials');
      }
      const db = handle.client.db(handle.databaseName);
      collection = db.collection(collectionName);
      if (clearNamespace)
        await guarded(() => collection.deleteMany({ [NAMESPACE_PATH]: { $eq: namespace } }));
    } catch (error) {
      await release();
      throw error;
    }

    let collectionReady = false;
    const ensureCollection = async () => {
      if (collectionReady) return;
      await guarded(async () => {
        const db = handle.client.db(handle.databaseName);
        const existing = await db.listCollections({ name: collectionName }, { nameOnly: true }).toArray();
        if (!existing.length) {
          // another run may create it at the same moment: NamespaceExists (48) is fine
          await db.createCollection(collectionName).catch((error: unknown) => {
            if (mongoErrorCode(error) !== 48) throw error;
          });
        }
      });
      collectionReady = true;
    };

    let indexReady = false;
    const ensureIndex = async () => {
      if (indexReady) return;
      const indexes = await guarded(() =>
        collection
          .listSearchIndexes(indexName)
          .toArray()
          .catch((error: unknown) => {
            // NamespaceNotFound (26): no collection, so no index
            if (mongoErrorCode(error) === 26) return [] as Document[];
            throw error;
          }),
      );
      if (!indexes.some((index) => index.name === indexName)) {
        fail(
          ctx,
          itemIndex,
          `Index ${indexName} not found`,
          'Check that the vector search index exists on the collection.',
        );
      }
      indexReady = true;
    };

    const backend: VectorBackend = {
      async add(documents, vectors, ids) {
        if (!documents.length) return;
        await ensureCollection();
        if (!ids) {
          const rows = documents.map((d, i) =>
            toStored(d.pageContent, d.metadata, vectors[i], textKey, embeddingKey, namespace),
          );
          await guarded(() => collection.insertMany(rows, { ordered: true }));
          return;
        }
        // update mode: replace by id, keeping the namespace the document had
        for (let i = 0; i < documents.length; i++) {
          const key = documentKey(ids[i]);
          const existing = await guarded(() =>
            collection.findOne({ _id: { $eq: key } }, { projection: { [NAMESPACE_PATH]: 1 } }),
          );
          const stored = existing?.metadata;
          const kept = isPlainObject(stored) ? stored.namespace : undefined;
          const row = toStored(
            documents[i].pageContent,
            documents[i].metadata,
            vectors[i],
            textKey,
            embeddingKey,
            typeof kept === 'string' ? kept : namespace,
          );
          await guarded(() =>
            collection.replaceOne({ _id: { $eq: key } }, { _id: key, ...row }, { upsert: true }),
          );
        }
      },
      async search(vector, k, filter) {
        await ensureIndex();
        const limit = Math.max(1, Math.trunc(k));
        const merged = mergeFilters(ctx, itemIndex, preFilter, filter, namespace);
        const pipeline: Document[] = [
          {
            $vectorSearch: {
              index: indexName,
              path: embeddingKey,
              queryVector: vector,
              numCandidates: Math.min(10 * limit, MAX_CANDIDATES),
              limit,
              ...(merged ? { filter: merged } : {}),
            },
          },
          { $set: { score: { $meta: 'vectorSearchScore' } } },
          ...postStages,
        ];
        const rows = await guarded(() =>
          collection.aggregate(pipeline, { maxTimeMS: AGGREGATE_MAX_MS }).toArray(),
        );
        return rows.map((row) => fromStored(row, textKey, embeddingKey));
      },
    };
    return { backend, close: release };
  },
});
