/** Kafka: sends a message to a topic for each input item (behaviour of n8n's v2, on kafkajs). */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { type KafkaCredentials, kafkaCredentialTest, openKafka } from './client';
import {
  acksCode,
  buildRecord,
  compressionCode,
  DEFAULT_SEND_TIMEOUT_MS,
  type ProduceSettings,
} from './produce';
import { type KafkaSchemaRegistry, openSchemaRegistry } from './schema-registry';

function settingsFor(ctx: ExecuteContext, index: number): ProduceSettings {
  const text = (name: string, fallback = '') => String(ctx.getNodeParameter(name, index, fallback) ?? '');
  const flag = (name: string, fallback = false) => ctx.getNodeParameter(name, index, fallback) === true;
  const list = ctx.getNodeParameter('headerParametersUi.parameter', index, []);
  return {
    topic: text('topic').trim(),
    sendInputData: flag('sendInputData', true),
    message: text('message'),
    useSchemaRegistry: flag('useSchemaRegistry'),
    schemaRegistryUrl: text('schemaRegistryUrl'),
    eventName: text('eventName').trim(),
    useKey: flag('useKey'),
    key: text('key'),
    jsonHeaders: flag('jsonParameters'),
    headersJson: text('headerParametersJson'),
    headers: Array.isArray(list) ? (list as ProduceSettings['headers']) : [],
  };
}

export const KafkaNode: NodeType = {
  description: {
    name: 'app.kafka',
    displayName: 'Kafka',
    description: 'Sends messages to a Kafka topic',
    icon: 'simple:apachekafka',
    iconColor: '#231f20',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Kafka' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools'],
    alias: ['kafka', 'apache kafka', 'message', 'topic', 'broker', 'stream'],
    credentials: [
      { name: 'kafka', required: true, testedBy: 'kafkaCredentialTest' },
      {
        name: 'schemaRegistryApi',
        required: false,
        displayOptions: { show: { useSchemaRegistry: [true] } },
      },
    ],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'send',
        options: [
          {
            name: 'Send Message',
            value: 'send',
            description: 'Send a message to a topic',
            action: 'Send a message',
          },
        ],
      },
      {
        displayName: 'Topic',
        name: 'topic',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'topic-name',
        description: 'Name of the topic to send to',
      },
      {
        displayName: 'Send Input Data',
        name: 'sendInputData',
        type: 'boolean',
        default: true,
        description: 'Whether to send the data the node receives as the message',
      },
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        default: '',
        description: 'The message to send',
        displayOptions: { show: { sendInputData: [false] } },
      },
      {
        displayName: 'Use Schema Registry',
        name: 'useSchemaRegistry',
        type: 'boolean',
        default: false,
        description: 'Whether to encode messages with a Confluent Schema Registry',
      },
      {
        displayName: 'Schema Registry URL',
        name: 'schemaRegistryUrl',
        type: 'string',
        default: '',
        placeholder: 'https://schema-registry-domain:8081',
        description: 'URL of the registry. Used only when no Schema Registry credential is selected.',
        displayOptions: { show: { useSchemaRegistry: [true] } },
      },
      {
        displayName: 'Event Name',
        name: 'eventName',
        type: 'string',
        default: '',
        description: 'Subject of the schema in the registry. The latest version of it is used.',
        displayOptions: { show: { useSchemaRegistry: [true] } },
      },
      {
        displayName: 'Use Key',
        name: 'useKey',
        type: 'boolean',
        default: false,
        description: 'Whether to set a key on the message',
      },
      {
        displayName: 'Key',
        name: 'key',
        type: 'string',
        default: '',
        description: 'The key of the message',
        displayOptions: { show: { useKey: [true] } },
      },
      {
        displayName: 'Headers (JSON)',
        name: 'jsonParameters',
        type: 'boolean',
        default: false,
        description: 'Whether to enter the headers as a JSON object',
      },
      {
        displayName: 'Headers',
        name: 'headerParametersUi',
        type: 'fixedCollection',
        placeholder: 'Add header',
        default: { parameter: [] },
        typeOptions: { multipleValues: true },
        description: 'Headers of the message',
        displayOptions: { show: { jsonParameters: [false] } },
        options: [
          {
            displayName: 'Header',
            name: 'parameter',
            values: [
              { displayName: 'Key', name: 'key', type: 'string', default: '', description: 'Header name' },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                description: 'Header value',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Headers (JSON Object)',
        name: 'headerParametersJson',
        type: 'json',
        default: '',
        description: 'Headers of the message, as a JSON object',
        displayOptions: { show: { jsonParameters: [true] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Acks',
            name: 'acks',
            type: 'boolean',
            default: false,
            description:
              'Whether the broker has to confirm the write on all in-sync replicas. When off, the leader alone confirms.',
          },
          {
            displayName: 'Compression',
            name: 'compression',
            type: 'options',
            default: 'none',
            description: 'How the message is compressed on the way to the broker',
            options: [
              { name: 'None', value: 'none' },
              { name: 'Gzip', value: 'gzip' },
              { name: 'LZ4', value: 'lz4' },
              { name: 'Snappy', value: 'snappy' },
              { name: 'Zstandard', value: 'zstd' },
            ],
          },
          {
            displayName: 'Timeout',
            name: 'timeout',
            type: 'number',
            default: DEFAULT_SEND_TIMEOUT_MS,
            typeOptions: { minValue: 1 },
            description: 'How long to wait for the broker to answer a send, in milliseconds',
          },
        ],
      },
    ],
  },

  methods: {
    credentialTest: { kafkaCredentialTest },
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    if (items.length === 0) return [[]];
    const first = settingsFor(ctx, 0);
    const credentials = await ctx.getCredentials<KafkaCredentials>('kafka');
    const handle = await openKafka(ctx, credentials);
    const producer = handle.kafka.producer();
    let registry: KafkaSchemaRegistry | undefined;
    const results: Item[] = [];
    try {
      if (first.useSchemaRegistry) registry = await openSchemaRegistry(ctx, first.schemaRegistryUrl);
      await producer.connect();
      for (let index = 0; index < items.length; index++) {
        try {
          const settings = settingsFor(ctx, index);
          if (!settings.topic) throw new Error('Enter the name of a topic');
          const record = await buildRecord(settings, items[index]!, registry);
          const options = (ctx.getNodeParameter('options', index, {}) ?? {}) as DataObject;
          const sent = await producer.send({
            topic: settings.topic,
            messages: [record],
            acks: acksCode(options.acks === true),
            compression: compressionCode(String(options.compression ?? 'none')),
            timeout: Number(options.timeout ?? DEFAULT_SEND_TIMEOUT_MS),
          });
          for (const metadata of sent) {
            results.push({ json: { ...metadata } as DataObject, pairedItem: { item: index } });
          }
        } catch (error) {
          if (ctx.continueOnFail()) {
            results.push({ json: { error: (error as Error).message }, pairedItem: { item: index } });
            continue;
          }
          if (error instanceof NodeOperationError) throw error;
          throw new NodeOperationError(
            ctx.getNode(),
            `Couldn't send the message: ${(error as Error).message}`,
            { itemIndex: index },
          );
        }
      }
    } finally {
      registry?.close();
      await producer.disconnect().catch(() => undefined);
      handle.destroySockets();
    }
    return [results];
  },
};
