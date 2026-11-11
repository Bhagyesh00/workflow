/**
 * Public API discover (P6-75, L5): GET `/discover`, the routes this key may call (n8n's discover), filtered by the
 * key's scopes (a key with empty scopes sees all), with `include=schemas`, `resource` and `operation`. Built from
 * `PUBLIC_ROUTES` read inside the handler (an import cycle at module load otherwise). The row is `anyKey`: any valid
 * key calls it (the loop skips only `assertApiKeyScope`), its access S1's `{ open: true }`; the handler filters.
 *
 * The answer is `{ data: { resources: { <resource>: { <operation>: entry } } } }`. The resource is the first path
 * segment (`workflows`, `source-control`); the operation names the call (`list`, `get`, `create`, `update`,
 * `delete`, or the action segment such as `activate` or `push`, a method prefix when a sub-path follows an id).
 * An entry holds `method`, `path`, `summary`, `tag`, `scope` and, with `include=schemas`, `inputSchema` (path,
 * query and body as one object schema) and `outputSchema`. A route that names no key scope is listed only for a key
 * with empty scopes, because a key with scopes gets 403 on it.
 */
import { z } from 'zod';
import type { ApiRoute } from './public-api';

const discoverQuery = z.object({
  include: z.enum(['schemas']).optional(),
  resource: z.string().max(64).optional(),
  operation: z.string().max(64).optional(),
});

interface DiscoverEntry {
  method: string;
  path: string;
  summary: string;
  tag: string;
  scope: string | null;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const camel = (segments: string[]) =>
  segments
    .map((s, i) => (i === 0 ? s : capital(s)))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');

/** `/workflows/:id/activate` -> resource `workflows`, operation `activate` */
function nameOf(route: ApiRoute): { resource: string; operation: string } {
  const segments = route.path.split('/').filter(Boolean);
  const resource = segments[0] ?? '';
  const rest = segments.slice(1);
  const names = rest.filter((s) => !s.startsWith(':'));
  const endsInParam = rest.length > 0 && (rest[rest.length - 1] ?? '').startsWith(':');
  const verb =
    route.method === 'GET'
      ? route.list
        ? 'list'
        : 'get'
      : route.method === 'POST'
        ? 'create'
        : route.method === 'DELETE'
          ? 'delete'
          : 'update';
  if (!names.length) return { resource, operation: verb };
  // an action segment after the resource (`/source-control/push`, `/workflows/:id/activate`)
  if (route.method === 'POST' && !endsInParam) return { resource, operation: camel(names) };
  return { resource, operation: camel([verb, ...names]) };
}

/** the request schemas of a row as one object schema (path, query, body), as `z.toJSONSchema` gives them */
function inputSchemaOf(route: ApiRoute): Record<string, unknown> {
  const parts: Record<string, unknown> = {};
  for (const [location, schema] of [
    ['path', route.params],
    ['query', route.query],
    ['body', route.body],
  ] as const) {
    if (!schema) continue;
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete json.$schema;
    parts[location] = json;
  }
  return { type: 'object', properties: parts };
}

export const PUBLIC_DISCOVER_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/discover',
    summary: 'List the routes this API key may call',
    tag: 'Discover',
    access: { open: true },
    anyKey: true,
    query: discoverQuery,
    response: 'DiscoverResponse',
    handler: async (ctx, { auth, query }) => {
      // read here: public-api.ts imports this file, so a top-level import would be a cycle
      const api = await import('./public-api');
      const granted = auth.apiKeyScopes ?? [];
      const components = query.include === 'schemas' ? api.buildOpenApiDocument(ctx) : undefined;
      const schemas = (components?.components as { schemas?: Record<string, unknown> } | undefined)?.schemas;
      const resources: Record<string, Record<string, DiscoverEntry>> = {};
      for (const route of api.PUBLIC_ROUTES) {
        // the key's scopes decide: empty scopes see all; a scoped key sees its routes and discover itself
        const allowed =
          granted.length === 0 || route.anyKey === true || (route.scope && granted.includes(route.scope));
        if (!allowed) continue;
        const { resource, operation } = nameOf(route);
        if (query.resource && query.resource !== resource) continue;
        if (query.operation && query.operation !== operation) continue;
        const group = (resources[resource] ??= {});
        const key = operation in group ? `${operation}${capital(route.method.toLowerCase())}` : operation;
        const output = schemas?.[route.response];
        group[key] = {
          method: route.method,
          path: route.path,
          summary: route.summary,
          tag: route.tag,
          scope: route.scope ?? null,
          ...(schemas
            ? {
                inputSchema: inputSchemaOf(route),
                outputSchema: route.list
                  ? { type: 'array', items: output ?? {} }
                  : ((output as Record<string, unknown> | undefined) ?? {}),
              }
            : {}),
        };
      }
      return { data: { resources } };
    },
  },
];
