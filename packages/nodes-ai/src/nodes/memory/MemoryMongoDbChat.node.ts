/**
 * MongoDB Chat Memory: chat history in a MongoDB collection, one document per message
 * `{ tenantId, sessionId, message, createdAt }`, read in `_id` order. Every query holds the tenant
 * and a string session id; the client goes through the SSRF guard of shared/mongo.ts.
 */
import {
  type AiChatMessage,
  type DataObject,
  NodeOperationError,
  type NodeType,
  type SupplyDataContext,
} from '@workflow/workflow';
import type { AnyBulkWriteOperation, Collection, MongoClient } from 'mongodb';
import type { SessionMemory } from '../../shared/ai-inputs';
import { mongoDbConnectionTest, sanitizeMongoError, sharedMongo } from '../../shared/mongo';
import {
  fromStoredMessage,
  logged,
  memoryDescription,
  toStoredMessage,
  windowProperty,
  windowSize,
} from './memory-shared';
import { readSessionKey, sessionProperties } from './session';

const DEFAULT_COLLECTION = 'ai_chat_histories';

interface ChatDocument {
  tenantId: string;
  sessionId: string;
  message: { role: string; content: string; hideFromUI?: true };
  createdAt: Date;
}

/** collections whose tenant and session index exists, per client */
const indexed = new WeakMap<MongoClient, Set<string>>();

function collectionName(ctx: SupplyDataContext, itemIndex: number): string {
  const name =
    String(ctx.getNodeParameter('collectionName', itemIndex, DEFAULT_COLLECTION) ?? '').trim() ||
    DEFAULT_COLLECTION;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(name) || name.startsWith('system.')) {
    throw new NodeOperationError(ctx.getNode(), `Invalid collection name "${name.slice(0, 120)}"`, {
      itemIndex,
      description:
        'Use letters, digits, underscores, dots and dashes; names starting with "system." are reserved.',
      parameter: 'collectionName',
    });
  }
  return name;
}

function databaseParameter(ctx: SupplyDataContext, itemIndex: number): string {
  const name = String(ctx.getNodeParameter('databaseName', itemIndex, '') ?? '').trim();
  if (name && !/^[A-Za-z0-9_-]{1,63}$/.test(name)) {
    throw new NodeOperationError(ctx.getNode(), `Invalid database name "${name.slice(0, 64)}"`, {
      itemIndex,
      description: 'Use letters, digits, underscores and dashes, at most 63 characters.',
      parameter: 'databaseName',
    });
  }
  return name;
}

/** the session id of a call: text only, so an object can never become a query operator */
function sessionFilter(tenantId: string, sessionId: unknown): { tenantId: string; sessionId: string } {
  if (typeof sessionId !== 'string') throw new Error('Invalid session ID');
  return { tenantId, sessionId };
}

export const MemoryMongoDbChatNode: NodeType = {
  description: memoryDescription(
    {
      name: 'ai.memoryMongoDbChat',
      displayName: 'MongoDB Chat Memory',
      description: 'Stores chat history in a MongoDB collection',
      icon: 'simple:mongodb',
      credentials: [{ name: 'mongoDb', required: true, testedBy: 'mongoDbConnectionTest' }],
    },
    [
      ...sessionProperties,
      {
        displayName: 'Collection Name',
        name: 'collectionName',
        type: 'string',
        default: DEFAULT_COLLECTION,
        description:
          'Created automatically when missing (fields: tenantId, sessionId, message, createdAt, indexed by tenant and session)',
      },
      {
        displayName: 'Database Name',
        name: 'databaseName',
        type: 'string',
        default: '',
        description: 'Leave empty to use the database of the credential',
      },
      windowProperty,
    ],
  ),
  methods: { credentialTest: { mongoDbConnectionTest } },
  async supplyData(ctx, itemIndex) {
    const sessionKey = readSessionKey(ctx, itemIndex);
    const k = windowSize(ctx, itemIndex);
    const collectionParameter = collectionName(ctx, itemIndex);
    const databaseOverride = databaseParameter(ctx, itemIndex);
    const tenantId = ctx.getTenantId();
    const credentials: DataObject = await ctx.getCredentials('mongoDb', itemIndex);
    const { value: handle, release } = await sharedMongo(ctx, itemIndex, 'mongoDb');
    const databaseName = databaseOverride || handle.databaseName;
    if (!databaseName) {
      await release();
      throw new NodeOperationError(
        ctx.getNode(),
        'Database name must be provided either in credentials or in node parameters',
        { itemIndex, parameter: 'databaseName' },
      );
    }
    const collection: Collection<ChatDocument> = handle.client
      .db(databaseName)
      .collection<ChatDocument>(collectionParameter);

    /** runs a database call; any error leaves without the password or the connection string */
    const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        throw sanitizeMongoError(error, credentials);
      }
    };

    try {
      const done = indexed.get(handle.client) ?? new Set<string>();
      indexed.set(handle.client, done);
      const indexKey = `${databaseName}.${collectionParameter}`;
      if (!done.has(indexKey)) {
        await guarded(() => collection.createIndex({ tenantId: 1, sessionId: 1, _id: 1 }));
        done.add(indexKey);
      }
    } catch (error) {
      await release();
      throw error;
    }

    const documents = (sessionId: string, messages: AiChatMessage[]): ChatDocument[] => {
      const filter = sessionFilter(tenantId, sessionId);
      const createdAt = new Date();
      return messages.map((m) => ({ ...filter, message: toStoredMessage(m), createdAt }));
    };
    const read = (docs: ChatDocument[]) =>
      docs.map((d) => fromStoredMessage(d.message)).filter((m): m is AiChatMessage => Boolean(m));

    const memory: SessionMemory = {
      kind: 'memory',
      sessionId: sessionKey,
      load: (sessionId) =>
        guarded(async () => {
          const docs = await collection
            .find(sessionFilter(tenantId, sessionId), { projection: { message: 1 } })
            .sort({ _id: -1 })
            .limit(2 * k)
            .toArray();
          return read(docs.reverse());
        }),
      loadAll: (sessionId) =>
        guarded(async () => {
          const docs = await collection
            .find(sessionFilter(tenantId, sessionId), { projection: { message: 1 } })
            .sort({ _id: 1 })
            .toArray();
          return read(docs);
        }),
      append: (sessionId, messages) =>
        guarded(async () => {
          if (!messages.length) return;
          await collection.insertMany(documents(sessionId, messages), { ordered: true });
        }),
      replace: (sessionId, messages) =>
        guarded(async () => {
          // one ordered bulk write: the delete runs first, then the messages in order
          const operations: AnyBulkWriteOperation<ChatDocument>[] = [
            { deleteMany: { filter: sessionFilter(tenantId, sessionId) } },
            ...documents(sessionId, messages).map((document) => ({ insertOne: { document } })),
          ];
          await collection.bulkWrite(operations, { ordered: true });
        }),
      clear: (sessionId) =>
        guarded(async () => {
          await collection.deleteMany(sessionFilter(tenantId, sessionId));
        }),
    };
    return { response: logged(ctx, memory), closeFunction: release };
  },
};
