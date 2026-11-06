/**
 * Phase 4 C0e contracts: the node and credential stubs the lanes fill (final names and aliases), the
 * credentialTest hook wiring, the credential fields that are final at C0, and the helpers that moved.
 */
import dns from 'node:dns';
import type { DataObject, NodeProperty, NodeType } from '@workflow/workflow';
import { evaluateSimple } from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentials, nodes } from '../src';
import { credentialTypes, testServices } from './harness';
import { startSmtpServer } from './servers';

const STUB_NODES: Array<[name: string, runs: 'execute' | 'trigger' | 'poll' | 'webhook', file: string]> = [
  ['core.formTrigger', 'webhook', '../src/nodes/core/FormTrigger.node'],
  ['core.form', 'execute', '../src/nodes/core/Form.node'],
  ['core.dataTable', 'execute', '../src/nodes/core/DataTable.node'],
  ['core.sseTrigger', 'trigger', '../src/nodes/core/SseTrigger.node'],
  ['core.rssFeedReadTrigger', 'poll', '../src/nodes/core/RssFeedReadTrigger.node'],
  ['core.emailReadImap', 'trigger', '../src/nodes/core/EmailReadImap.node'],
  ['app.postgresTrigger', 'trigger', '../src/nodes/apps/sql/PostgresTrigger.node'],
  ['app.redisTrigger', 'trigger', '../src/nodes/apps/redis/RedisTrigger.node'],
  ['app.redis', 'execute', '../src/nodes/apps/redis/Redis.node'],
  ['app.kafkaTrigger', 'trigger', '../src/nodes/apps/kafka/KafkaTrigger.node'],
  ['app.kafka', 'execute', '../src/nodes/apps/kafka/Kafka.node'],
  ['app.rabbitmqTrigger', 'trigger', '../src/nodes/apps/rabbitmq/RabbitMqTrigger.node'],
  ['app.rabbitmq', 'execute', '../src/nodes/apps/rabbitmq/RabbitMq.node'],
  ['app.mqttTrigger', 'trigger', '../src/nodes/apps/mqtt/MqttTrigger.node'],
  ['app.mqtt', 'execute', '../src/nodes/apps/mqtt/Mqtt.node'],
  ['app.amqpTrigger', 'trigger', '../src/nodes/apps/amqp/AmqpTrigger.node'],
  ['app.amqp', 'execute', '../src/nodes/apps/amqp/Amqp.node'],
];

const STUB_CREDENTIALS: Array<[name: string, displayName: string]> = [
  ['imap', 'IMAP'],
  ['kafka', 'Kafka'],
  ['schemaRegistryApi', 'Schema Registry'],
  ['rabbitmq', 'RabbitMQ'],
  ['mqtt', 'MQTT'],
  ['amqp', 'AMQP'],
];

const nodeType = (name: string): NodeType => {
  const type = nodes.find((n) => n.description.name === name);
  if (!type) throw new Error(`${name} is not registered`);
  return type;
};

/** a context that answers only from the checked address, as the real resolveAllowedHost does */
function pinnedContext(address = '127.0.0.1', credentialData: DataObject = {}) {
  const lookup = vi.fn((_hostname: string, options: unknown, callback?: unknown) => {
    const done = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
    if (typeof options === 'object' && (options as { all?: boolean }).all) {
      done(null, [{ address, family: 4 }]);
    } else done(null, address, 4);
  });
  const resolveAllowedHost = vi.fn(async () => ({ addresses: [{ address, family: 4 }], lookup }));
  return {
    lookup,
    resolveAllowedHost,
    ctx: {
      helpers: { resolveAllowedHost, assertHostAllowed: async () => {} },
      getCredentials: async () => credentialData,
    } as never,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P4 node stubs', () => {
  it.each(STUB_NODES)('%s is registered from its own file', async (name, _runs, file) => {
    const type = nodeType(name);
    const module = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    expect(Object.values(module)).toContain(type);
  });

  it('are 17 and their names are unique among all nodes', () => {
    expect(STUB_NODES).toHaveLength(17);
    const names = nodes.map((n) => n.description.name);
    for (const [name] of STUB_NODES) expect(names.filter((n) => n === name)).toEqual([name]);
  });

  it.each(STUB_NODES)('%s has its final description', (name) => {
    const d = nodeType(name).description;
    expect(d.displayName).toBeTruthy();
    expect(d.defaults.name).toBeTruthy();
    expect(d.description.length).toBeGreaterThan(10);
    expect(d.categories?.length).toBeGreaterThan(0);
    expect(d.icon).toMatch(name.startsWith('core.') ? /^lucide:/ : /^simple:/);
    if (!name.endsWith('Trigger')) expect(d.alias?.length).toBeGreaterThan(0);
    for (const credential of d.credentials ?? []) {
      expect(credentialTypes.get(credential.name), credential.name).toBeDefined();
    }
  });

  it('use the n8n codex aliases for Form and Data Table', () => {
    expect(nodeType('core.form').description.alias).toEqual([
      '_Form',
      'form',
      'table',
      'submit',
      'post',
      'page',
      'step',
      'stage',
      'multi',
    ]);
    expect(nodeType('core.dataTable').description.alias).toEqual(
      expect.arrayContaining(['data', 'table', 'knowledge', 'sheet', 'database', 'airtable', 'notion']),
    );
  });

  it.each(STUB_NODES)('%s has the entry point its kind needs', (name, runs) => {
    const type = nodeType(name);
    expect(type[runs], runs).toBeTypeOf('function');
  });

  it('Form Trigger serves a GET setup and a POST default hook, both form hooks on one full path', () => {
    const hooks = nodeType('core.formTrigger').description.webhooks ?? [];
    expect(hooks.map((h) => [h.name, h.httpMethod, h.nodeType, h.isFullPath])).toEqual([
      ['setup', 'GET', 'form', true],
      ['default', 'POST', 'form', true],
    ]);
    expect(hooks[0]!.path).toBe(hooks[1]!.path);
    const path = (parameters: DataObject) =>
      evaluateSimple(hooks[0]!.path, { $parameter: parameters }, { timeoutMs: 200 });
    expect(path({ path: 'a' })).toBe('a');
    expect(path({ options: { path: 'b' } })).toBe('b');
    expect(path({})).toBe('');
  });

  it('Form answers on the resume URL with a GET and a POST form hook', () => {
    const hooks = nodeType('core.form').description.webhooks ?? [];
    expect(hooks.map((h) => [h.httpMethod, h.nodeType, h.restartWebhook])).toEqual([
      ['GET', 'form', true],
      ['POST', 'form', true],
    ]);
  });

  it('Data Table is usable as a tool and RSS Feed Trigger polls', () => {
    expect(nodeType('core.dataTable').description.usableAsTool).toBe(true);
    expect(nodeType('core.rssFeedReadTrigger').description.polling).toBe(true);
  });
});

describe('P4 credential stubs', () => {
  it.each(STUB_CREDENTIALS)('%s is registered with its final name', (name, displayName) => {
    const credential = credentials.find((c) => c.name === name);
    expect(credential?.displayName).toBe(displayName);
    expect(credential?.hideDomainRestrictionFields).toBe(true);
  });

  it('come from the files the lanes own', async () => {
    const files = await Promise.all([
      import('../src/credentials/imap.credentials'),
      import('../src/credentials/kafka.credentials'),
      import('../src/credentials/rabbitmq.credentials'),
      import('../src/credentials/mqtt.credentials'),
      import('../src/credentials/amqp.credentials'),
    ]);
    const exported = files.flatMap((f) => Object.values(f));
    for (const [name] of STUB_CREDENTIALS) {
      expect(exported).toContain(credentials.find((c) => c.name === name));
    }
  });
});

describe('credentialTest hook', () => {
  it.each([
    ['app.postgres', ['postgres']],
    ['app.mySql', ['mySql']],
    ['core.ssh', ['sshPassword', 'sshPrivateKey']],
    ['core.ftp', ['ftp', 'sftp']],
    ['core.sendEmail', ['smtp']],
  ])('%s names a credentialTest method for each credential', (name, credentialNames) => {
    const type = nodeType(name);
    const entries = type.description.credentials ?? [];
    expect(entries.map((c) => c.name)).toEqual(credentialNames);
    for (const entry of entries) {
      expect(entry.testedBy, entry.name).toBeTruthy();
      expect(type.methods?.credentialTest?.[entry.testedBy!], entry.name).toBeTypeOf('function');
    }
  });

  it('points at the stub files in src/credential-tests', async () => {
    const stubs = [
      ['app.postgres', await import('../src/credential-tests/postgres')],
      ['app.mySql', await import('../src/credential-tests/mysql')],
      ['core.ssh', await import('../src/credential-tests/ssh')],
      ['core.ftp', await import('../src/credential-tests/ftp')],
      ['core.sendEmail', await import('../src/credential-tests/smtp')],
    ] as const;
    for (const [name, module] of stubs) {
      const methods = Object.values(nodeType(name).methods?.credentialTest ?? {});
      expect(methods.length).toBe(1);
      expect(Object.values(module)).toContain(methods[0]);
    }
  });
});

describe('credential fields that are final at C0', () => {
  const props = (name: string): NodeProperty[] => credentialTypes.getResolved(name)!.properties;
  const prop = (credential: string, name: string) => props(credential).find((p) => p.name === name);
  const secretFields = ['sshPassword', 'privateKey', 'passphrase'];

  it('redis has Disable TLS Verification, shown only with SSL on', () => {
    expect(prop('redis', 'disableTlsVerification')).toMatchObject({
      type: 'boolean',
      default: false,
      displayOptions: { show: { ssl: [true] } },
    });
  });

  it.each(['postgres', 'mySql'])('%s has a client key and certificate behind its SSL modes', (name) => {
    for (const field of ['clientPrivateKey', 'clientCertificate']) {
      expect(prop(name, field), field).toMatchObject({
        type: 'string',
        default: '',
        typeOptions: { password: true },
        displayOptions: { show: { ssl: ['allow', 'require'] } },
      });
    }
  });

  it.each(['postgres', 'mySql'])('%s has the SSH tunnel block with n8n names', (name) => {
    expect(prop(name, 'sshTunnel')).toMatchObject({ type: 'boolean', default: false });
    expect(prop(name, 'sshAuthenticateWith')).toMatchObject({
      type: 'options',
      default: 'password',
      displayOptions: { show: { sshTunnel: [true] } },
    });
    expect(prop(name, 'sshHost')).toMatchObject({ default: 'localhost' });
    expect(prop(name, 'sshPort')).toMatchObject({ default: 22 });
    expect(prop(name, 'sshUser')).toMatchObject({ default: 'root' });
    expect(prop(name, 'sshPassword')?.displayOptions?.show).toEqual({
      sshTunnel: [true],
      sshAuthenticateWith: ['password'],
    });
    for (const field of ['privateKey', 'passphrase']) {
      expect(prop(name, field)?.displayOptions?.show, field).toEqual({
        sshTunnel: [true],
        sshAuthenticateWith: ['privateKey'],
      });
    }
    // the API redacts by this flag, so every secret of the tunnel carries it
    for (const field of secretFields) expect(prop(name, field)?.typeOptions?.password, field).toBe(true);
  });

  it('no-verify stays the ssl allow mode: no second Ignore SSL field on either type', () => {
    for (const name of ['postgres', 'mySql']) {
      expect(prop(name, 'allowUnauthorizedCerts'), name).toBeUndefined();
      const values = (prop(name, 'ssl')?.options ?? []).map((o) => (o as { value: string }).value);
      expect(values, name).toEqual(['disable', 'allow', 'require']);
    }
  });

  it('existing fields keep their order, the new ones come after them', () => {
    expect(
      props('postgres')
        .slice(0, 5)
        .map((p) => p.name),
    ).toEqual(['host', 'database', 'user', 'password', 'port']);
    expect(props('postgres').at(-1)?.name).toBe('passphrase');
    expect(props('mySql').at(-1)?.name).toBe('passphrase');
  });
});

describe('moved helpers', () => {
  it('isBotUserAgent matches what the Webhook node ignored before', async () => {
    const { isBotUserAgent } = await import('../src/utils/bots');
    for (const agent of ['Googlebot/2.1', 'BINGBOT', 'Some Crawler 1.0', 'a spider', 'Slack link Preview']) {
      expect(isBotUserAgent(agent), agent).toBe(true);
    }
    for (const agent of ['Mozilla/5.0 Firefox/120', '', undefined]) {
      expect(isBotUserAgent(agent), String(agent)).toBe(false);
    }
  });

  it('createSmtpTransport refuses a credential without a host', async () => {
    const { createSmtpTransport } = await import('../src/utils/smtp-transport');
    const { ctx } = pinnedContext();
    await expect(createSmtpTransport(ctx, { host: '  ' })).rejects.toThrow('The SMTP credential has no host');
  });

  it('createSmtpTransport sends over the checked address and keeps the name for TLS', async () => {
    const { createSmtpTransport } = await import('../src/utils/smtp-transport');
    const smtp = await startSmtpServer();
    const { ctx, lookup, resolveAllowedHost } = pinnedContext();
    const resolver = vi.spyOn(dns, 'lookup');
    const transport = await createSmtpTransport(ctx, {
      host: 'mail.rebind.test',
      port: smtp.port,
      secure: false,
      user: 'ada',
      password: 'pw',
    });
    try {
      await transport.sendMail({ from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' });
      expect(resolveAllowedHost).toHaveBeenCalledWith('mail.rebind.test');
      expect(lookup).toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]!.auth).toContain('ada');
    } finally {
      transport.close();
      await smtp.close();
    }
  });

  it('createSmtpTransport maps the credential and the insecure option as Send Email did', async () => {
    const { createSmtpTransport } = await import('../src/utils/smtp-transport');
    const { ctx } = pinnedContext();
    const options = async (creds: DataObject, insecure?: boolean) => {
      const transport = await createSmtpTransport(ctx, creds, { allowUnauthorizedCerts: insecure });
      transport.close();
      return (transport as unknown as { options: Record<string, unknown> }).options;
    };
    expect(await options({ host: 'h' })).toMatchObject({
      host: 'h',
      port: 465,
      secure: true,
      ignoreTLS: false,
      tls: { rejectUnauthorized: true },
    });
    expect(await options({ host: 'h', secure: false, disableStartTls: true }, true)).toMatchObject({
      port: 587,
      secure: false,
      ignoreTLS: true,
      tls: { rejectUnauthorized: false },
    });
    expect(await options({ host: 'h', hostName: 'me', port: 25 })).toMatchObject({ name: 'me', port: 25 });
  });

  it('postgresPool passes keepAliveDelayMs through and keeps connectionTimeoutSeconds', async () => {
    const { postgresPool } = await import('../src/nodes/apps/sql/Postgres.node');
    const { ctx } = pinnedContext('127.0.0.1', { host: '127.0.0.1' });
    const poolOptions = async (options?: Parameters<typeof postgresPool>[1]) => {
      const pool = await postgresPool(ctx, options);
      await pool.end();
      return (pool as unknown as { options: Record<string, unknown> }).options;
    };
    expect(await poolOptions({ keepAliveDelayMs: 1234, connectionTimeoutSeconds: 7 })).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 1234,
      connectionTimeoutMillis: 7000,
    });
    const plain = await poolOptions();
    expect(plain.keepAlive).toBeUndefined();
    expect(plain.connectionTimeoutMillis).toBe(30_000);
  });
});

describe('helper exports', () => {
  it('form user auth exports its properties and its check', async () => {
    const { checkFormUserAuth, userAuthProperties } = await import('../src/nodes/core/form/user-auth');
    expect(Array.isArray(userAuthProperties)).toBe(true);
    expect(checkFormUserAuth).toBeTypeOf('function');
  });

  it('broker-connect exports its three helpers', async () => {
    const { connectGuarded, guardedLookup, tlsOptions } = await import('../src/utils/broker-connect');
    expect(connectGuarded).toBeTypeOf('function');
    expect(guardedLookup).toBeTypeOf('function');
    expect(tlsOptions).toBeTypeOf('function');
  });

  it('redis-connect exports openRedis', async () => {
    const { openRedis } = await import('../src/utils/redis-connect');
    expect(openRedis).toBeTypeOf('function');
  });
});

describe('test harness', () => {
  it('testServices accepts pythonRunner', () => {
    const pythonRunner = { run: async () => [] };
    expect(testServices({}, { pythonRunner }).pythonRunner).toBe(pythonRunner);
  });
});
