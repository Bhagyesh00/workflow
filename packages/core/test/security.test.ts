import { describe, expect, it } from 'vitest';
import {
  CodeExecutionError,
  CredentialCipher,
  HttpClient,
  IsolatedVmCodeRunner,
  isAddressAllowed,
  SsrfBlockedError,
} from '../src';

const runner = new IsolatedVmCodeRunner({ timeoutMs: 1500, memoryLimitMb: 32 });
const base = {
  items: [{ json: { a: 1 } }, { json: { a: 2 } }],
  nodeOutputs: { Trigger: [{ json: { t: true } }] },
  variables: { region: 'eu' },
  workflow: { id: 'w', name: 'W', active: false },
  execution: { id: 'e', mode: 'test' },
  nodeName: 'Code',
  timezone: 'UTC',
};

describe('Code sandbox (isolated-vm)', () => {
  it('runs once for all items', async () => {
    const out = await runner.run({
      ...base,
      mode: 'runOnceForAllItems',
      code: 'return items.map(i => ({ json: { doubled: i.json.a * 2, region: $vars.region, t: $("Trigger").first().json.t } }))',
    });
    expect(out.map((i) => i.json)).toEqual([
      { doubled: 2, region: 'eu', t: true },
      { doubled: 4, region: 'eu', t: true },
    ]);
  });

  it('runs once for each item with $json and luxon', async () => {
    const out = await runner.run({
      ...base,
      mode: 'runOnceForEachItem',
      code: 'return { a: $json.a, idx: $itemIndex, year: DateTime.fromISO("2021-05-01").year }',
    });
    expect(out.map((i) => i.json)).toEqual([
      { a: 1, idx: 0, year: 2021 },
      { a: 2, idx: 1, year: 2021 },
    ]);
    expect(out[1].pairedItem).toEqual({ item: 1 });
  });

  it('captures console output', async () => {
    const logs: unknown[] = [];
    await runner.run({
      ...base,
      mode: 'runOnceForAllItems',
      code: 'console.log("hi", {x: 1}); return []',
      onConsole: (_l, a) => logs.push(a),
    });
    expect(logs).toEqual([['hi', '{"x":1}']]);
  });

  it.each([
    ['require', 'return [{ json: { x: typeof require } }]', /undefined/],
    ['process', 'return [{ json: { x: typeof process } }]', /undefined/],
    ['fetch', 'return [{ json: { x: typeof fetch } }]', /undefined/],
  ])('has no host access: %s', async (_name, code) => {
    const out = await runner.run({ ...base, mode: 'runOnceForAllItems', code });
    expect(out[0].json.x).toBe('undefined');
  });

  it('blocks $env', async () => {
    await expect(
      runner.run({ ...base, mode: 'runOnceForAllItems', code: 'return [{ json: { x: $env.HOME } }]' }),
    ).rejects.toThrow(/disabled/);
  });

  it('times out infinite loops', async () => {
    await expect(
      runner.run({ ...base, mode: 'runOnceForAllItems', code: 'while (true) {}' }),
    ).rejects.toThrow(CodeExecutionError);
  });

  it('enforces the memory limit', async () => {
    await expect(
      runner.run({
        ...base,
        mode: 'runOnceForAllItems',
        code: 'const a = []; while (true) a.push(new Array(1e6).fill(1)); return []',
      }),
    ).rejects.toThrow(CodeExecutionError);
  });

  it('rejects invalid return values', async () => {
    await expect(runner.run({ ...base, mode: 'runOnceForAllItems', code: 'return [1, 2]' })).rejects.toThrow(
      /array of objects/,
    );
  });
});

describe('SSRF protection', () => {
  const policy = { enabled: true, allow: [], deny: [] };
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    '0.0.0.0',
    '100.64.0.1',
    'fd00::1',
  ])('blocks %s', (ip) => {
    expect(isAddressAllowed('host', ip, policy)).toBe(false);
  });
  it('allows public addresses and explicit allow-list entries', () => {
    expect(isAddressAllowed('example.com', '93.184.216.34', policy)).toBe(true);
    expect(isAddressAllowed('internal', '10.0.0.5', { ...policy, allow: ['10.0.0.0/24'] })).toBe(true);
  });
  it('blocks requests to loopback hostnames at connect time', async () => {
    const client = new HttpClient();
    await expect(client.request({ url: 'http://localhost:1/' })).rejects.toThrow();
    await expect(client.request({ url: 'http://127.0.0.1:1/' })).rejects.toThrow(SsrfBlockedError);
    await expect(client.request({ url: 'http://169.254.169.254/latest/meta-data' })).rejects.toThrow(
      SsrfBlockedError,
    );
    await expect(client.request({ url: 'file:///etc/passwd' })).rejects.toThrow(/Unsupported protocol/);
    await client.close();
  });
});

describe('credential cipher', () => {
  const key = (id: string) => ({ id, key: Buffer.alloc(32, id) });
  it('round-trips and binds ciphertext to tenant + credential', () => {
    const cipher = new CredentialCipher([key('k1')]);
    const ct = cipher.encrypt({ token: 's3cret' }, { tenantId: 't1', credentialId: 'c1' });
    expect(ct).not.toContain('s3cret');
    expect(cipher.decrypt(ct, { tenantId: 't1', credentialId: 'c1' })).toEqual({ token: 's3cret' });
    expect(() => cipher.decrypt(ct, { tenantId: 't2', credentialId: 'c1' })).toThrow();
    expect(() => cipher.decrypt(ct, { tenantId: 't1', credentialId: 'c2' })).toThrow();
  });
  it('supports key rotation', () => {
    const old = new CredentialCipher([key('k1')]);
    const ct = old.encrypt({ a: 1 }, { tenantId: 't', credentialId: 'c' });
    const rotated = new CredentialCipher([key('k2'), key('k1')]);
    expect(rotated.decrypt(ct, { tenantId: 't', credentialId: 'c' })).toEqual({ a: 1 });
    expect(rotated.needsRotation(ct)).toBe(true);
  });
});
