/**
 * MQTT node (n8n behaviour): publish each input item to a topic, with QoS and retain. The message is the
 * item as JSON ("Send Input Data") or a text you write. The broker socket goes through the SSRF guard.
 */
import { type DataObject, type Item, NodeOperationError, type NodeType } from '@workflow/workflow';
import type { MqttClient } from 'mqtt';
import { closeMqtt, type MqttCredentials, mqttCredentialTest, openMqtt } from './client';

export const MqttNode: NodeType = {
  description: {
    name: 'app.mqtt',
    displayName: 'MQTT',
    description: 'Publishes messages to an MQTT topic',
    icon: 'simple:mqtt',
    iconColor: '#660066',
    group: ['input'],
    version: 1,
    defaults: { name: 'MQTT' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication'],
    alias: ['mqtt', 'iot', 'publish', 'message', 'broker'],
    credentials: [{ name: 'mqtt', required: true, testedBy: 'mqttCredentialTest' }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'publish',
        options: [
          {
            name: 'Send a Message',
            value: 'publish',
            description: 'Publish a message to a topic',
            action: 'Publish a message to an MQTT topic',
          },
        ],
      },
      {
        displayName: 'Topic',
        name: 'topic',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'sensors/room1',
        description: 'The topic to publish to',
      },
      {
        displayName: 'Send Input Data',
        name: 'sendInputData',
        type: 'boolean',
        default: true,
        description: 'Whether to send the data the node receives as JSON',
      },
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        default: '',
        description: 'The text to publish',
        displayOptions: { show: { sendInputData: [false] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'QoS',
            name: 'qos',
            type: 'options',
            default: 0,
            description: 'The quality of service the message is sent with',
            options: [
              { name: '0 - At Most Once', value: 0 },
              { name: '1 - At Least Once', value: 1 },
              { name: '2 - Exactly Once', value: 2 },
            ],
          },
          {
            displayName: 'Retain',
            name: 'retain',
            type: 'boolean',
            default: false,
            description: 'Whether the broker keeps the message and sends it to new subscribers of the topic',
          },
        ],
      },
    ],
  },

  methods: {
    credentialTest: { mqttCredentialTest },
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    if (items.length === 0) return [[]];
    const creds = (await ctx.getCredentials('mqtt')) as MqttCredentials;
    const client: MqttClient = await openMqtt(ctx, creds);
    client.on('error', () => undefined);
    // the client never reconnects, so a publish that is open when the connection goes never settles
    const lost = new Promise<never>((_resolve, reject) => {
      client.once('close', () => reject(new Error('The MQTT connection closed')));
    });
    lost.catch(() => undefined);
    const results: Item[] = [];
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        try {
          const topic = String(ctx.getNodeParameter('topic', index, '') ?? '').trim();
          if (!topic) throw new NodeOperationError(ctx.getNode(), 'Topic is required', { itemIndex: index });
          const options = ctx.getNodeParameter('options', index, {}) as DataObject;
          const qos = Number(options.qos ?? 0);
          if (qos !== 0 && qos !== 1 && qos !== 2) {
            throw new NodeOperationError(ctx.getNode(), 'The QoS must be 0, 1 or 2', { itemIndex: index });
          }
          const message =
            ctx.getNodeParameter('sendInputData', index, true) === false
              ? String(ctx.getNodeParameter('message', index, '') ?? '')
              : JSON.stringify(item.json);
          try {
            await Promise.race([
              client.publishAsync(topic, message, { qos, retain: options.retain === true }),
              lost,
            ]);
          } catch {
            throw new NodeOperationError(ctx.getNode(), "Couldn't publish the MQTT message", {
              itemIndex: index,
            });
          }
          results.push({ json: { ...item.json }, pairedItem: { item: index } });
        } catch (error) {
          if (ctx.continueOnFail()) {
            results.push({ json: { error: (error as Error).message }, pairedItem: { item: index } });
            continue;
          }
          throw error;
        }
      }
    } finally {
      await closeMqtt(client);
    }
    return [results];
  },
};
