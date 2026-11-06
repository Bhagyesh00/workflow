/** Sending to Kafka: the message of one item (value, key, headers, optional Schema Registry encoding). */
import type { DataObject, Item } from '@workflow/workflow';
import kafkajs from 'kafkajs';
import type { KafkaSchemaRegistry } from './schema-registry';

const { CompressionTypes } = kafkajs;

export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

export type KafkaCompression = 'none' | 'gzip' | 'lz4' | 'snappy' | 'zstd';

const COMPRESSION_CODES: Record<KafkaCompression, number> = {
  none: CompressionTypes.None,
  gzip: CompressionTypes.GZIP,
  snappy: CompressionTypes.Snappy,
  lz4: CompressionTypes.LZ4,
  zstd: CompressionTypes.ZSTD,
};

export function compressionCode(name: string): number {
  const code = COMPRESSION_CODES[name as KafkaCompression];
  if (code === undefined) throw new Error(`Kafka compression "${name}" is not supported`);
  return code;
}

/** true waits for every in-sync replica, false for the leader only; a send always gets an answer */
export const acksCode = (acks: boolean): number => (acks ? -1 : 1);

export interface ProduceSettings {
  topic: string;
  sendInputData: boolean;
  message: string;
  useSchemaRegistry: boolean;
  schemaRegistryUrl: string;
  eventName: string;
  useKey: boolean;
  key: string;
  jsonHeaders: boolean;
  headersJson: string;
  headers: Array<{ key?: string; value?: string }>;
}

const isObject = (value: unknown): value is DataObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function headerValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

/** headers from the key/value list or the JSON text; the ones with no name are dropped */
export function buildHeaders(settings: ProduceSettings): Record<string, string> {
  const headers: Record<string, string> = {};
  if (settings.jsonHeaders) {
    const text = settings.headersJson.trim();
    if (!text) return headers;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Headers (JSON) is not valid JSON');
    }
    if (!isObject(parsed)) throw new Error('Headers (JSON) has to be an object');
    for (const [name, value] of Object.entries(parsed)) headers[name] = headerValue(value);
    return headers;
  }
  for (const { key, value } of settings.headers) {
    if (key) headers[key] = value ?? '';
  }
  return headers;
}

/** the record for one input item */
export async function buildRecord(
  settings: ProduceSettings,
  item: Item,
  registry?: KafkaSchemaRegistry,
): Promise<{ value: Buffer | string; key?: string; headers?: Record<string, string> }> {
  let value: Buffer | string;
  if (settings.useSchemaRegistry && registry) {
    let payload: unknown = item.json;
    if (!settings.sendInputData) {
      try {
        payload = JSON.parse(settings.message);
      } catch {
        throw new Error('The message is not valid JSON, and the Schema Registry needs an object to encode');
      }
    }
    if (!settings.eventName) throw new Error('Enter the Event Name (the Schema Registry subject)');
    value = await registry.encode(settings.eventName, payload);
  } else {
    value = settings.sendInputData ? JSON.stringify(item.json) : settings.message;
  }
  const headers = buildHeaders(settings);
  return {
    value,
    ...(settings.useKey ? { key: settings.key } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
