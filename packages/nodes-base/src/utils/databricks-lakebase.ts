/**
 * Databricks Lakebase Data API client (PostgREST over https on the `databricksOAuth2Api` credential): the
 * table locators with their list searches, the table URL and the one request helper. Used by nodes-ai's
 * Lakebase Chat Memory (P5-51) and by Phase 7's Databricks node through `@workflow/nodes-base/utils/databricks-lakebase`.
 *
 * Calls: https host only, every request on the credential's own host, `Prefer: count=exact` with `Content-Range`
 * paging up to LAKEBASE_PAGE_SIZE x LAKEBASE_MAX_PAGES rows. The control-plane paths of the list searches
 * (`/api/2.0/postgres/...`) and the workspace id lookup (`/api/2.1/unity-catalog/current-metastore-assignment`)
 * are written from Databricks' public API reference and are not confirmed against a live workspace.
 */
import type {
  BaseContext,
  HttpFullResponse,
  HttpRequestOptions,
  ListSearchResult,
  LoadOptionsContext,
  NodeProperty,
} from '@workflow/workflow';

/** where a Lakebase table lives: the four locator values plus the table name */
export interface LakebaseTarget {
  project: string;
  branch: string;
  database: string;
  schema: string;
  table: string;
}

/** rows per Data API page */
export const LAKEBASE_PAGE_SIZE = 1000;
/** pages read at most, so one read never holds more than LAKEBASE_PAGE_SIZE x LAKEBASE_MAX_PAGES rows */
export const LAKEBASE_MAX_PAGES = 100;

/** the context a Lakebase call needs: an execute, supply-data or load-options context all fit */
export type LakebaseContext = Pick<BaseContext, 'helpers' | 'getCredentials'>;

type LakebaseLevel = 'projects' | 'branches' | 'databases' | 'schemas';

/** one resource locator: pick from a list (the list search named like the key of `lakebaseListSearch`) or type the id */
function lakebaseLocator(
  name: keyof Omit<LakebaseTarget, 'table'>,
  displayName: string,
  list: LakebaseLevel,
): NodeProperty {
  return {
    displayName,
    name,
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: '' },
    required: true,
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: `Select a ${displayName.toLowerCase()}...`,
        typeOptions: { searchListMethod: list, searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: `${name}-id` },
    ],
  };
}

/**
 * Project, branch, database and schema locators, in that order (each list depends on the ones before it).
 * Parameter names equal the `LakebaseTarget` fields; each list mode's `searchListMethod` equals its key in
 * `lakebaseListSearch`, so a node can set `methods: { listSearch: { ...lakebaseListSearch } }`.
 */
export const lakebaseLocatorProperties: NodeProperty[] = [
  lakebaseLocator('project', 'Project', 'projects'),
  lakebaseLocator('branch', 'Branch', 'branches'),
  lakebaseLocator('database', 'Database', 'databases'),
  lakebaseLocator('schema', 'Schema', 'schemas'),
];

/** the credential host as an https origin; anything else (http, credentials, query, fragment) is refused */
export function lakebaseHttpsHost(host: string): string {
  const base = String(host ?? '')
    .trim()
    .replace(/\/+$/, '');
  let url: URL | undefined;
  try {
    url = new URL(base);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The Databricks host must be an https URL, such as https://<workspace>.cloud.databricks.com');
  }
  return base;
}

async function credentialHost(ctx: LakebaseContext, itemIndex: number): Promise<string> {
  const creds = await ctx.getCredentials('databricksOAuth2Api', itemIndex);
  return lakebaseHttpsHost(String(creds.host ?? ''));
}

/** one authenticated Data API request on `databricksOAuth2Api` through the guarded HTTP helpers */
export async function lakebaseRequest<T>(
  ctx: LakebaseContext,
  itemIndex: number,
  request: HttpRequestOptions,
): Promise<T> {
  const host = await credentialHost(ctx, itemIndex);
  // the token goes to the credential's workspace only, never to a URL a caller built from other text
  if (!String(request.url).startsWith(`${host}/`)) {
    throw new Error('A Lakebase request must go to the host of the Databricks credential');
  }
  return (await ctx.helpers.httpRequestWithAuthentication<T>(
    'databricksOAuth2Api',
    { ...request, followRedirects: false },
    itemIndex,
  )) as T;
}

const ID_PART = /^[A-Za-z0-9_.-]{1,128}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function idPart(label: string, value: string): string {
  if (!ID_PART.test(value)) throw new Error(`The Lakebase ${label} is not a valid name`);
  return value;
}

/** the numeric id of the credential's workspace, which the Data API path holds */
async function workspaceId(ctx: LakebaseContext, itemIndex: number, host: string): Promise<string> {
  const res = await lakebaseRequest<{ workspace_id?: unknown }>(ctx, itemIndex, {
    method: 'GET',
    url: `${host}/api/2.1/unity-catalog/current-metastore-assignment`,
  });
  const id = res?.workspace_id;
  if ((typeof id !== 'number' && typeof id !== 'string') || !/^\d{1,20}$/.test(String(id))) {
    throw new Error('Could not read the workspace id of the Databricks host');
  }
  return String(id);
}

/** the Data API URL of one table for the credential of item `itemIndex` */
export async function lakebaseTableUrl(
  ctx: LakebaseContext,
  itemIndex: number,
  target: LakebaseTarget,
): Promise<string> {
  if (!TABLE_NAME.test(target.table)) {
    throw new Error(
      'The Lakebase table name may hold letters, digits and underscores, and may not start with a digit',
    );
  }
  const database = encodeURIComponent(idPart('database', target.database));
  const schema = encodeURIComponent(idPart('schema', target.schema));
  const host = await credentialHost(ctx, itemIndex);
  const id = await workspaceId(ctx, itemIndex, host);
  return `${host}/api/2.0/workspace/${id}/rest/${database}/${schema}/${encodeURIComponent(target.table)}`;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/**
 * Every row of a table read that matches `qs`, page by page (`Prefer: count=exact`, `Content-Range`), at most
 * LAKEBASE_PAGE_SIZE x LAKEBASE_MAX_PAGES rows. `truncated` is true when more rows were left behind.
 */
export async function lakebaseSelectAll<Row>(
  ctx: LakebaseContext,
  itemIndex: number,
  tableUrl: string,
  qs: Record<string, string>,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let page = 0; page < LAKEBASE_MAX_PAGES; page++) {
    const res = await lakebaseRequest<HttpFullResponse<Row[]>>(ctx, itemIndex, {
      method: 'GET',
      url: tableUrl,
      qs: { ...qs, limit: LAKEBASE_PAGE_SIZE, offset: page * LAKEBASE_PAGE_SIZE },
      headers: { prefer: 'count=exact', accept: 'application/json' },
      returnFullResponse: true,
    });
    const batch = Array.isArray(res?.body) ? res.body : [];
    rows.push(...batch);
    const range = /^(?:\d+-\d+|\*)\/(\d+|\*)$/.exec(String(headerOf(res?.headers, 'content-range') ?? ''));
    const total = range && range[1] !== '*' ? Number(range[1]) : undefined;
    const done = total !== undefined ? rows.length >= total : batch.length < LAKEBASE_PAGE_SIZE;
    if (done || batch.length === 0) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** a locator value: the plain text, or the `value` of a `{ __rl }` object */
function locatorValue(raw: unknown): string {
  const value = raw && typeof raw === 'object' ? (raw as { value?: unknown }).value : raw;
  return typeof value === 'string' ? value.trim() : '';
}

/** the id after the last slash of a resource name such as `projects/p1/branches/main` */
function lastSegment(name: unknown): string {
  return typeof name === 'string' ? (name.split('/').pop() ?? '') : '';
}

type PagedList = Record<string, unknown> & { next_page_token?: unknown };

/** one list search: a GET on the control plane, rows under `key`, shown with their display name when they have one */
async function listSearch(
  ctx: LoadOptionsContext,
  path: string,
  key: string,
  filter: string | undefined,
  token?: string,
): Promise<ListSearchResult> {
  const host = await credentialHost(ctx, 0);
  const res = await lakebaseRequest<PagedList>(ctx, 0, {
    method: 'GET',
    url: `${host}${path}`,
    ...(token ? { qs: { page_token: token } } : {}),
  });
  const list = Array.isArray(res?.[key]) ? (res[key] as Array<Record<string, unknown>>) : [];
  const wanted = (filter ?? '').trim().toLowerCase();
  const results = list
    .map((row) => {
      const value = lastSegment(row.name ?? row.uid);
      const status = row.status as { display_name?: unknown; postgres_database?: unknown } | undefined;
      const label = status?.display_name ?? status?.postgres_database;
      return { name: typeof label === 'string' && label ? label : value, value };
    })
    .filter(
      (r) => r.value && (!wanted || r.name.toLowerCase().includes(wanted) || r.value.toLowerCase().includes(wanted)),
    );
  const next = typeof res?.next_page_token === 'string' && res.next_page_token ? res.next_page_token : undefined;
  return { results, ...(next ? { paginationToken: next } : {}) };
}

/** the selected locator before this one, as a path-safe id */
function selected(ctx: LoadOptionsContext, name: string): string {
  const value = locatorValue(ctx.getCurrentNodeParameter(name));
  if (!value) throw new Error(`Select a ${name} first`);
  return encodeURIComponent(idPart(name, value));
}

/** the list searches of `lakebaseLocatorProperties`; each reads the locators before it with getCurrentNodeParameter */
export const lakebaseListSearch: Record<
  LakebaseLevel,
  (ctx: LoadOptionsContext, filter?: string, paginationToken?: string) => Promise<ListSearchResult>
> = {
  projects: async (ctx, filter, token) => listSearch(ctx, '/api/2.0/postgres/projects', 'projects', filter, token),
  branches: async (ctx, filter, token) =>
    listSearch(ctx, `/api/2.0/postgres/projects/${selected(ctx, 'project')}/branches`, 'branches', filter, token),
  databases: async (ctx, filter, token) =>
    listSearch(
      ctx,
      `/api/2.0/postgres/projects/${selected(ctx, 'project')}/branches/${selected(ctx, 'branch')}/databases`,
      'databases',
      filter,
      token,
    ),
  // the Data API has no call that lists schemas; `public` is the one every database has, any other is typed by ID
  schemas: async (ctx, filter) => {
    selected(ctx, 'database');
    const wanted = (filter ?? '').trim().toLowerCase();
    return { results: 'public'.includes(wanted) ? [{ name: 'public', value: 'public' }] : [] };
  },
};
