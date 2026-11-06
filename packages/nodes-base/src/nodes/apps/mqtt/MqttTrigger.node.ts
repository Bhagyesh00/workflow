/** MQTT Trigger: behaviour of n8n's node on mqtt.js, with the SSRF guard on the broker socket. */
import type { DataObject, Item, NodeType, TriggerContext } from '@workflow/workflow';
import type { MqttClient } from 'mqtt';
import { type MqttCredentials, mqttCredentialTest, openMqtt } from './client';

/** more messages than this waiting for the previous run (ordered mode) are dropped with a warning */
export const ORDERED_BACKLOG_LIMIT = 1000;
const CLOSE_WAIT_MS = 2000;

export interface TopicSetting {
  topic: string;
  qos: 0 | 1 | 2;
}

export interface TriggerSettings {
  topics: TopicSetting[];
  jsonParseBody: boolean;
  onlyMessage: boolean;
  parallelProcessing: boolean;
}

/** the topics (last row wins for a repeated topic) and the options; a bad value is a clear error */
export function readSettings(ctx: Pick<TriggerContext, 'getNodeParameter'>): TriggerSettings {
  const ui = ctx.getNodeParameter('topicsUi', 0, {}) as DataObject;
  const rows = ((ui.topicsValues as DataObject[] | undefined) ?? []).filter(Boolean);
  const byTopic = new Map<string, TopicSetting>();
  for (const row of rows) {
    const topic = String(row.topic ?? '').trim();
    if (!topic) continue;
    const qos = Number(row.qos ?? 0);
    if (qos !== 0 && qos !== 1 && qos !== 2) throw new Error('The QoS of a topic must be 0, 1 or 2');
    byTopic.set(topic, { topic, qos });
  }
  if (byTopic.size === 0) throw new Error('Add at least one topic to subscribe to');
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  return {
    topics: [...byTopic.values()],
    jsonParseBody: options.jsonParseBody === true,
    onlyMessage: options.onlyMessage === true,
    parallelProcessing: options.parallelProcessing !== false,
  };
}

/** the item of one message; a body that is not JSON stays text */
export function buildItem(
  topic: string,
  payload: Buffer,
  settings: Pick<TriggerSettings, 'jsonParseBody' | 'onlyMessage'>,
  warn: (message: string) => void,
): Item {
  let message: unknown = payload.toString('utf8');
  if (settings.jsonParseBody) {
    try {
      message = JSON.parse(message as string);
    } catch {
      warn('Could not parse the message body to JSON, returning it as text');
    }
  }
  if (settings.onlyMessage) {
    const isObject = typeof message === 'object' && message !== null && !Array.isArray(message);
    return { json: (isObject ? message : { message }) as DataObject };
  }
  return { json: { message, topic } as DataObject };
}

export const MqttTriggerNode: NodeType = {
  description: {
    name: 'app.mqttTrigger',
    displayName: 'MQTT Trigger',
    description: 'Subscribes to topics with per-topic QoS',
    icon: 'simple:mqtt',
    iconColor: '#660066',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'MQTT Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication', 'Triggers'],
    eventTriggerDescription: 'Waiting for a message on the MQTT topics',
    credentials: [{ name: 'mqtt', required: true, testedBy: 'mqttCredentialTest' }],
    properties: [
      {
        displayName: 'Topics',
        name: 'topicsUi',
        type: 'fixedCollection',
        placeholder: 'Add topic',
        default: { topicsValues: [{ topic: '', qos: 0 }] },
        typeOptions: { multipleValues: true },
        description: 'Topics to subscribe to. Wildcards + and # work.',
        options: [
          {
            displayName: 'Topic',
            name: 'topicsValues',
            values: [
              {
                displayName: 'Topic',
                name: 'topic',
                type: 'string',
                default: '',
                placeholder: 'sensors/#',
                description: 'The topic or topic filter to subscribe to',
              },
              {
                displayName: 'QoS',
                name: 'qos',
                type: 'options',
                default: 0,
                description: 'The quality of service the broker delivers this topic with',
                options: [
                  { name: '0 - At Most Once', value: 0 },
                  { name: '1 - At Least Once', value: 1 },
                  { name: '2 - Exactly Once', value: 2 },
                ],
              },
            ],
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'JSON Parse Body',
            name: 'jsonParseBody',
            type: 'boolean',
            default: false,
            description: 'Whether to parse the body to an object. A body that is not JSON stays text.',
          },
          {
            displayName: 'Only Message',
            name: 'onlyMessage',
            type: 'boolean',
            default: false,
            description: 'Whether to return only the message, without the topic',
          },
          {
            displayName: 'Parallel Processing',
            name: 'parallelProcessing',
            type: 'boolean',
            default: true,
            description:
              'Whether to start a run for every message at once. When off, a message waits until the run of the one before has finished.',
          },
        ],
      },
    ],
  },

  methods: {
    credentialTest: { mqttCredentialTest },
  },

  async trigger(ctx) {
    const settings = readSettings(ctx);
    const credentials = await ctx.getCredentials<MqttCredentials>('mqtt');
    const client: MqttClient = await openMqtt(ctx, credentials);

    let closing = false;
    let failed = false;
    const fail = (error: Error) => {
      if (closing || failed) return;
      failed = true;
      ctx.emitError(error);
    };
    client.on('error', () => fail(new Error('The MQTT connection failed')));
    client.on('close', () => fail(new Error('The MQTT connection closed unexpectedly')));

    const closeFunction = async () => {
      closing = true;
      await Promise.race([
        client.endAsync().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS)),
      ]);
      await client.endAsync(true).catch(() => undefined);
    };

    try {
      const granted = await client.subscribeAsync(
        Object.fromEntries(settings.topics.map(({ topic, qos }) => [topic, { qos }])),
      );
      // 128 is the broker's refusal of a topic
      const refused = granted.find((grant) => grant.qos === 128);
      if (refused) throw new Error(`MQTT refused the subscription to ${refused.topic}`);
    } catch (error) {
      await closeFunction();
      throw error instanceof Error && error.message.startsWith('MQTT refused')
        ? error
        : new Error("Couldn't subscribe to the MQTT topics");
    }

    const itemOf = (topic: string, payload: Buffer) =>
      buildItem(topic, payload, settings, (message) => ctx.logger.warn(message));

    if (ctx.getActivationMode() === 'manual') {
      // a test run: the first message starts one run and ends the wait
      const manualTriggerFunction = () =>
        new Promise<void>((resolve) => {
          let taken = false;
          client.on('message', (topic, payload) => {
            if (taken) return;
            taken = true;
            ctx.emit([[itemOf(topic, payload)]]);
            resolve();
          });
        });
      return { closeFunction, manualTriggerFunction };
    }

    let previous: Promise<void> = Promise.resolve();
    let waiting = 0;
    client.on('message', (topic, payload) => {
      const item = itemOf(topic, payload);
      if (settings.parallelProcessing) {
        ctx.emit([[item]]);
        return;
      }
      if (waiting >= ORDERED_BACKLOG_LIMIT) {
        ctx.logger.warn('MQTT messages are arriving faster than the runs finish, a message was dropped');
        return;
      }
      waiting++;
      previous = previous.then(
        () =>
          new Promise<void>((resolve) => {
            if (closing) {
              waiting--;
              resolve();
              return;
            }
            const finish = () => {
              waiting--;
              resolve();
            };
            ctx.emit([[item]], { resolve: finish, reject: finish });
          }),
      );
    });

    return { closeFunction };
  },
};
