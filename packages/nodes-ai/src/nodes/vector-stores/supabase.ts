/**
 * Supabase Vector Store. Plain PostgREST over HTTP, no vendor SDK. The table follows the standard
 * Supabase pgvector layout (id, content, metadata jsonb, embedding vector) with a SQL function that takes
 * query_embedding, match_count and filter and returns rows with a similarity.
 */
import type {
  BaseContext,
  DataObject,
  HttpFullResponse,
  ListSearchResult,
  LoadOptionsContext,
  NodeProperty,
} from '@workflow/workflow';
import { isResourceLocatorValue, NodeOperationError } from '@workflow/workflow';
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type VectorBackend,
} from './vector-store-factory';

const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const DEFAULT_QUERY_NAME = 'match_documents';
/** rows per insert request */
const INSERT_BATCH = 500;

function locatorText(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** `https://project.supabase.co/rest/v1`; anything but a plain https project address is refused. */
function restBase(ctx: BaseContext | LoadOptionsContext, creds: DataObject, itemIndex: number): string {
  const refuse = (): never => {
    throw new NodeOperationError(ctx.getNode(), 'The Supabase host must be an https address', {
      itemIndex,
      description: 'Use the project URL, for example https://your-project.supabase.co',
    });
  };
  let url: URL;
  try {
    url = new URL(String(creds.host ?? '').trim());
  } catch {
    return refuse();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return refuse();
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/rest/v1`;
}

async function supabaseTableSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const creds = await ctx.getCredentials('supabaseApi', 0);
  const base = restBase(ctx, creds, 0);
  const root = (await ctx.helpers.httpRequestWithAuthentication(
    'supabaseApi',
    { url: `${base}/`, followRedirects: false },
    0,
  )) as { definitions?: DataObject; paths?: DataObject };
  const names = new Set<string>(Object.keys(root?.definitions ?? {}));
  if (!names.size) {
    for (const path of Object.keys(root?.paths ?? {})) {
      const name = path.replace(/^\//, '');
      if (name && !name.startsWith('rpc/')) names.add(name);
    }
  }
  const needle = (filter ?? '').trim().toLowerCase();
  const found = [...names]
    .filter((name) => SQL_NAME.test(name) && (!needle || name.toLowerCase().includes(needle)))
    .sort((a, b) => a.localeCompare(b));
  return { results: found.map((name) => ({ name, value: name })) };
}

const queryNameOption: NodeProperty = {
  displayName: 'Query Name',
  name: 'queryName',
  type: 'string',
  default: DEFAULT_QUERY_NAME,
  description: 'SQL function that searches the table: takes query_embedding, match_count and filter',
};

export const VectorStoreSupabaseNode = createVectorStoreNode({
  name: 'ai.vectorStoreSupabase',
  displayName: 'Supabase Vector Store',
  description: 'Stores documents in a Supabase table with pgvector and searches them by similarity',
  icon: 'simple:supabase',
  credentials: [{ name: 'supabaseApi', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'metadata',
  properties: [
    {
      displayName: 'Table Name',
      name: 'tableName',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'The table must exist; this node never creates one',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a table...',
          typeOptions: { searchListMethod: 'supabaseTableSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'Table name' },
      ],
    },
  ],
  insertOptions: [queryNameOption],
  retrieveOptions: [queryNameOption],
  methods: { listSearch: { supabaseTableSearch } },
  async open(ctx, itemIndex) {
    const table = locatorText(ctx.getNodeParameter('tableName', itemIndex, ''));
    if (!SQL_NAME.test(table)) {
      throw new NodeOperationError(ctx.getNode(), 'Enter a valid table name', {
        itemIndex,
        description: 'Letters, digits and "_", not starting with a digit, up to 63 characters.',
      });
    }
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const queryName = String(options.queryName ?? '').trim() || DEFAULT_QUERY_NAME;
    if (!SQL_NAME.test(queryName)) {
      throw new NodeOperationError(ctx.getNode(), 'Enter a valid query name', {
        itemIndex,
        description: 'Letters, digits and "_", not starting with a digit, up to 63 characters.',
      });
    }
    const creds = await ctx.getCredentials('supabaseApi', itemIndex);
    const base = restBase(ctx, creds, itemIndex);

    const call = async (
      path: string,
      request: { body: unknown; headers?: Record<string, string>; qs?: Record<string, string> },
      missing: string,
    ): Promise<unknown> => {
      let response: HttpFullResponse<unknown>;
      try {
        response = (await ctx.helpers.httpRequestWithAuthentication(
          'supabaseApi',
          {
            url: `${base}${path}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...request.headers },
            ...(request.qs ? { qs: request.qs } : {}),
            body: request.body,
            followRedirects: false,
            ignoreHttpStatusErrors: true,
            returnFullResponse: true,
          },
          itemIndex,
        )) as HttpFullResponse<unknown>;
      } catch (error) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Supabase request failed: ${redactSecrets(errorMessage(error))}`,
          { itemIndex },
        );
      }
      const status = response.statusCode;
      if (status === 404) {
        throw new NodeOperationError(ctx.getNode(), missing, {
          itemIndex,
          description: 'Please check that the table exists in your vector store',
        });
      }
      if (status >= 300 && status < 400) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Supabase answered with a redirect (status ${status}); it was not followed`,
          { itemIndex },
        );
      }
      if (status < 200 || status >= 300) {
        const body = response.body;
        const detail = redactSecrets(
          typeof body === 'string' ? body : String((body as DataObject | undefined)?.message ?? ''),
        ).slice(0, 300);
        throw new NodeOperationError(ctx.getNode(), `Supabase request failed with status ${status}`, {
          itemIndex,
          description: detail,
        });
      }
      return response.body;
    };

    const backend: VectorBackend = {
      async add(documents, vectors, ids) {
        for (let start = 0; start < documents.length; start += INSERT_BATCH) {
          const rows = documents.slice(start, start + INSERT_BATCH).map((d, i) => ({
            ...(ids ? { id: ids[start + i] } : {}),
            content: d.pageContent,
            metadata: d.metadata ?? {},
            embedding: JSON.stringify(vectors[start + i]),
          }));
          await call(
            `/${table}`,
            ids
              ? {
                  body: rows,
                  qs: { on_conflict: 'id' },
                  headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                }
              : { body: rows, headers: { Prefer: 'return=minimal' } },
            `Table ${table} not found`,
          );
        }
      },
      async search(vector, k, filter) {
        const rows = await call(
          `/rpc/${queryName}`,
          { body: { query_embedding: vector, match_count: k, filter: filter ?? {} } },
          `Query function ${queryName} not found`,
        );
        return (Array.isArray(rows) ? (rows as DataObject[]) : []).map((row) => ({
          document: {
            pageContent: String(row.content ?? ''),
            metadata: (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as DataObject,
          },
          score: Number(row.similarity ?? 0),
        }));
      },
    };
    return { backend };
  },
});
