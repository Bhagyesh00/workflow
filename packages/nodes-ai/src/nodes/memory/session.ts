/**
 * Session id of a memory sub-node: the parameters every memory node shows and how the key of the
 * current item is read. Shared by every memory node so a change of session rules lands in one place.
 *
 * "Connected Chat Trigger Node" (`fromInput`, the default) reads `$json.sessionId` of the input item,
 * then the Chat Trigger's `sessionId`, and scopes the id to this memory node. "Define below"
 * (`customKey`) uses the key as typed, unscoped.
 */
import { NodeOperationError, type NodeProperty, type SupplyDataContext } from '@workflow/workflow';

const MAX_SESSION_KEY = 512;
const CHAT_TRIGGER_TYPE = 'ai.chatTrigger';

/** the session parameters of a memory node, spread into its properties */
export const sessionProperties: NodeProperty[] = [
  {
    displayName: 'Session ID',
    name: 'sessionIdType',
    type: 'options',
    default: 'fromInput',
    options: [
      {
        name: 'Connected Chat Trigger Node',
        value: 'fromInput',
        description:
          'Looks for an input field called "sessionId" that is sent by the Chat Trigger. The history is kept apart for each memory node.',
      },
      {
        name: 'Define below',
        value: 'customKey',
        description: 'Use an expression to reference data in previous nodes or enter static text',
      },
    ],
  },
  {
    displayName: 'Key',
    name: 'sessionKey',
    type: 'string',
    default: '',
    required: true,
    description: 'Identifies the conversation, for example a user id',
    displayOptions: { show: { sessionIdType: ['customKey'] } },
  },
];

/** a session id must be text, a number or a boolean: an object could become a query in a store */
function sessionText(ctx: SupplyDataContext, itemIndex: number, value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new NodeOperationError(ctx.getNode(), 'Invalid session ID', {
    itemIndex,
    description: 'The session ID must be text, a number or a true/false value.',
  });
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** `$json.sessionId` of the input item, else the Chat Trigger's; a failed lookup leaves it empty */
function inputSessionId(ctx: SupplyDataContext, itemIndex: number): unknown {
  let value: unknown;
  try {
    value = ctx.evaluateExpression('={{ $json.sessionId }}', itemIndex);
  } catch {
    value = undefined;
  }
  if (!isEmpty(value)) return value;
  try {
    const trigger = ctx.getParentNodes().find((n) => n.type === CHAT_TRIGGER_TYPE);
    if (trigger) {
      // JSON.stringify keeps a quote or brace in the node name inside the string literal
      return ctx.evaluateExpression(
        `={{ $(${JSON.stringify(trigger.name)}).first().json.sessionId }}`,
        itemIndex,
      );
    }
  } catch {
    // no run data for the trigger: the id stays empty
  }
  return undefined;
}

/** The session key of this item: trimmed, never empty, at most 512 characters. */
export function readSessionKey(ctx: SupplyDataContext, itemIndex: number): string {
  const type = ctx.getNodeParameter('sessionIdType', itemIndex, 'fromInput');
  let key: string;
  if (type === 'customKey') {
    const value = ctx.getNodeParameter('sessionKey', itemIndex, '');
    if (isEmpty(value)) {
      throw new NodeOperationError(ctx.getNode(), 'Key parameter is empty', {
        itemIndex,
        description: 'Enter a key or map a value, e.g. {{ $json.userId }}.',
        parameter: 'sessionKey',
      });
    }
    key = sessionText(ctx, itemIndex, value);
  } else {
    const value = inputSessionId(ctx, itemIndex);
    if (isEmpty(value)) {
      throw new NodeOperationError(ctx.getNode(), 'No session ID found', {
        itemIndex,
        description:
          'Add a "sessionId" field to the input item, connect a Chat Trigger node, or set "Define below" and enter a key.',
      });
    }
    const id = sessionText(ctx, itemIndex, value);
    // the id is scoped to this memory node, so two memory nodes on one session keep separate history
    key = `${id}__${ctx.getNode().name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  }
  if (key.length > MAX_SESSION_KEY) {
    throw new NodeOperationError(
      ctx.getNode(),
      `The session key is longer than ${MAX_SESSION_KEY} characters`,
      { itemIndex },
    );
  }
  return key;
}
