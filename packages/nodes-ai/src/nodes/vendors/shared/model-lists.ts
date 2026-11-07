/** Model pickers of vendor nodes. L1 fills it; the signature is final. */
import type { ListSearchResult, LoadOptionsContext } from '@workflow/workflow';

/**
 * A `listSearch` method over a vendor's model list: models `keep` accepts, filtered by the typed text,
 * as results named by `name` (else the id) with the id as value.
 */
export function modelListSearch(
  _list: (ctx: LoadOptionsContext) => Promise<Array<{ id: string; name?: string }>>,
  _keep?: (id: string) => boolean,
): (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult> {
  throw new Error('not implemented (L1)');
}
