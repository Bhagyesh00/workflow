import { describe, expect, it } from 'vitest';
import { nodesBasePackage } from '../../nodes-base/src';
import { postgres, redis } from '../../nodes-base/src/credentials/apps.credentials';
import { httpBearerAuth } from '../../nodes-base/src/credentials/http.credentials';
import { withGenericAuth } from '../src/nodes/tools/tools.nodes';
import { postgresCredentials, postgresTlsOptions, redisCredentials } from '../src/shared/connections';

const names = (c: { properties: { name: string }[] }) => c.properties.map((p) => p.name);

describe('credential field names match what nodes-ai reads', () => {
  it('registers a redis credential type in the nodes-base package', () => {
    expect(nodesBasePackage.credentials?.map((c) => c.name)).toContain('redis');
    expect(redis.name).toBe('redis');
  });

  it('redis fields are read by redisCredentials', () => {
    expect(names(redis)).toEqual(['host', 'port', 'user', 'password', 'database', 'ssl']);
    const creds = redisCredentials({
      host: 'cache.example.com',
      port: 6380,
      user: 'bob',
      password: 'pw',
      database: 3,
      ssl: true,
    });
    expect(creds).toEqual({
      host: 'cache.example.com',
      port: 6380,
      username: 'bob',
      password: 'pw',
      db: 3,
      tls: true,
    });
  });

  it('redis defaults produce a usable connection', () => {
    const data = Object.fromEntries(redis.properties.map((p) => [p.name, p.default]));
    expect(redisCredentials(data)).toMatchObject({ host: 'localhost', port: 6379, db: 0, tls: false });
  });

  it('postgres fields are exactly the ones postgresCredentials reads', () => {
    const data = Object.fromEntries(postgres.properties.map((p) => [p.name, p.default]));
    expect(
      postgresCredentials({ ...data, user: 'u', database: 'd', ssl: 'require', caCertificate: 'PEM' }),
    ).toMatchObject({
      user: 'u',
      database: 'd',
      ssl: 'require',
      caCertificate: 'PEM',
    });
    expect(postgresCredentials({ username: 'x', db: 'y' })).toMatchObject({
      user: 'postgres',
      database: 'postgres',
    });
    // every credential field except maxConnections (pool size of the Postgres node) is read
    const read = Object.keys(postgresCredentials(data)).sort();
    expect(names(postgres).filter((n) => n !== 'maxConnections' && n !== 'ssl')).toEqual(
      expect.arrayContaining(['host', 'port', 'database', 'user', 'password', 'caCertificate']),
    );
    expect(read).toEqual(['caCertificate', 'database', 'host', 'password', 'port', 'ssl', 'user'].sort());
  });

  it('postgres TLS options follow the SSL setting like the Postgres node does', () => {
    const base = postgresCredentials({});
    expect(postgresTlsOptions({ ...base, ssl: 'disable' })).toBe(false);
    expect(postgresTlsOptions({ ...base, ssl: 'allow' })).toEqual({ rejectUnauthorized: false });
    expect(postgresTlsOptions({ ...base, ssl: 'require' })).toEqual({ rejectUnauthorized: true });
    expect(postgresTlsOptions({ ...base, ssl: 'require', caCertificate: 'PEM' })).toEqual({
      rejectUnauthorized: true,
      ca: 'PEM',
    });
  });

  it('httpBearerAuth token is the field the tools read', async () => {
    expect(names(httpBearerAuth)).toEqual(['token']);
    const ctx = { getCredentials: async () => ({ token: 'abc' }) } as never;
    const out = await withGenericAuth(ctx, 'httpBearerAuth', { url: 'http://x' } as never, 0);
    expect(out.headers?.authorization).toBe('Bearer abc');
    const legacy = { getCredentials: async () => ({ value: 'abc' }) } as never;
    const none = await withGenericAuth(legacy, 'httpBearerAuth', { url: 'http://x' } as never, 0);
    expect(none.headers?.authorization).toBe('Bearer ');
  });
});
