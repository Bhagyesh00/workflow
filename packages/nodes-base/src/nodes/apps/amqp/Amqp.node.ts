/** AMQP Sender: sends one AMQP 1.0 message per input item to a queue or topic (rhea). */
import { type DataObject, type Item, NodeOperationError, type NodeType } from '@workflow/workflow';
import {
  type AmqpCredentials,
  amqpCredentialTest,
  CONNECTION_FIELDS,
  closeAmqp,
  openAmqp,
  readConnectionOptions,
  sendMessage,
} from './connect';

const isObject = (value: unknown): value is DataObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const AmqpNode: NodeType = {
  description: {
    name: 'app.amqp',
    displayName: 'AMQP Sender',
    description: 'Sends messages to an AMQP 1.0 queue or topic',
    icon: 'simple:amqp',
    iconColor: '#ff6600',
    group: ['output'],
    version: 1,
    usableAsTool: true,
    defaults: { name: 'AMQP Sender' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication'],
    alias: ['amqp', 'amqp 1.0', 'message', 'queue', 'topic', 'broker'],
    credentials: [{ name: 'amqp', required: true, testedBy: 'amqpCredentialTest' }],
    properties: [
      {
        displayName: 'Queue / Topic',
        name: 'sink',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'topic://sourcename.something',
        description: 'The queue or topic to send the messages to',
      },
      {
        displayName: 'Headers',
        name: 'headerParametersJson',
        type: 'json',
        default: '',
        description: 'Application properties sent with each message, as a JSON object',
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
            displayName: 'Send Property',
            name: 'sendOnlyProperty',
            type: 'string',
            default: '',
            description: 'Send only this property of the item as the message. Empty: send the whole item.',
          },
          {
            displayName: 'Send As Object',
            name: 'dataAsObject',
            type: 'boolean',
            default: false,
            description: 'Whether to send an object as an AMQP map. Off: an object is sent as JSON text.',
          },
          ...CONNECTION_FIELDS.slice(1),
        ],
      },
    ],
  },

  methods: { credentialTest: { amqpCredentialTest } },

  async execute(ctx) {
    const items = ctx.getInputData();
    const sink = String(ctx.getNodeParameter('sink', 0, '') ?? '').trim();
    if (!sink) throw new NodeOperationError(ctx.getNode(), 'Queue / Topic is required');
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const property = typeof options.sendOnlyProperty === 'string' ? options.sendOnlyProperty.trim() : '';
    const asObject = options.dataAsObject === true;

    let headers: DataObject | undefined;
    const rawHeaders = ctx.getNodeParameter('headerParametersJson', 0, '');
    if (isObject(rawHeaders)) headers = rawHeaders;
    else if (typeof rawHeaders === 'string' && rawHeaders.trim()) {
      try {
        const parsed: unknown = JSON.parse(rawHeaders);
        if (!isObject(parsed)) throw new Error('not an object');
        headers = parsed;
      } catch {
        throw new NodeOperationError(ctx.getNode(), 'Headers must be a JSON object');
      }
    }

    const credentials = await ctx.getCredentials<AmqpCredentials>('amqp');
    const connection = await openAmqp(ctx, credentials, readConnectionOptions(options));
    const out: Item[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        try {
          const json = items[i]!.json;
          const payload = property ? json[property] : json;
          const body =
            asObject && isObject(payload)
              ? payload
              : typeof payload === 'string'
                ? payload
                : JSON.stringify(payload ?? null);
          const sent = await sendMessage(connection, sink, {
            body,
            ...(headers ? { application_properties: headers } : {}),
          });
          out.push({ json: { sent: true, id: sent.id, sink }, pairedItem: { item: i } });
        } catch (error) {
          if (!ctx.continueOnFail()) {
            throw error instanceof NodeOperationError
              ? error
              : new NodeOperationError(ctx.getNode(), (error as Error).message, { itemIndex: i });
          }
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
        }
      }
    } finally {
      await closeAmqp(connection);
    }
    return [out];
  },
};
