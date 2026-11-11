/**
 * Public API discover (P6-75, L5): GET `/discover`, the routes this key may call (n8n's discover), filtered by the
 * key's scopes (a key with empty scopes sees all), with `include=schemas`, `resource` and `operation`. Built from
 * `PUBLIC_ROUTES` read inside the handler (an import cycle at module load otherwise). The row is `anyKey`: any valid
 * key calls it (the loop skips only `assertApiKeyScope`), its access S1's `{ open: true }`; the handler filters.
 * stub (L5): the row has its final path and access; the handler throws.
 */
import { z } from 'zod';
import type { ApiRoute } from './public-api';

const discoverQuery = z.object({
  include: z.enum(['schemas']).optional(),
  resource: z.string().max(64).optional(),
  operation: z.string().max(64).optional(),
});

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
    // stub (L5)
    handler: async () => {
      throw new Error('not implemented (L5)');
    },
  },
];
