/**
 * RabbitMQ (n8n node version 1.2 behaviour): send a message to a queue or an exchange, and delete from
 * queue, which answers the broker for the message a RabbitMQ Trigger started this run with (the trigger's
 * "Specified Later in Workflow" acknowledge mode). The broker socket goes through the SSRF guard.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import type { Channel, ChannelModel, ConfirmChannel } from 'amqplib';
import { describeSetupError, openRabbit, type RabbitMqCredentials, rabbitmqCredentialTest } from './connect';
import { keyValueTable } from './tracker';

const EXCHANGE_TYPES = ['direct', 'topic', 'headers', 'fanout'];

const keyValueRows = (
  displayName: string,
  name: string,
  rowName: string,
  rowDisplayName: string,
  description: string,
): NodeProperty => ({
  displayName,
  name,
  type: 'fixedCollection',
  placeholder: 'Add row',
  default: { [rowName]: [] },
  typeOptions: { multipleValues: true },
  description,
  options: [
    {
      displayName: rowDisplayName,
      name: rowName,
      values: [
        { displayName: 'Key', name: 'key', type: 'string', default: '' },
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
      ],
    },
  ],
});

const sendOnly = { show: { operation: ['sendMessage'] } };

const properties: NodeProperty[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    default: 'sendMessage',
    options: [
      {
        name: 'Send a Message',
        value: 'sendMessage',
        description: 'Send a message to a queue or an exchange',
        action: 'Send a message to RabbitMQ',
      },
      {
        name: 'Delete From Queue',
        value: 'deleteMessage',
        description: 'Answer the broker for the message the RabbitMQ Trigger started this run with',
        action: 'Delete the trigger message from the queue',
      },
    ],
  },
  {
    displayName: 'Mode',
    name: 'mode',
    type: 'options',
    noDataExpression: true,
    default: 'queue',
    displayOptions: sendOnly,
    options: [
      { name: 'Queue', value: 'queue', description: 'Send the message straight to a queue' },
      { name: 'Exchange', value: 'exchange', description: 'Publish the message to an exchange' },
    ],
  },
  {
    displayName: 'Queue / Topic',
    name: 'queue',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'queue-name',
    description: 'The name of the queue to send to',
    displayOptions: { show: { operation: ['sendMessage'], mode: ['queue'] } },
  },
  {
    displayName: 'Exchange',
    name: 'exchange',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'exchange-name',
    description: 'The name of the exchange to publish to',
    displayOptions: { show: { operation: ['sendMessage'], mode: ['exchange'] } },
  },
  {
    displayName: 'Type',
    name: 'exchangeType',
    type: 'options',
    default: 'fanout',
    description: 'The type the exchange is declared with',
    displayOptions: { show: { operation: ['sendMessage'], mode: ['exchange'] } },
    options: [
      { name: 'Direct', value: 'direct' },
      { name: 'Topic', value: 'topic' },
      { name: 'Headers', value: 'headers' },
      { name: 'Fanout', value: 'fanout' },
    ],
  },
  {
    displayName: 'Routing Key',
    name: 'routingKey',
    type: 'string',
    default: '',
    description: 'The routing key of the message',
    displayOptions: { show: { operation: ['sendMessage'], mode: ['exchange'] } },
  },
  {
    displayName: 'Send Input Data',
    name: 'sendInputData',
    type: 'boolean',
    default: true,
    description: 'Whether to send the data the node receives as JSON',
    displayOptions: sendOnly,
  },
  {
    displayName: 'Message',
    name: 'message',
    type: 'string',
    default: '',
    description: 'The message to send',
    displayOptions: { show: { operation: ['sendMessage'], sendInputData: [false] } },
  },
  {
    ...keyValueRows('Headers', 'headers', 'header', 'Header', 'Headers sent with the message'),
    displayOptions: sendOnly,
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add option',
    default: {},
    displayOptions: sendOnly,
    options: [
      {
        displayName: 'Alternate Exchange',
        name: 'alternateExchange',
        type: 'string',
        default: '',
        description: 'An exchange that takes the messages this exchange cannot route (exchange mode)',
      },
      keyValueRows(
        'Arguments',
        'arguments',
        'argument',
        'Argument',
        'Arguments the queue is declared with, for example x-message-ttl (queue mode)',
      ),
      {
        displayName: 'Auto Delete Queue',
        name: 'autoDelete',
        type: 'boolean',
        default: false,
        description: 'Whether to delete the queue or exchange when the last consumer leaves',
      },
      {
        displayName: 'Durable',
        name: 'durable',
        type: 'boolean',
        default: true,
        description: 'Whether the queue or exchange survives a restart of the broker',
      },
      {
        displayName: 'Exclusive',
        name: 'exclusive',
        type: 'boolean',
        default: false,
        description: 'Whether only this connection may use the queue (queue mode)',
      },
    ],
  },
];

/** the send for one item; it gets a channel of its own, because a refused setup closes the channel it ran on */
async function sendOne(
  ctx: ExecuteContext,
  connection: ChannelModel,
  index: number,
  item: Item,
): Promise<void> {
  const mode = String(ctx.getNodeParameter('mode', index, 'queue'));
  const options = ctx.getNodeParameter('options', index, {}) as DataObject;
  const durable = options.durable !== false;
  const autoDelete = options.autoDelete === true;
  const sendInput = ctx.getNodeParameter('sendInputData', index, true) !== false;
  const body = sendInput ? JSON.stringify(item.json) : String(ctx.getNodeParameter('message', index, ''));
  const headers = keyValueTable(ctx.getNodeParameter('headers', index, {}), 'header');
  const publishOptions = Object.keys(headers).length > 0 ? { headers } : {};
  const content = Buffer.from(body, 'utf8');

  let setup: (channel: Channel) => Promise<void>;
  let send: (channel: ConfirmChannel, done: (error: unknown) => void) => void;
  if (mode === 'exchange') {
    const exchange = String(ctx.getNodeParameter('exchange', index, '')).trim();
    if (!exchange) throw new NodeOperationError(ctx.getNode(), 'Exchange is required', { itemIndex: index });
    const type = String(ctx.getNodeParameter('exchangeType', index, 'fanout'));
    if (!EXCHANGE_TYPES.includes(type)) {
      throw new NodeOperationError(ctx.getNode(), `The exchange type "${type}" is not supported`, {
        itemIndex: index,
      });
    }
    const routingKey = type === 'headers' ? '' : String(ctx.getNodeParameter('routingKey', index, ''));
    const alternate = typeof options.alternateExchange === 'string' ? options.alternateExchange.trim() : '';
    setup = async (channel) => {
      await channel.assertExchange(exchange, type, {
        durable,
        autoDelete,
        ...(alternate ? { alternateExchange: alternate } : {}),
      });
    };
    send = (channel, done) => void channel.publish(exchange, routingKey, content, publishOptions, done);
  } else {
    const queue = String(ctx.getNodeParameter('queue', index, '')).trim();
    if (!queue)
      throw new NodeOperationError(ctx.getNode(), 'Queue / Topic is required', { itemIndex: index });
    setup = async (channel) => {
      await channel.assertQueue(queue, {
        durable,
        autoDelete,
        exclusive: options.exclusive === true,
        arguments: keyValueTable(options.arguments, 'argument'),
      });
    };
    send = (channel, done) => void channel.sendToQueue(queue, content, publishOptions, done);
  }

  const channel = await connection.createConfirmChannel();
  channel.on('error', () => undefined);
  try {
    await setup(channel);
    await new Promise<void>((resolve, reject) => {
      send(channel, (error) => (error ? reject(error as Error) : resolve()));
    });
  } finally {
    await channel.close().catch(() => undefined);
  }
}

export const RabbitMqNode: NodeType = {
  description: {
    name: 'app.rabbitmq',
    displayName: 'RabbitMQ',
    description: 'Sends messages to a queue or exchange and deletes messages from a queue',
    icon: 'simple:rabbitmq',
    iconColor: '#ff6600',
    group: ['transform'],
    version: 1,
    defaults: { name: 'RabbitMQ' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools'],
    alias: ['rabbitmq', 'rabbit', 'amqp', 'message', 'queue', 'broker'],
    credentials: [{ name: 'rabbitmq', required: true, testedBy: 'rabbitmqCredentialTest' }],
    properties,
  },

  methods: {
    credentialTest: { rabbitmqCredentialTest },
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    if (items.length === 0) return [[]];
    const operation = String(ctx.getNodeParameter('operation', 0, 'sendMessage'));

    if (operation === 'deleteMessage') {
      // the trigger's response hook answers the broker for its message; this node opens no connection
      ctx.sendResponse({});
      return [items.map((item, index) => ({ json: { ...item.json }, pairedItem: { item: index } }))];
    }
    if (operation !== 'sendMessage') {
      throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not supported`);
    }

    const creds = (await ctx.getCredentials('rabbitmq')) as RabbitMqCredentials;
    const connection = await openRabbit(ctx, creds);
    connection.on('error', () => undefined);
    const results: Item[] = [];
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        try {
          await sendOne(ctx, connection, index, item);
          results.push({ json: { ...item.json }, pairedItem: { item: index } });
        } catch (error) {
          const text = error instanceof NodeOperationError ? error.message : describeSetupError(error);
          if (ctx.continueOnFail()) {
            results.push({ json: { error: text }, pairedItem: { item: index } });
            continue;
          }
          if (error instanceof NodeOperationError) throw error;
          throw new NodeOperationError(ctx.getNode(), `Couldn't send the RabbitMQ message: ${text}`, {
            itemIndex: index,
          });
        }
      }
    } finally {
      await connection.close().catch(() => undefined);
    }
    return [results];
  },
};
