/**
 * Session id of a memory sub-node: the parameters every memory node shows and how the key of the
 * current item is read. Shared by every memory node so a change of session rules lands in one place.
 */
import { NodeOperationError, type NodeProperty, type SupplyDataContext } from '@workflow/workflow';

const MAX_SESSION_KEY = 512;

/** the session parameters of a memory node, spread into its properties */
export const sessionProperties: NodeProperty[] = [
  {
    displayName: 'Session Key',
    name: 'sessionKey',
    type: 'string',
    default: '={{ $json.sessionId }}',
    required: true,
    description: 'Identifies the conversation. The Chat Trigger sends "sessionId".',
  },
];

/** The session key of this item: trimmed, never empty, at most 512 characters. */
export function readSessionKey(ctx: SupplyDataContext, itemIndex: number): string {
  const value = ctx.getNodeParameter('sessionKey', itemIndex, '');
  const key = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!key) {
    throw new NodeOperationError(ctx.getNode(), 'The session key is empty', {
      itemIndex,
      description: 'Map a session id, e.g. {{ $json.sessionId }} from a Chat Trigger.',
      parameter: 'sessionKey',
    });
  }
  if (key.length > MAX_SESSION_KEY) {
    throw new NodeOperationError(
      ctx.getNode(),
      `The session key is longer than ${MAX_SESSION_KEY} characters`,
      {
        itemIndex,
      },
    );
  }
  return key;
}
