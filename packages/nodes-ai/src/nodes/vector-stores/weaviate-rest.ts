/**
 * Weaviate REST Search API (`POST /v1/search/{collection}/near-vector` and `/hybrid`), read from the
 * OpenAPI spec of Weaviate v1.40.4 on 2026-11-07. The body is JSON built from the same validated
 * structure as the GraphQL query: the `where` filter is rebuilt from `parseWhereFilter`'s output, so no
 * key the user typed reaches the body, and the tenant and limits come only from the node's options.
 *
 * Which servers have it (tags of weaviate/weaviate, checked 2026-11-07):
 * - v1.39.1 to v1.39.6: the routes exist behind `EXPERIMENTAL_REST_SEARCH_ENABLED` (422 when off);
 * - v1.39.7: on by default, but no `near-vector` route (404);
 * - v1.39.8 and v1.40.0: `near-vector`;
 * - v1.39.15 and v1.40.4: `hybrid` takes the caller's `vector`. Before that the field is ignored
 *   (unknown fields are), so Weaviate would vectorize the query itself: a hybrid search with our
 *   vector stays on GraphQL there.
 */
import {
  ADDITIONAL_FIELDS,
  assertVector,
  type FusionType,
  type GetQuery,
  isFusionType,
  isUnitOperator,
  positiveInteger,
  WEAVIATE_CLASS_NAME,
  WEAVIATE_PROPERTY_NAME,
  WEAVIATE_QUERY_PROPERTY,
  WeaviateQueryError,
  type WeaviateWhere,
  type WhereValue,
} from './weaviate-graphql';

/** `major.minor.patch` */
export type WeaviateVersion = [number, number, number];

/** The version from `/v1/meta`'s `version` (`1.40.4`, `1.41.0-rc.1`); null when unreadable. */
export function parseWeaviateVersion(raw: unknown): WeaviateVersion | null {
  const match = typeof raw === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim()) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(version: WeaviateVersion, min: WeaviateVersion): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

/** REST search is on by default from v1.39.7; an older server is searched over GraphQL. */
export function hasRestSearch(version: WeaviateVersion): boolean {
  return atLeast(version, [1, 39, 7]);
}

/** Whether `/hybrid` accepts the caller's `vector`: v1.39.15 on the 1.39 line, v1.40.4 on, later lines. */
export function hasRestHybridVector(version: WeaviateVersion | null): boolean {
  if (!version) return false;
  if (version[0] === 1 && version[1] === 39) return version[2] >= 15;
  if (version[0] === 1 && version[1] === 40) return version[2] >= 4;
  return atLeast(version, [1, 41, 0]);
}

const REST_FUSION: Record<FusionType, string> = {
  RelativeScore: 'relativeScore',
  Ranked: 'ranked',
};

function restValue(value: WhereValue): Record<string, unknown> {
  switch (value.kind) {
    case 'valueGeoRange':
      return {
        valueGeoRange: {
          geoCoordinates: { latitude: value.latitude, longitude: value.longitude },
          distance: { max: value.distance },
        },
      };
    case 'valueText':
      return Array.isArray(value.value) ? { valueTextArray: [...value.value] } : { valueText: value.value };
    case 'valueNumber':
      if (!Number.isFinite(value.value)) {
        throw new WeaviateQueryError('Numbers in a Weaviate query must be finite');
      }
      return { valueNumber: value.value };
    case 'valueBoolean':
      return { valueBoolean: value.value };
  }
}

/** The REST `where` JSON of a validated filter: only the fields we write, nothing copied. */
export function restWhere(where: WeaviateWhere): Record<string, unknown> {
  if (where.operator === 'And' || where.operator === 'Or') {
    const operands = (where as { operands: WeaviateWhere[] }).operands;
    return { operator: where.operator, operands: operands.map(restWhere) };
  }
  const unit = where as { operator: string; path: string; value: WhereValue };
  if (!WEAVIATE_PROPERTY_NAME.test(unit.path) || !isUnitOperator(unit.operator)) {
    throw new WeaviateQueryError('Invalid search filter');
  }
  return { path: [unit.path], operator: unit.operator, ...restValue(unit.value) };
}

export interface RestSearchRequest {
  /** path after the base URL, collection name encoded */
  path: string;
  body: Record<string, unknown>;
}

/** The REST search request for a `GetQuery`: `/near-vector` or `/hybrid`. */
export function buildRestSearch(query: GetQuery): RestSearchRequest {
  if (!WEAVIATE_CLASS_NAME.test(query.className)) {
    throw new WeaviateQueryError(`Invalid collection name: ${query.className.slice(0, 200)}`);
  }
  if (!query.properties.length) throw new WeaviateQueryError('A Weaviate query needs at least one property');
  for (const p of query.properties) {
    if (!WEAVIATE_PROPERTY_NAME.test(p))
      throw new WeaviateQueryError(`Invalid property name: ${p.slice(0, 200)}`);
  }
  const metadata = query.additional.filter((a) => a !== 'id');
  for (const a of metadata) {
    if (!ADDITIONAL_FIELDS.has(a)) throw new WeaviateQueryError(`Unsupported additional field: ${a}`);
  }
  const common: Record<string, unknown> = {
    limit: positiveInteger(query.limit, 'Limit'),
    returnProperties: [...query.properties],
    returnMetadata: metadata,
  };
  if (query.tenant !== undefined) common.tenant = String(query.tenant);
  if (query.where) common.where = restWhere(query.where);
  const collection = encodeURIComponent(query.className);

  if (query.hybrid) {
    const hybrid = query.hybrid;
    const body: Record<string, unknown> = { query: String(hybrid.query) };
    // at alpha 0 Weaviate skips the vector part and refuses a vector or a vector distance with it
    const vectorPart = hybrid.alpha !== 0;
    if (vectorPart) body.vector = [...assertVector(hybrid.vector)];
    if (hybrid.alpha !== undefined) {
      if (!Number.isFinite(hybrid.alpha)) throw new WeaviateQueryError('Alpha must be a number from 0 to 1');
      body.alpha = hybrid.alpha;
    }
    if (hybrid.properties?.length) {
      for (const p of hybrid.properties) {
        if (!WEAVIATE_QUERY_PROPERTY.test(p))
          throw new WeaviateQueryError(`Invalid query property: ${p.slice(0, 200)}`);
      }
      body.queryProperties = [...hybrid.properties];
    }
    if (hybrid.fusionType !== undefined) {
      if (!isFusionType(hybrid.fusionType)) {
        throw new WeaviateQueryError(`Unsupported fusion type: ${String(hybrid.fusionType).slice(0, 200)}`);
      }
      body.fusionType = REST_FUSION[hybrid.fusionType];
    }
    if (vectorPart && hybrid.maxVectorDistance !== undefined) {
      if (!Number.isFinite(hybrid.maxVectorDistance)) {
        throw new WeaviateQueryError('Max Vector Distance must be a number of 0 or more');
      }
      body.maxVectorDistance = hybrid.maxVectorDistance;
    }
    if (query.autocut !== undefined) body.autoLimit = positiveInteger(query.autocut, 'Auto Cut Limit');
    return { path: `/v1/search/${collection}/hybrid`, body: { ...body, ...common } };
  }
  if (!query.nearVector) throw new WeaviateQueryError('A Weaviate query needs a vector');
  const body: Record<string, unknown> = { vector: [...assertVector(query.nearVector)], ...common };
  if (query.autocut !== undefined) body.autoLimit = positiveInteger(query.autocut, 'Auto Cut Limit');
  return { path: `/v1/search/${collection}/near-vector`, body };
}

/** REST search hits as GraphQL `Get` rows: the properties, and the metadata under `_additional`. */
export function restRows(body: unknown): Array<Record<string, unknown>> | undefined {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return undefined;
  return results.map((hit) => {
    const h = (hit ?? {}) as { properties?: unknown; metadata?: unknown };
    const properties =
      h.properties && typeof h.properties === 'object' ? (h.properties as Record<string, unknown>) : {};
    const metadata = h.metadata && typeof h.metadata === 'object' ? h.metadata : {};
    return { ...properties, _additional: metadata };
  });
}
