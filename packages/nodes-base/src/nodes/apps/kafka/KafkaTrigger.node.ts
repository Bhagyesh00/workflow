/** Kafka Trigger: behaviour of n8n's v2 on kafkajs, whose socket hook lets the SSRF guard see every broker. */
import type { NodeType } from '@workflow/workflow';
import { assertTopicExists, type KafkaCredentials, kafkaCredentialTest, openKafka } from './client';
import { consumerConfig, createTopicConsumer, readTriggerSettings } from './consume';
import { createMessageParser } from './message';
import { type KafkaSchemaRegistry, openSchemaRegistry } from './schema-registry';

export const KafkaTriggerNode: NodeType = {
  description: {
    name: 'app.kafkaTrigger',
    displayName: 'Kafka Trigger',
    description: 'Consumes a topic with a group',
    icon: 'simple:apachekafka',
    iconColor: '#231f20',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Kafka Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Triggers'],
    eventTriggerDescription: 'Waiting for a message on the Kafka topic',
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
        displayName: 'Topic',
        name: 'topic',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'topic-name',
        description: 'Name of the topic to consume from. Start with ^ for a pattern.',
      },
      {
        displayName: 'Group ID',
        name: 'groupId',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'my-consumer-group',
        description: 'ID of the consumer group',
      },
      {
        displayName: 'Resolve Offset',
        name: 'resolveOffset',
        type: 'options',
        default: 'onCompletion',
        description:
          'When a message counts as read. A test run always resolves offsets immediately, in a group of its own.',
        options: [
          {
            name: 'On Execution Completion',
            value: 'onCompletion',
            description: 'After the run finishes, whatever its status',
          },
          {
            name: 'On Execution Success',
            value: 'onSuccess',
            description: 'Only when the run succeeds; otherwise the message is delivered again',
          },
          {
            name: 'On Allowed Execution Statuses',
            value: 'onStatus',
            description: 'Only when the run ends in one of the selected statuses',
          },
          {
            name: 'Immediately',
            value: 'immediately',
            description: 'As soon as the message arrives. A message can be lost if the run then fails.',
          },
        ],
      },
      {
        displayName: 'Allowed Statuses',
        name: 'allowedStatuses',
        type: 'multiOptions',
        default: ['success'],
        description: 'Run statuses that resolve the offset',
        displayOptions: { show: { resolveOffset: ['onStatus'] } },
        options: [
          { name: 'Canceled', value: 'canceled' },
          { name: 'Crashed', value: 'crashed' },
          { name: 'Error', value: 'error' },
          { name: 'New', value: 'new' },
          { name: 'Running', value: 'running' },
          { name: 'Success', value: 'success' },
          { name: 'Unknown', value: 'unknown' },
          { name: 'Waiting', value: 'waiting' },
        ],
      },
      {
        displayName: 'Use Schema Registry',
        name: 'useSchemaRegistry',
        type: 'boolean',
        default: false,
        description: 'Whether to decode messages with a Confluent Schema Registry',
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
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Auto Commit Interval',
            name: 'autoCommitInterval',
            type: 'number',
            default: 0,
            description:
              'Commit offsets on this period, in milliseconds. With 0 every processed chunk commits at once.',
          },
          {
            displayName: 'Batch Size',
            name: 'batchSize',
            type: 'number',
            default: 1,
            typeOptions: { minValue: 1 },
            description: 'Messages per run. With 1, each message starts its own run.',
          },
          {
            displayName: 'Fetch Max Bytes',
            name: 'fetchMaxBytes',
            type: 'number',
            default: 1048576,
            description: 'The most data the broker returns for a fetch, in bytes',
          },
          {
            displayName: 'Fetch Min Bytes',
            name: 'fetchMinBytes',
            type: 'number',
            default: 1,
            description: 'The least data the broker waits for before it answers a fetch, in bytes',
          },
          {
            displayName: 'Heartbeat Interval',
            name: 'heartbeatInterval',
            type: 'number',
            default: 10000,
            description:
              'How often the consumer tells the broker it is alive, in milliseconds. Lowered to a third of the Session Timeout if it is more than that.',
          },
          {
            displayName: 'Max Number of Requests',
            name: 'maxInFlightRequests',
            type: 'number',
            default: 1,
            typeOptions: { minValue: 1 },
            description: 'The most unanswered requests on one connection',
          },
          {
            displayName: 'Read Messages From Beginning',
            name: 'fromBeginning',
            type: 'boolean',
            default: true,
            description: 'Whether a new group starts at the oldest message',
          },
          {
            displayName: 'JSON Parse Message',
            name: 'jsonParseMessage',
            type: 'boolean',
            default: false,
            description: 'Whether to try to parse the message to an object',
          },
          {
            displayName: 'Keep Message as Binary Data',
            name: 'keepBinaryData',
            type: 'boolean',
            default: false,
            description: 'Whether to keep the raw value as binary data, for example for Avro',
          },
          {
            displayName: 'Partitions Consumed Concurrently',
            name: 'partitionsConsumedConcurrently',
            type: 'number',
            default: 0,
            description: 'Partitions to process in parallel. With 0 they are processed one after another.',
          },
          {
            displayName: 'Only Message',
            name: 'onlyMessage',
            type: 'boolean',
            default: false,
            description: 'Whether to return only the message',
            displayOptions: { show: { jsonParseMessage: [true] } },
          },
          {
            displayName: 'Return Headers',
            name: 'returnHeaders',
            type: 'boolean',
            default: false,
            description: 'Whether to return the headers received from Kafka',
          },
          {
            displayName: 'Rebalance Timeout',
            name: 'rebalanceTimeout',
            type: 'number',
            default: 600000,
            description: 'How long a member may take to rejoin during a rebalance, in milliseconds',
          },
          {
            displayName: 'Retry Delay on Error',
            name: 'errorRetryDelay',
            type: 'number',
            default: 5000,
            typeOptions: { minValue: 1000 },
            description:
              'How long to wait before messages that were left unread are delivered again, in milliseconds',
            displayOptions: { hide: { '/resolveOffset': ['immediately'] } },
          },
          {
            displayName: 'Session Timeout',
            name: 'sessionTimeout',
            type: 'number',
            default: 30000,
            description:
              'How long the broker waits for a heartbeat before it drops the consumer, in milliseconds. Heartbeats continue while a run is in progress.',
          },
        ],
      },
    ],
  },

  methods: {
    credentialTest: { kafkaCredentialTest },
  },

  async trigger(ctx) {
    const settings = readTriggerSettings(ctx);
    const credentials = await ctx.getCredentials<KafkaCredentials>('kafka');
    const handle = await openKafka(ctx, credentials);

    let registry: KafkaSchemaRegistry | undefined;
    if (settings.useSchemaRegistry) registry = await openSchemaRegistry(ctx, settings.schemaRegistryUrl);

    const consumer = createTopicConsumer(
      {
        createConsumer: (restartOnFailure) =>
          handle.kafka.consumer(consumerConfig(settings, restartOnFailure)),
        parse: createMessageParser(ctx, settings.parser, registry),
        emit: (data, done) => ctx.emit(data, done),
        emitError: (error) => ctx.emitError(error),
        logger: ctx.logger,
      },
      settings,
    );

    const start = async () => {
      await assertTopicExists(handle.kafka, settings.topic, ctx.logger);
      await consumer.start();
    };

    const closeFunction = async () => {
      await consumer.close();
      registry?.close();
      handle.destroySockets();
    };

    if (settings.manual) return { closeFunction, manualTriggerFunction: start };

    try {
      await start();
    } catch (error) {
      await closeFunction();
      throw error;
    }
    return { closeFunction };
  },
};
