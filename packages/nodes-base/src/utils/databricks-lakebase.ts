/**
 * Databricks Lakebase Data API client (PostgREST over https on the `databricksOAuth2Api` credential): the
 * table locators with their list searches, the table URL and the one request helper. Used by nodes-ai's
 * Lakebase Chat Memory (P5-51) and by Phase 7's Databricks node through `@workflow/nodes-base/utils/databricks-lakebase`.
 *
 * C0 stub: the constants and the locator descriptions are final; L20 (P5-51) writes the function bodies
 * (https host only, `Prefer: count=exact`, `Content-Range` paging to LAKEBASE_PAGE_SIZE x LAKEBASE_MAX_PAGES rows).
 */
import type {
  BaseContext,
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
export function lakebaseHttpsHost(_host: string): string {
  throw new Error('not implemented (L20)');
}

/** the Data API URL of one table for the credential of item `itemIndex` */
export async function lakebaseTableUrl(
  _ctx: LakebaseContext,
  _itemIndex: number,
  _target: LakebaseTarget,
): Promise<string> {
  throw new Error('not implemented (L20)');
}

/** one authenticated Data API request on `databricksOAuth2Api` through the guarded HTTP helpers */
export async function lakebaseRequest<T>(
  _ctx: LakebaseContext,
  _itemIndex: number,
  _request: HttpRequestOptions,
): Promise<T> {
  throw new Error('not implemented (L20)');
}

const notImplemented = async (_ctx: LoadOptionsContext, _filter?: string): Promise<ListSearchResult> => {
  throw new Error('not implemented (L20)');
};

/** the list searches of `lakebaseLocatorProperties`; each reads the locators before it with getCurrentNodeParameter */
export const lakebaseListSearch: Record<
  LakebaseLevel,
  (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult>
> = {
  projects: notImplemented,
  branches: notImplemented,
  databases: notImplemented,
  schemas: notImplemented,
};
