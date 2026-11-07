/**
 * Databricks Lakebase Data API client (PostgREST over https on the `databricksOAuth2Api` credential): the
 * table locators with their list searches, the table URL and the one request helper. Used by nodes-ai's
 * Lakebase Chat Memory (P5-51) and by Phase 7's Databricks node through `@workflow/nodes-base/utils/databricks-lakebase`.
 *
 * Calls: https host only. The control plane (list searches, the endpoint lookup) is the credential's own host. The
 * Data API is the read-write compute endpoint of the chosen project and branch, as in n8n:
 * `https://<endpoint host>/api/2.0/workspace/<workspace id>/rest/<database>/<schema>/<table>`, so two branches
 * never share data. The endpoint host must be a Databricks host of the credential's own domain. `Prefer: count=exact`
 * with `Content-Range` paging up to LAKEBASE_PAGE_SIZE x LAKEBASE_MAX_PAGES rows. The control-plane paths
 * (`/api/2.0/postgres/...`) are written from Databricks' public API reference and are not confirmed against a live workspace.
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
  // the token goes to the credential's workspace or to a compute endpoint of its domain, never to a URL a caller built from other text
  if (!String(request.url).startsWith(`${host}/`) && !onEndpointHost(host, String(request.url))) {
    throw new Error('A Lakebase request must go to the host of the Databricks credential');
  }
  return (await ctx.helpers.httpRequestWithAuthentication<T>(
    'databricksOAuth2Api',
    { ...request, followRedirects: false },
    itemIndex,
  )) as T;
}

const HOSTNAME = /^[A-Za-z0-9.-]+$/;

/** the last two labels of a host name, which is the Databricks domain (`cloud.databricks.com`, `azuredatabricks.net`) */
function domainOf(hostname: string): string | undefined {
  const labels = hostname.toLowerCase().split('.');
  const last = labels.at(-1) ?? '';
  // a plain name of at least three labels, not an IP address
  if (labels.length < 3 || labels.some((l) => !l) || !HOSTNAME.test(hostname) || !/[a-z]/.test(last))
    return undefined;
  return labels.slice(-2).join('.');
}

/** true when `url` is an https URL on a host that shares the Databricks domain of the credential host (a compute endpoint) */
function onEndpointHost(host: string, url: string): boolean {
  try {
    const own = new URL(host);
    const target = new URL(url);
    const domain = domainOf(own.hostname);
    return (
      target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      target.port === own.port &&
      domain !== undefined &&
      domainOf(target.hostname) === domain
    );
  } catch {
    return false;
  }
}

const ID_PART = /^[A-Za-z0-9_.-]{1,128}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function idPart(label: string, value: string): string {
  // a name made only of dots would move the path (`..`)
  if (!ID_PART.test(value) || /^\.+$/.test(value))
    throw new Error(`The Lakebase ${label} is not a valid name`);
  return value;
}

/**
 * The Data API base of one branch, `https://<read-write endpoint host>/api/2.0/workspace/<workspace id>/rest`: the
 * endpoint host comes from the branch's compute endpoints, the workspace id from the `x-databricks-org-id` header.
 */
async function restBase(
  ctx: LakebaseContext,
  itemIndex: number,
  host: string,
  project: string,
  branch: string,
): Promise<string> {
  const res = await lakebaseRequest<
    HttpFullResponse<{
      endpoints?: Array<{ status?: { endpoint_type?: string; hosts?: { host?: string } } }>;
    }>
  >(ctx, itemIndex, {
    method: 'GET',
    url: `${host}/api/2.0/postgres/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}/endpoints`,
    headers: { accept: 'application/json' },
    returnFullResponse: true,
  });
  const endpointHost = res?.body?.endpoints?.find(
    (e) => e.status?.endpoint_type === 'ENDPOINT_TYPE_READ_WRITE',
  )?.status?.hosts?.host;
  if (!endpointHost) throw new Error('The branch has no read-write compute endpoint');
  const base = `https://${endpointHost}`;
  // the bearer token goes to this host, so it must be a plain host name of the credential's Databricks domain
  if (typeof endpointHost !== 'string' || !HOSTNAME.test(endpointHost) || !onEndpointHost(host, `${base}/`)) {
    throw new Error('Databricks returned an unexpected Lakebase endpoint host');
  }
  const id = headerOf(res?.headers, 'x-databricks-org-id');
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id))
    throw new Error('Could not read the workspace ID from Databricks');
  return `${base}/api/2.0/workspace/${id}/rest`;
}

/** the Data API URL of one table: project and branch pick the compute endpoint, so branches never share data */
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
  const project = idPart('project', target.project);
  const branch = idPart('branch', target.branch);
  const database = encodeURIComponent(idPart('database', target.database));
  const schema = encodeURIComponent(idPart('schema', target.schema));
  const host = await credentialHost(ctx, itemIndex);
  const base = await restBase(ctx, itemIndex, host, project, branch);
  return `${base}/${database}/${schema}/${encodeURIComponent(target.table)}`;
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
