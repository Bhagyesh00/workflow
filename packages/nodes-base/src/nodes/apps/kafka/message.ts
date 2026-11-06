/** A Kafka message as the item a run gets: `{ json: { message, topic, headers? }, binary?: { data } }`. */
import type { DataObject, Item, Logger, NodeHelpers } from '@workflow/workflow';
import type { IHeaders, KafkaMessage } from 'kafkajs';
import { type KafkaSchemaRegistry, scrubRegistryError } from './schema-registry';

export interface MessageOptions {
  jsonParseMessage: boolean;
  keepBinaryData: boolean;
  onlyMessage: boolean;
  returnHeaders: boolean;
}

interface MessageContext {
  logger: Pick<Logger, 'warn'>;
  helpers: Pick<NodeHelpers, 'prepareBinaryData'>;
}

function headerText(value: IHeaders[string]): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => entry.toString()).join(',');
  return value.toString();
}

const isObject = (value: unknown): value is DataObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A value the registry cannot decode throws: the caller leaves it unread and retries, so the message
 * survives until the registry is healthy. A value that is not JSON stays a string.
 */
export function createMessageParser(
  ctx: MessageContext,
  options: MessageOptions,
  registry?: KafkaSchemaRegistry,
) {
  return async (message: KafkaMessage, topic: string): Promise<Item> => {
    let value: unknown = message.value?.toString();

    if (options.jsonParseMessage && typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        ctx.logger.warn('Could not parse message to JSON, returning as string');
      }
    }

    if (registry && message.value) {
      try {
        value = await registry.decode(message.value);
      } catch (error) {
        ctx.logger.warn('Could not decode message with Schema Registry, leaving it unread', {
          reason: scrubRegistryError(error),
        });
        throw new Error('Could not decode message with Schema Registry');
      }
    }

    const json: DataObject = {};
    if (options.returnHeaders) {
      json.headers = Object.fromEntries(
        Object.entries(message.headers ?? {}).map(([name, header]) => [name, headerText(header)]),
      );
    }
    if (value !== undefined) json.message = value as DataObject[string];
    json.topic = topic;

    const item: Item = options.onlyMessage
      ? // the value replaces the item, and an item body has to be an object
        { json: isObject(value) ? value : { message: (value ?? null) as DataObject[string] } }
      : { json };

    if (options.keepBinaryData && message.value) {
      item.binary = {
        data: await ctx.helpers.prepareBinaryData(message.value, 'message', 'application/octet-stream'),
      };
    }
    return item;
  };
}
