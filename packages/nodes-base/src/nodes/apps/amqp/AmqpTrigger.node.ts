/** AMQP Trigger: starts a run for each message of an AMQP 1.0 queue or topic (rhea). */
import type { DataObject, NodeType } from '@workflow/workflow';
import type { EventContext, Receiver } from 'rhea';
import {
  type AmqpCredentials,
  amqpCredentialTest,
  type BodyOptions,
  closeAmqp,
  CONNECTION_FIELDS,
  messageToJson,
  openAmqp,
  readConnectionOptions,
} from './connect';

const DEFAULT_PULL = 100;

export const AmqpTriggerNode: NodeType = {
  description: {
    name: 'app.amqpTrigger',
    displayName: 'AMQP Trigger',
    description: 'Starts a run on AMQP 1.0 messages from a queue or topic',
    icon: 'simple:amqp',
    iconColor: '#ff6600',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'AMQP Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication', 'Triggers'],
    eventTriggerDescription: 'Waiting for a message from the AMQP broker',
    credentials: [{ name: 'amqp', required: true, testedBy: 'amqpCredentialTest' }],
    properties: [
      {
        displayName: 'Queue / Topic',
        name: 'sink',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'topic://sourcename.something',
        description: 'The queue or topic to read messages from',
      },
      {
        displayName: 'Client Name',
        name: 'clientname',
        type: 'string',
        default: '',
        placeholder: 'for durable/persistent topic subscriptions, example: "n8n"',
        description: 'The container id for a durable subscription. Needs a Subscription too.',
      },
      {
        displayName: 'Subscription',
        name: 'subscription',
        type: 'string',
        default: '',
        placeholder: 'for durable/persistent topic subscriptions, example: "order-worker"',
        description: 'The name of a durable subscription, kept by the broker while this trigger is off',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          ...CONNECTION_FIELDS.slice(0, 1),
          {
            displayName: 'Convert Body To String',
            name: 'convertBodyToString',
            type: 'boolean',
            default: false,
            description: 'Whether to turn a body sent as bytes into text',
          },
          {
            displayName: 'JSON Parse Body',
            name: 'jsonParseBody',
            type: 'boolean',
            default: false,
            description: 'Whether to parse a text body as JSON. Turn on Convert Body To String for a body sent as bytes.',
          },
          {
            displayName: 'Messages per Cycle',
            name: 'pullMessagesNumber',
            type: 'number',
            default: DEFAULT_PULL,
            description: 'How many messages the broker may send before earlier ones are processed',
          },
          {
            displayName: 'Only Body',
            name: 'onlyBody',
            type: 'boolean',
            default: false,
            description: 'Whether to return only the body of the message, without its headers and properties',
          },
          {
            displayName: 'Parallel Processing',
            name: 'parallelProcessing',
            type: 'boolean',
            default: true,
            description: 'Whether to start runs for several messages at once. Off: one message at a time, the next after the run finishes.',
          },
          ...CONNECTION_FIELDS.slice(1),
        ],
      },
    ],
  },

  methods: { credentialTest: { amqpCredentialTest } },

  async trigger(ctx) {
    const sink = String(ctx.getNodeParameter('sink', 0, '') ?? '').trim();
    if (!sink) throw new Error('Queue / Topic is required');
    const clientname = String(ctx.getNodeParameter('clientname', 0, '') ?? '').trim();
    const subscription = String(ctx.getNodeParameter('subscription', 0, '') ?? '').trim();
    if (Boolean(clientname) !== Boolean(subscription)) {
      throw new Error('A durable subscription needs both a Client Name and a Subscription');
    }
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const connectionOptions = readConnectionOptions(options);
    const body: BodyOptions = {
      convertBodyToString: options.convertBodyToString === true,
      jsonParseBody: options.jsonParseBody === true,
      onlyBody: options.onlyBody === true,
    };
    const pull = Math.max(1, Math.floor(Number(options.pullMessagesNumber ?? DEFAULT_PULL)) || DEFAULT_PULL);
    const parallel = options.parallelProcessing !== false;
    const manual = ctx.getActivationMode() === 'manual';

    const credentials = await ctx.getCredentials<AmqpCredentials>('amqp');
    let closing = false;
    let failed = false;
    const fail = (error: Error) => {
      if (closing || failed) return;
      failed = true;
      ctx.emitError(error);
    };
    const connection = await openAmqp(
      ctx,
      credentials,
      { ...connectionOptions, containerId: connectionOptions.containerId ?? (clientname || undefined) },
      fail,
    );

    /** runs that were started and have not ended; a close ends the wait for them */
    const waiting = new Set<() => void>();
    let receiver: Receiver | undefined;
    let busy = false;

    const onMessage = async (context: EventContext) => {
      const message = context.message as unknown as Record<string, unknown>;
      const delivery = context.delivery!;
      const release = () => {
        try {
          delivery.release();
        } catch {
          // the link is gone
        }
      };
      // a run cannot start any more: an accept would settle a message nobody got
      if (closing) {
        release();
        return;
      }
      let ended: Promise<void> = Promise.resolve();
      try {
        const json = messageToJson(message, body);
        ended = new Promise<void>((resolve) => {
          waiting.add(resolve);
          const finish = () => {
            waiting.delete(resolve);
            resolve();
          };
          ctx.emit([[{ json }]], { resolve: finish, reject: finish });
        });
        delivery.accept();
      } catch (error) {
        // the message could not be turned into an item: the broker keeps it for another consumer
        ctx.logger.debug(`AMQP message not delivered: ${(error as Error).message}`);
        release();
        return;
      }
      if (manual) {
        receiver?.close();
        return;
      }
      if (!parallel) {
        busy = true;
        await ended;
        busy = false;
        if (!closing) receiver?.add_credit(1);
      }
    };

    const start = (limit?: number) => {
      const sequential = limit !== undefined || !parallel;
      receiver = connection.open_receiver({
        source: subscription
          ? { address: sink, durable: 2, expiry_policy: 'never' }
          : { address: sink },
        ...(subscription ? { name: subscription } : {}),
        autoaccept: false,
        credit_window: sequential ? 0 : pull,
      });
      receiver.on('message', (context: EventContext) => void onMessage(context));
      receiver.on('receiver_error', () => fail(new Error('The AMQP broker refused the link to the queue or topic')));
      receiver.on('receiver_close', () => {
        if (!manual) fail(new Error('The AMQP broker closed the link to the queue or topic'));
      });
      if (sequential) {
        // a first credit now and one more each time a run ends; a reopened link starts with none
        receiver.on('receiver_open', () => {
          if (!busy) receiver?.add_credit(limit ?? 1);
        });
      }
    };

    const closeFunction = async () => {
      closing = true;
      for (const release of [...waiting]) release();
      try {
        receiver?.close();
      } catch {
        // the connection is already gone
      }
      await closeAmqp(connection);
    };

    if (manual) return { closeFunction, manualTriggerFunction: async () => start(1) };

    try {
      start();
    } catch (error) {
      await closeFunction();
      throw error;
    }
    return { closeFunction };
  },
};
