/** OpenAI conversation operations: create, get, update metadata and remove. */
import { type DataObject, type ExecuteContext, type Item, NodeOperationError, type NodeProperty } from '@workflow/workflow';
import { messagesProperty, readVendorMessages } from '../shared/messages';
import { forOperation, openAiBaseUrl, openAiCall, readJsonObject } from './text';

const idProperty: NodeProperty = {
  displayName: 'Conversation ID',
  name: 'conversationId',
  type: 'string',
  default: '',
  required: true,
  placeholder: 'e.g. conv_abc123',
};

const metadataProperty = (description: string): NodeProperty => ({
  displayName: 'Metadata',
  name: 'metadata',
  type: 'json',
  default: '',
  description,
});

export const conversationProperties: NodeProperty[] = [
  ...forOperation('conversation', 'create', [
    messagesProperty({ roles: ['user', 'assistant', 'system', 'developer'] }),
    metadataProperty('Up to 16 key and value pairs, as a JSON object of strings'),
  ]),
  ...forOperation('conversation', 'get', [idProperty]),
  ...forOperation('conversation', 'update', [
    idProperty,
    metadataProperty('The new metadata, as a JSON object of strings. It replaces the old one.'),
  ]),
  ...forOperation('conversation', 'remove', [idProperty]),
];

function readId(ctx: ExecuteContext, itemIndex: number): string {
  const id = String(ctx.getNodeParameter('conversationId', itemIndex, '')).trim();
  if (!id) throw new NodeOperationError(ctx.getNode(), 'Enter the conversation ID', { itemIndex });
  return id;
}

export async function executeConversation(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: string,
): Promise<Item> {
  const baseUrl = await openAiBaseUrl(ctx, itemIndex);
  switch (operation) {
    case 'create': {
      const messages = await readVendorMessages(ctx, itemIndex);
      const metadata = readJsonObject(ctx, itemIndex, 'Metadata', ctx.getNodeParameter('metadata', itemIndex, ''));
      const body: DataObject = {};
      if (messages.length) {
        body.items = messages.map((m) => ({ type: 'message', role: m.role, content: m.content }));
      }
      if (metadata) body.metadata = metadata;
      return { json: await openAiCall<DataObject>(ctx, itemIndex, { url: `${baseUrl}/conversations`, method: 'POST', body }) };
    }
    case 'get':
      return {
        json: await openAiCall<DataObject>(ctx, itemIndex, {
          url: `${baseUrl}/conversations/${encodeURIComponent(readId(ctx, itemIndex))}`,
          method: 'GET',
        }),
      };
    case 'update': {
      const id = readId(ctx, itemIndex);
      const metadata = readJsonObject(ctx, itemIndex, 'Metadata', ctx.getNodeParameter('metadata', itemIndex, ''));
      if (!metadata) throw new NodeOperationError(ctx.getNode(), 'Enter the new metadata', { itemIndex });
      return {
        json: await openAiCall<DataObject>(ctx, itemIndex, {
          url: `${baseUrl}/conversations/${encodeURIComponent(id)}`,
          method: 'POST',
          body: { metadata },
        }),
      };
    }
    case 'remove':
      return {
        json: await openAiCall<DataObject>(ctx, itemIndex, {
          url: `${baseUrl}/conversations/${encodeURIComponent(readId(ctx, itemIndex))}`,
          method: 'DELETE',
        }),
      };
    default:
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not known`, { itemIndex });
  }
}
