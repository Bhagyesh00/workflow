/**
 * Weaviate GraphQL `Get` queries built from a validated structure. Nothing the user types is pasted into
 * the query: class and property names must match Weaviate's name patterns, operators and fusion types
 * come from allow-lists and are written as enum names we hold, and every value (texts, numbers, vectors,
 * tenant, hybrid query) is written with `JSON.stringify`, whose output is a valid GraphQL literal.
 *
 * The search filter JSON is n8n's shape: `{ "AND" | "OR": [unit, ...] }` or one unit
 * `{ "path": ["prop"], "operator": "Equal", "valueString": "x" }` with `valueString`, `valueTextArray`,
 * `valueNumber`, `valueBoolean` or `valueGeoCoordinates`. Operators are matched without case, as n8n does.
 */

/** Weaviate collection (class) names start with an upper-case letter. */
export const WEAVIATE_CLASS_NAME = /^[A-Z][_0-9A-Za-z]*$/;
/** Weaviate property names, also the GraphQL field names we request. */
export const WEAVIATE_PROPERTY_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** A query or filter the builder refuses; the message is shown to the user as is. */
export class WeaviateQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeaviateQueryError';
  }
}

/** composite filters deeper than this are refused (n8n has one level; nesting is allowed up to here) */
const MAX_FILTER_DEPTH = 10;
/** operands per composite filter */
const MAX_OPERANDS = 1000;
/** characters of user text echoed in an error */
const ECHO_LIMIT = 200;

type UnitOperator =
  | 'Equal'
  | 'Like'
  | 'ContainsAny'
  | 'ContainsAll'
  | 'GreaterThan'
  | 'LessThan'
  | 'IsNull'
  | 'WithinGeoRange';

/** lower-case operator text -> the GraphQL enum name */
const OPERATORS: Record<string, UnitOperator> = {
  equal: 'Equal',
  like: 'Like',
  containsany: 'ContainsAny',
  containsall: 'ContainsAll',
  greaterthan: 'GreaterThan',
  lessthan: 'LessThan',
  isnull: 'IsNull',
  withingeorange: 'WithinGeoRange',
};

/** n8n's error wording uses the operator in camel case */
const OPERATOR_LABEL: Record<UnitOperator, string> = {
  Equal: 'equal',
  Like: 'like',
  ContainsAny: 'containsAny',
  ContainsAll: 'containsAll',
  GreaterThan: 'greaterThan',
  LessThan: 'lessThan',
  IsNull: 'isNull',
  WithinGeoRange: 'withinGeoRange',
};

export type WhereValue =
  | { kind: 'valueText'; value: string | string[] }
  | { kind: 'valueNumber'; value: number }
  | { kind: 'valueBoolean'; value: boolean }
  | { kind: 'valueGeoRange'; latitude: number; longitude: number; distance: number };

/** A validated `where` filter. */
export type WeaviateWhere =
  | { operator: 'And' | 'Or'; operands: WeaviateWhere[] }
  | { operator: UnitOperator; path: string; value: WhereValue };

function echo(value: unknown): string {
  return String(value).slice(0, ECHO_LIMIT);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function missing(field: string, operator: UnitOperator): WeaviateQueryError {
  return new WeaviateQueryError(`Missing '${field}' for '${OPERATOR_LABEL[operator]}' operator.`);
}

function propertyPath(raw: unknown): string {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (Array.isArray(raw) && raw.some((p) => typeof p !== 'string')) {
    throw new WeaviateQueryError('Invalid property name in search filter path');
  }
  if (typeof first !== 'string' || !first) {
    throw new WeaviateQueryError('Each search filter needs a "path" with a property name');
  }
  if (!WEAVIATE_PROPERTY_NAME.test(first)) {
    throw new WeaviateQueryError(`Invalid property name in search filter path: ${echo(first)}`);
  }
  return first;
}

function parseUnit(raw: Record<string, unknown>): WeaviateWhere {
  const operatorText = raw.operator;
  const key = typeof operatorText === 'string' ? operatorText.toLowerCase() : '';
  const operator = Object.hasOwn(OPERATORS, key) ? OPERATORS[key] : undefined;
  if (!operator) throw new WeaviateQueryError(`Unsupported operator: ${echo(operatorText)}`);
  const path = propertyPath(raw.path);
  const text = raw.valueString ?? raw.valueText;
  const unit = (value: WhereValue): WeaviateWhere => ({ operator, path, value });
  switch (operator) {
    case 'Equal':
      if (typeof text === 'string') return unit({ kind: 'valueText', value: text });
      if (finite(raw.valueNumber)) return unit({ kind: 'valueNumber', value: raw.valueNumber });
      if (typeof raw.valueBoolean === 'boolean')
        return unit({ kind: 'valueBoolean', value: raw.valueBoolean });
      throw new WeaviateQueryError(`No valid filter value provided for operator: ${operatorText as string}`);
    case 'Like':
      if (typeof text !== 'string') throw missing('valueString', operator);
      return unit({ kind: 'valueText', value: text });
    case 'ContainsAny':
    case 'ContainsAll': {
      const list = raw.valueTextArray;
      if (!Array.isArray(list) || list.some((v) => typeof v !== 'string'))
        throw missing('valueTextArray', operator);
      return unit({ kind: 'valueText', value: list as string[] });
    }
    case 'GreaterThan':
    case 'LessThan':
      if (!finite(raw.valueNumber)) throw missing('valueNumber', operator);
      return unit({ kind: 'valueNumber', value: raw.valueNumber });
    case 'IsNull':
      if (typeof raw.valueBoolean !== 'boolean') throw missing('valueBoolean', operator);
      return unit({ kind: 'valueBoolean', value: raw.valueBoolean });
    case 'WithinGeoRange': {
      const geo = raw.valueGeoCoordinates;
      if (!isObject(geo) || !finite(geo.latitude) || !finite(geo.longitude) || !finite(geo.distance)) {
        throw missing('valueGeoCoordinates', operator);
      }
      return unit({
        kind: 'valueGeoRange',
        latitude: geo.latitude,
        longitude: geo.longitude,
        distance: geo.distance,
      });
    }
  }
}

function parseNode(raw: unknown, depth: number): WeaviateWhere {
  if (!isObject(raw)) throw new WeaviateQueryError('Each search filter must be a JSON object');
  const composite = 'AND' in raw ? 'AND' : 'OR' in raw ? 'OR' : undefined;
  if (!composite) return parseUnit(raw);
  if (depth >= MAX_FILTER_DEPTH) throw new WeaviateQueryError('The search filter is nested too deeply');
  const list = raw[composite];
  if (!Array.isArray(list) || !list.length) {
    throw new WeaviateQueryError(`"${composite}" in the search filter must be a non-empty list of filters`);
  }
  if (list.length > MAX_OPERANDS) {
    throw new WeaviateQueryError(
      `"${composite}" in the search filter holds more than ${MAX_OPERANDS} filters`,
    );
  }
  return {
    operator: composite === 'AND' ? 'And' : 'Or',
    operands: list.map((entry) => parseNode(entry, depth + 1)),
  };
}

/** Validates n8n's search filter JSON into a `where` structure; throws `WeaviateQueryError`. */
export function parseWhereFilter(raw: unknown): WeaviateWhere {
  return parseNode(raw, 0);
}

function literal(value: string | number | boolean | string[]): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new WeaviateQueryError('Numbers in a Weaviate query must be finite');
  }
  return JSON.stringify(value);
}

function renderValue(value: WhereValue): string {
  if (value.kind === 'valueGeoRange') {
    return `valueGeoRange: {geoCoordinates: {latitude: ${literal(value.latitude)}, longitude: ${literal(value.longitude)}}, distance: {max: ${literal(value.distance)}}}`;
  }
  return `${value.kind}: ${literal(value.value)}`;
}

/** The GraphQL input object of a validated filter. */
export function renderWhere(where: WeaviateWhere): string {
  if (where.operator === 'And' || where.operator === 'Or') {
    const operands = (where as { operands: WeaviateWhere[] }).operands;
    return `{operator: ${where.operator}, operands: [${operands.map(renderWhere).join(', ')}]}`;
  }
  const unit = where as { operator: UnitOperator; path: string; value: WhereValue };
  if (!WEAVIATE_PROPERTY_NAME.test(unit.path) || !OPERATOR_LABEL[unit.operator]) {
    throw new WeaviateQueryError('Invalid search filter');
  }
  return `{path: [${literal(unit.path)}], operator: ${unit.operator}, ${renderValue(unit.value)}}`;
}

export type FusionType = 'RelativeScore' | 'Ranked';

const FUSION_TYPES: Record<FusionType, string> = {
  RelativeScore: 'relativeScoreFusion',
  Ranked: 'rankedFusion',
};

export function isFusionType(value: unknown): value is FusionType {
  return typeof value === 'string' && Object.hasOwn(FUSION_TYPES, value);
}

export interface HybridSearch {
  query: string;
  vector: number[];
  alpha?: number;
  /** property names, each optionally weighted: `question^2` */
  properties?: string[];
  fusionType?: FusionType;
  maxVectorDistance?: number;
}

/** `_additional` fields a query may ask for */
export type AdditionalField = 'id' | 'distance' | 'score' | 'explainScore';
const ADDITIONAL_FIELDS = new Set<string>(['id', 'distance', 'score', 'explainScore']);

/** A weighted query property: a property name and an optional `^<number>` boost. */
export const WEAVIATE_QUERY_PROPERTY = /^[_A-Za-z][_0-9A-Za-z]*(\^\d+(\.\d+)?)?$/;

export interface GetQuery {
  className: string;
  limit: number;
  /** properties returned per object */
  properties: string[];
  additional: AdditionalField[];
  /** one of `nearVector` and `hybrid` */
  nearVector?: number[];
  hybrid?: HybridSearch;
  autocut?: number;
  tenant?: string;
  where?: WeaviateWhere;
}

function vectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || !vector.length || vector.some((v) => !finite(v))) {
    throw new WeaviateQueryError('The query vector must be a non-empty list of finite numbers');
  }
  return literal(vector as unknown as string[]);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new WeaviateQueryError(`${label} must be a whole number of 1 or more`);
  return value;
}

function renderHybrid(hybrid: HybridSearch): string {
  const parts = [`query: ${literal(String(hybrid.query))}`, `vector: ${vectorLiteral(hybrid.vector)}`];
  if (hybrid.alpha !== undefined) parts.push(`alpha: ${literal(hybrid.alpha)}`);
  if (hybrid.properties?.length) {
    for (const p of hybrid.properties) {
      if (!WEAVIATE_QUERY_PROPERTY.test(p))
        throw new WeaviateQueryError(`Invalid query property: ${echo(p)}`);
    }
    parts.push(`properties: ${literal(hybrid.properties)}`);
  }
  if (hybrid.fusionType !== undefined) {
    if (!isFusionType(hybrid.fusionType)) {
      throw new WeaviateQueryError(`Unsupported fusion type: ${echo(hybrid.fusionType)}`);
    }
    parts.push(`fusionType: ${FUSION_TYPES[hybrid.fusionType]}`);
  }
  if (hybrid.maxVectorDistance !== undefined)
    parts.push(`maxVectorDistance: ${literal(hybrid.maxVectorDistance)}`);
  return `hybrid: {${parts.join(', ')}}`;
}

/** The GraphQL `Get` query text for one collection. */
export function buildGetQuery(query: GetQuery): string {
  if (!WEAVIATE_CLASS_NAME.test(query.className)) {
    throw new WeaviateQueryError(`Invalid collection name: ${echo(query.className)}`);
  }
  if (!query.properties.length) throw new WeaviateQueryError('A Weaviate query needs at least one property');
  for (const p of query.properties) {
    if (!WEAVIATE_PROPERTY_NAME.test(p)) throw new WeaviateQueryError(`Invalid property name: ${echo(p)}`);
  }
  for (const a of query.additional) {
    if (!ADDITIONAL_FIELDS.has(a)) throw new WeaviateQueryError(`Unsupported additional field: ${echo(a)}`);
  }
  const args: string[] = [];
  if (query.hybrid) args.push(renderHybrid(query.hybrid));
  else if (query.nearVector) args.push(`nearVector: {vector: ${vectorLiteral(query.nearVector)}}`);
  else throw new WeaviateQueryError('A Weaviate query needs a vector');
  args.push(`limit: ${positiveInteger(query.limit, 'Limit')}`);
  if (query.autocut !== undefined) args.push(`autocut: ${positiveInteger(query.autocut, 'Auto Cut Limit')}`);
  if (query.tenant !== undefined) args.push(`tenant: ${literal(query.tenant)}`);
  if (query.where) args.push(`where: ${renderWhere(query.where)}`);
  const additional = query.additional.length ? ` _additional { ${query.additional.join(' ')} }` : '';
  return `{ Get { ${query.className}(${args.join(', ')}) { ${query.properties.join(' ')}${additional} } } }`;
}
