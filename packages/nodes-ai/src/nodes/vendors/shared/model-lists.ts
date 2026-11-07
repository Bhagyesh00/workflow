/** Model pickers of vendor nodes. */
import type { ListSearchResult, LoadOptionsContext } from '@workflow/workflow';

/**
 * A `listSearch` method over a vendor's model list: models `keep` accepts, filtered by the typed text,
 * as results named by `name` (else the id) with the id as value.
 */
export function modelListSearch(
  list: (ctx: LoadOptionsContext) => Promise<Array<{ id: string; name?: string }>>,
  keep?: (id: string) => boolean,
): (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult> {
  return async (ctx, filter) => {
    const needle = filter?.trim().toLowerCase() ?? '';
    const seen = new Set<string>();
    const results: ListSearchResult['results'] = [];
    for (const model of await list(ctx)) {
      if (seen.has(model.id) || (keep && !keep(model.id))) continue;
      const name = model.name || model.id;
      if (needle && !name.toLowerCase().includes(needle) && !model.id.toLowerCase().includes(needle)) {
        continue;
      }
      seen.add(model.id);
      results.push({ name, value: model.id });
    }
    return { results };
  };
}
