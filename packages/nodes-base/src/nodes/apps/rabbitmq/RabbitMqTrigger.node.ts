/** RabbitMQ Trigger: behaviour of n8n's node on amqplib, with the SSRF guard on the broker socket. */
import type { NodeType } from '@workflow/workflow';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import {
  describeSetupError,
  openRabbit,
  prepareQueue,
  type RabbitMqCredentials,
  rabbitmqCredentialTest,
} from './connect';
import { createMessageParser, createTracker, readTriggerSettings } from './tracker';

export const RabbitMqTriggerNode: NodeType = {
  description: {
    name: 'app.rabbitmqTrigger',
    displayName: 'RabbitMQ Trigger',
    description: 'Consumes a queue with acknowledge modes',
    icon: 'simple:rabbitmq',
    iconColor: '#ff6600',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'RabbitMQ Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Triggers'],
    eventTriggerDescription: 'Waiting for a message from the RabbitMQ queue',
    credentials: [{ name: 'rabbitmq', required: true, testedBy: 'rabbitmqCredentialTest' }],
    properties: [
      {
        displayName: 'Queue / Topic',
        name: 'queue',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'queue-name',
        description: 'The name of the queue to read from',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Arguments',
            name: 'arguments',
            type: 'fixedCollection',
            placeholder: 'Add argument',
            default: { argument: [] },
            typeOptions: { multipleValues: true },
            description: 'Arguments the queue is declared with, for example x-message-ttl',
            options: [
              {
                displayName: 'Argument',
                name: 'argument',
                values: [
                  { displayName: 'Key', name: 'key', type: 'string', default: '' },
                  {
                    displayName: 'Value',
                    name: 'value',
                    type: 'string',
                    default: '',
                    description: 'Whole numbers and true or false are sent as numbers and booleans',
                  },
                ],
              },
            ],
          },
          {
            displayName: 'Assert Exchange',
            name: 'assertExchange',
            type: 'boolean',
            default: true,
            description:
              'Whether to declare an exchange that is not there yet (as a topic exchange) before binding to it',
          },
          {
            displayName: 'Assert Queue',
            name: 'assertQueue',
            type: 'boolean',
            default: true,
            description:
              'Whether to declare the queue with these options. When off, the queue must already exist.',
          },
          {
            displayName: 'Auto Delete Queue',
            name: 'autoDelete',
            type: 'boolean',
            default: false,
            description: 'Whether to delete the queue when the last consumer leaves',
          },
          {
            displayName: 'Binding',
            name: 'binding',
            type: 'fixedCollection',
            placeholder: 'Add binding',
            default: { bindings: [] },
            typeOptions: { multipleValues: true },
            description: 'Exchanges the queue is bound to when the trigger starts',
            options: [
              {
                displayName: 'Binding',
                name: 'bindings',
                values: [
                  { displayName: 'Exchange', name: 'exchange', type: 'string', default: '' },
                  { displayName: 'Routing Key', name: 'routingKey', type: 'string', default: '' },
                ],
              },
            ],
          },
          {
            displayName: 'Content Is Binary',
            name: 'contentIsBinary',
            type: 'boolean',
            default: false,
            description: 'Whether to save the message body as binary data',
          },
          {
            displayName: 'Delete From Queue When',
            name: 'acknowledge',
            type: 'options',
            default: 'immediately',
            description: 'When the message is removed from the queue',
            options: [
              {
                name: 'Execution Finishes',
                value: 'executionFinishes',
                description: 'After the run finishes, whatever its status',
              },
              {
                name: 'Execution Finishes Successfully',
                value: 'executionFinishesSuccessfully',
                description: 'Only when the run succeeds; otherwise the message goes back to the queue',
              },
              {
                name: 'Immediately',
                value: 'immediately',
                description: 'As soon as the message arrives. It is lost if the run then fails.',
              },
              {
                name: 'Specified Later in Workflow',
                value: 'laterMessageNode',
                description:
                  'When a RabbitMQ node with the operation Delete From Queue runs. Add that node to the workflow. If none runs, the run ends the wait.',
              },
            ],
          },
          {
            displayName: 'Durable',
            name: 'durable',
            type: 'boolean',
            default: true,
            description: 'Whether the queue (and an exchange declared by the trigger) survives a broker restart',
          },
          {
            displayName: 'Exclusive',
            name: 'exclusive',
            type: 'boolean',
            default: false,
            description: 'Whether only this connection may use the queue',
          },
          {
            displayName: 'Headers',
            name: 'headers',
            type: 'fixedCollection',
            placeholder: 'Add header',
            default: { header: [] },
            typeOptions: { multipleValues: true },
            description: 'Headers to match when the queue is bound to a headers exchange',
            options: [
              {
                displayName: 'Header',
                name: 'header',
                values: [
                  { displayName: 'Key', name: 'key', type: 'string', default: '' },
                  { displayName: 'Value', name: 'value', type: 'string', default: '' },
                ],
              },
            ],
          },
          {
            displayName: 'JSON Parse Body',
            name: 'jsonParseBody',
            type: 'boolean',
            default: false,
            description: 'Whether to parse the body to an object',
            displayOptions: { hide: { contentIsBinary: [true] } },
          },
          {
            displayName: 'Only Content',
            name: 'onlyContent',
            type: 'boolean',
            default: false,
            description: 'Whether to return only the content property',
            displayOptions: { hide: { contentIsBinary: [true] } },
          },
          {
            displayName: 'Parallel Message Processing Limit',
            name: 'parallelMessages',
            type: 'number',
            default: -1,
            description: 'The most messages processed at once. -1 means no limit.',
            displayOptions: { hide: { acknowledge: ['immediately'] } },
          },
        ],
      },
    ],
  },

  methods: {
    credentialTest: { rabbitmqCredentialTest },
  },

  async trigger(ctx) {
    const settings = readTriggerSettings(ctx);
    const credentials = await ctx.getCredentials<RabbitMqCredentials>('rabbitmq');
    const connection: ChannelModel = await openRabbit(ctx, credentials);

    let closing = false;
    let failed = false;
    const fail = (error: Error) => {
      if (closing || failed) return;
      failed = true;
      ctx.emitError(error);
    };
    let connectionError: unknown;
    connection.on('error', (error: Error) => {
      connectionError = error;
      fail(new Error('The RabbitMQ connection failed'));
    });
    connection.on('close', () => fail(new Error('The RabbitMQ connection closed unexpectedly')));

    let channel: Channel;
    try {
      channel = await connection.createChannel();
      channel.on('error', () => fail(new Error('The RabbitMQ channel failed')));
      channel.on('close', () => fail(new Error('The RabbitMQ channel closed unexpectedly')));
      await prepareQueue(connection, channel, settings);
      if (settings.prefetch > 0) await channel.prefetch(settings.prefetch);
    } catch (error) {
      closing = true;
      // a refusal that closes the connection reports its reason there, one turn later than the reply
      await new Promise((resolve) => setImmediate(resolve));
      await connection.close().catch(() => undefined);
      throw new Error(describeSetupError(connectionError ?? error));
    }

    const tracker = createTracker({
      channel,
      mode: settings.acknowledge,
      parse: createMessageParser(ctx, settings.message),
      emit: (data, done, hook) => ctx.emit(data, done, hook),
      logger: ctx.logger,
    });

    let consumerTag: string | undefined;
    const consume = async (onMessage: (message: ConsumeMessage) => void) => {
      const started = await channel.consume(
        settings.queue,
        (message) => {
          // null: the broker cancelled the consumer, for instance because the queue was deleted
          if (message === null) fail(new Error('RabbitMQ stopped the consumer of the queue'));
          else onMessage(message);
        },
        { noAck: false },
      );
      consumerTag = started.consumerTag;
    };

    const cancelConsumer = async () => {
      if (consumerTag === undefined) return;
      const tag = consumerTag;
      consumerTag = undefined;
      await channel.cancel(tag).catch(() => undefined);
    };

    /** a test run: one message, from the queue if one is waiting, else the next one that arrives */
    const takeOne = async () => {
      const waiting = await channel.get(settings.queue, { noAck: false });
      if (waiting) {
        await tracker.handle(waiting);
        return;
      }
      let taken = false;
      await consume((message) => {
        if (taken) {
          // never more than one: the rest stays in the queue
          try {
            channel.nack(message, false, true);
          } catch {
            // the channel is gone, and the broker takes the message back by itself
          }
          return;
        }
        taken = true;
        void cancelConsumer().then(() => tracker.handle(message));
      });
    };

    const start = () => consume((message) => void tracker.handle(message));

    const closeFunction = async () => {
      closing = true;
      tracker.stop();
      await cancelConsumer();
      await tracker.drain();
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    };

    if (settings.manual) return { closeFunction, manualTriggerFunction: takeOne };

    try {
      await start();
    } catch (error) {
      await closeFunction();
      throw error;
    }
    return { closeFunction };
  },
};
