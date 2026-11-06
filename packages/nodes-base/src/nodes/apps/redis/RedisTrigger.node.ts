/**
 * Redis Trigger: starts a run on pub/sub messages. Every channel entry is subscribed as a pattern
 * (PSUBSCRIBE), so plain names and globs both work. The connection goes through openRedis (SSRF guard).
 */
import type { NodeType, TriggerContext, TriggerResponse } from '@workflow/workflow';
import { openRedis, type RedisCredentials, redisCredentialTest } from '../../../utils/redis-connect';

const MANUAL_WAIT_MS = 60_000;

/** reconnect policy: this many tries, doubling from baseMs up to maxMs; then the trigger reports an error */
export const redisRetry = { attempts: 10, baseMs: 1000, maxMs: 60_000 };

interface Message {
  channel: string;
  raw: string;
}

export const RedisTriggerNode: NodeType = {
  description: {
    name: 'app.redisTrigger',
    displayName: 'Redis Trigger',
    description: 'Starts a run on pub/sub messages',
    icon: 'simple:redis',
    iconColor: '#dc382d',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Redis Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Data & Storage', 'Triggers'],
    eventTriggerDescription: 'Waiting for a message on Redis',
    credentials: [{ name: 'redis', required: true, testedBy: 'redisCredentialTest' }],
    properties: [
      {
        displayName: 'Channels',
        name: 'channels',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'orders, events.*',
        description:
          'Channels to subscribe to, separated by commas. Every entry is a pattern, so * matches any run of characters',
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
            description: 'Whether to try to parse the message as JSON; a message that is not JSON stays text',
          },
          {
            displayName: 'Only Message',
            name: 'onlyMessage',
            type: 'boolean',
            default: false,
            description: 'Whether to return only the message and not the channel',
          },
        ],
      },
    ],
  },

  async trigger(ctx: TriggerContext): Promise<TriggerResponse | undefined> {
    const manual = ctx.getActivationMode() === 'manual';
    const patterns = String(ctx.getNodeParameter('channels', 0, ''))
      .split(',')
      .filter((p) => p.length > 0);
    if (patterns.every((p) => !p.trim())) throw new Error('Channels is required');
    const jsonParseBody = ctx.getNodeParameter('options.jsonParseBody', 0, false) === true;
    const onlyMessage = ctx.getNodeParameter('options.onlyMessage', 0, false) === true;
    const creds = (await ctx.getCredentials('redis')) as RedisCredentials;

    const { attempts, baseMs, maxMs } = redisRetry;
    const client = await openRedis(ctx, creds, {
      retryStrategy: (times) => (times > attempts ? null : Math.min(maxMs, baseMs * 2 ** (times - 1))),
    });

    let closed = false;
    let failed = false;
    // the client gives up after the last try and ends; that is the one moment to report
    client.on('end', () => {
      if (closed || failed) return;
      failed = true;
      ctx.emitError(new Error('The Redis connection of the trigger was lost and could not be restored'));
    });

    const closeFunction = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      client.removeAllListeners('pmessage');
      try {
        await client.punsubscribe();
        await client.quit();
      } catch {
        // a dead connection has nothing left to close
      } finally {
        client.disconnect();
      }
    };

    const toItem = ({ channel, raw }: Message) => {
      let message: unknown = raw;
      if (jsonParseBody) {
        try {
          message = JSON.parse(raw);
        } catch {
          // not JSON: the text stays
        }
      }
      return (onlyMessage ? { message } : { channel, message }) as never;
    };

    try {
      await client.psubscribe(...patterns);
    } catch (error) {
      await closeFunction();
      throw error;
    }

    if (!manual) {
      client.on('pmessage', (_pattern, channel, raw) => {
        if (!closed) ctx.emit([[{ json: toItem({ channel, raw }) }]]);
      });
      return { closeFunction };
    }

    // a test run: the first message starts the run, a quiet minute ends the wait
    let first: Message | undefined;
    let deliver: ((m: Message) => void) | undefined;
    client.on('pmessage', (_pattern, channel, raw) => {
      if (deliver) deliver({ channel, raw });
      else first ??= { channel, raw };
    });
    const manualTriggerFunction = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          deliver = undefined;
          void closeFunction().finally(() =>
            reject(new Error('No message arrived within 60 seconds, the test was stopped')),
          );
        }, MANUAL_WAIT_MS);
        const onMessage = (m: Message) => {
          clearTimeout(timer);
          deliver = undefined;
          ctx.emit([[{ json: toItem(m) }]]);
          resolve();
        };
        if (first) onMessage(first);
        else deliver = onMessage;
      });
    return { closeFunction, manualTriggerFunction };
  },

  methods: { credentialTest: { redisCredentialTest } },
};
