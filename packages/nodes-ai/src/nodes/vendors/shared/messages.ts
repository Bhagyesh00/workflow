/**
 * The parameters every vendor message operation shares (Messages, Simplify Output, Max Tool Calls
 * Iterations) and the per-item loop with continue-on-fail. L1 fills the functions; the signatures are
 * final.
 */
import type { ExecuteContext, Item, NodeOutput, NodeProperty } from '@workflow/workflow';
import type { VendorFile } from './binary';

export interface VendorMessage {
  role: string;
  content: string;
  attachments?: VendorFile[];
}

/** The Messages fixed collection: a role from `roles` and the content, plus attachments when asked. */
export function messagesProperty(_options: { roles: string[]; attachments?: boolean }): NodeProperty {
  throw new Error('not implemented (L1)');
}

/** The Simplify Output switch (default true). */
export function simplifyProperty(_defaultValue?: boolean): NodeProperty {
  throw new Error('not implemented (L1)');
}

/** The option that caps model calls in the tool loop. */
export const maxToolIterationsOption: NodeProperty = {
  displayName: 'Max Tool Calls Iterations',
  name: 'maxToolsIterations',
  type: 'number',
  default: 15,
  typeOptions: { minValue: 0 },
  description: 'Model calls allowed in one run when the model calls tools',
};

/** The item's Messages, with attachments read from their binary fields or URLs. */
export async function readVendorMessages(_ctx: ExecuteContext, _itemIndex: number): Promise<VendorMessage[]> {
  throw new Error('not implemented (L1)');
}

/** Run `run` for every input item; with continue-on-fail a failed item gives `{ error }` instead. */
export async function eachVendorItem(
  _ctx: ExecuteContext,
  _run: (itemIndex: number) => Promise<Item | Item[]>,
): Promise<NodeOutput> {
  throw new Error('not implemented (L1)');
}
