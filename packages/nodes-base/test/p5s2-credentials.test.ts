/**
 * Phase 5 S2 C0: the `mongoDb` and `supabaseApi` credentials (fields, secrets, headers, a generated request),
 * the new subpath exports, and the constants and locators of the Lakebase client contract.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAuthentication, resolveCredentialUrl } from '@workflow/core';
import type { NodeProperty } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { credentials } from '../src';
import { mongoDb } from '../src/credentials/mongodb.credentials';
import { supabaseApi } from '../src/credentials/supabase.credentials';
import {
  LAKEBASE_MAX_PAGES,
  LAKEBASE_PAGE_SIZE,
  lakebaseListSearch,
  lakebaseLocatorProperties,
} from '../src/utils/databricks-lakebase';
import { credentialTypes, FakeHttpClient, runNode } from './harness';

const HOST = 'https://abcdefghijklmnop.supabase.co';
const KEY = 'sb-secret-SEEDED-0123456789';

const field = (props: NodeProperty[], name: string) => props.find((p) => p.name === name);
const names = (props: NodeProperty[]) => props.map((p) => p.name);

describe('mongoDb credential', () => {
  it("has n8n's fields in order with their defaults", () => {
    expect(names(mongoDb.properties)).toEqual([
      'configurationType',
      'connectionString',
      'host',
      'database',
      'user',
      'password',
      'port',
      'tls',
      'ca',
      'cert',
      'key',
      'passphrase',
    ]);
    expect(field(mongoDb.properties, 'configurationType')).toMatchObject({
      type: 'options',
      default: 'values',
    });
    expect(
      (field(mongoDb.properties, 'configurationType')?.options ?? []).map(
        (o) => (o as { value: string }).value,
      ),
    ).toEqual(['connectionString', 'values']);
    expect(field(mongoDb.properties, 'port')).toMatchObject({ type: 'number', default: 27017 });
    expect(field(mongoDb.properties, 'tls')).toMatchObject({ type: 'boolean', default: false });
    expect(field(mongoDb.properties, 'host')?.default).toBe('localhost');
  });

  it('shows the connection string or the values, and the TLS material only with TLS on', () => {
    const show = (name: string) => field(mongoDb.properties, name)?.displayOptions?.show;
    expect(show('connectionString')).toEqual({ configurationType: ['connectionString'] });
    for (const name of ['host', 'user', 'password', 'port']) {
      expect(show(name), name).toEqual({ configurationType: ['values'] });
    }
    // the database is read in both modes (n8n: give it even with a connection string)
    expect(show('database')).toBeUndefined();
    expect(show('tls')).toBeUndefined();
    for (const name of ['ca', 'cert', 'key', 'passphrase']) expect(show(name), name).toEqual({ tls: [true] });
  });

  it('has no test and no authenticate: the nodes name their own test with testedBy', () => {
    expect(mongoDb.test).toBeUndefined();
    expect(mongoDb.authenticate).toBeUndefined();
    expect(mongoDb.icon).toBe('simple:mongodb');
    // no HTTP request carries it, so no "Allowed HTTP Request Domains" fields
    expect(names(credentialTypes.getResolved('mongoDb')?.properties ?? [])).not.toContain(
      'allowedHttpRequestDomains',
    );
  });
});

describe('supabaseApi credential', () => {
  it('has the host and the secret key', () => {
    expect(names(supabaseApi.properties)).toEqual(['host', 'serviceRole']);
    expect(field(supabaseApi.properties, 'host')).toMatchObject({ type: 'string', required: true });
    expect(supabaseApi.icon).toBe('simple:supabase');
    // it sends requests: the allowed-domain fields are added at the end
    const resolved = names(credentialTypes.getResolved('supabaseApi')?.properties ?? []);
    expect(resolved.slice(0, 2)).toEqual(['host', 'serviceRole']);
    expect(resolved).toContain('allowedHttpRequestDomains');
  });

  it('puts the key in apikey and in a bearer authorization header', () => {
    expect(supabaseApi.authenticate).toEqual({
      type: 'generic',
      properties: {
        headers: {
          apikey: '={{$credentials.serviceRole}}',
          authorization: '=Bearer {{$credentials.serviceRole}}',
        },
      },
    });
  });

  it('tests the connection at the PostgREST root of the host', () => {
    expect(supabaseApi.test?.request.method).toBe('GET');
    const url = resolveCredentialUrl(supabaseApi.test?.request.url as string, { host: HOST });
    expect(url).toBe(`${HOST}/rest/v1/`);
  });

  it('generates an authenticated request that keeps its own headers', async () => {
    const data = { host: HOST, serviceRole: KEY };
    const url = resolveCredentialUrl(supabaseApi.test?.request.url as string, data);
    const authed = await applyAuthentication(supabaseApi, data, {
      url,
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(authed.url).toBe(`${HOST}/rest/v1/`);
    expect(authed.headers).toEqual({
      accept: 'application/json',
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
    });
    const fake = new FakeHttpClient().on('GET', /\/rest\/v1\/$/, () => ({ ok: 1 }));
    await fake.request(authed);
    expect(fake.requests[0]).toMatchObject({
      method: 'GET',
      url: `${HOST}/rest/v1/`,
      headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
    });
  });

  it('authenticates an HTTP Request node that picks it as a predefined credential', async () => {
    const fake = new FakeHttpClient().on('GET', /\/rest\/v1\/documents/, () => ({ rows: [] }));
    const run = await runNode(
      'core.httpRequest',
      {
        url: `${HOST}/rest/v1/documents?select=id`,
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'supabaseApi',
      },
      [{ json: {} }],
      { services: { http: fake }, creds: { supabaseApi: { host: HOST, serviceRole: KEY } } },
    );
    expect(run.error).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url).toBe(`${HOST}/rest/v1/documents?select=id`);
    expect(fake.requests[0].headers).toMatchObject({ apikey: KEY, authorization: `Bearer ${KEY}` });
  });
});

describe('secret fields', () => {
  // descriptions.test.ts matches secret names by suffix, which misses ca, cert, key and serviceRole
  it.each([
    ['mongoDb', 'connectionString'],
    ['mongoDb', 'password'],
    ['mongoDb', 'ca'],
    ['mongoDb', 'cert'],
    ['mongoDb', 'key'],
    ['mongoDb', 'passphrase'],
    ['supabaseApi', 'serviceRole'],
  ])('%s.%s is a password field', (type, name) => {
    const props = credentialTypes.getResolved(type)?.properties ?? [];
    expect(field(props, name)?.typeOptions?.password).toBe(true);
  });

  it('marks no other mongoDb or supabaseApi field as a secret', () => {
    const secret = (props: NodeProperty[]) => names(props.filter((p) => p.typeOptions?.password));
    expect(secret(mongoDb.properties)).toEqual([
      'connectionString',
      'password',
      'ca',
      'cert',
      'key',
      'passphrase',
    ]);
    expect(secret(supabaseApi.properties)).toEqual(['serviceRole']);
  });

  it('lists both types in the package', () => {
    const listed = credentials.map((c) => c.name);
    expect(listed).toContain('mongoDb');
    expect(listed).toContain('supabaseApi');
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('subpath exports', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };

  it('exports the helpers nodes-ai reuses, each to a file that exists', () => {
    expect(pkg.exports).toEqual({
      '.': './src/index.ts',
      './utils/filter': './src/utils/filter.ts',
      './utils/ssh-tunnel': './src/utils/ssh-tunnel.ts',
      './utils/archive': './src/utils/archive.ts',
      './extract/pdf': './src/nodes/core/extract/pdf.ts',
      './utils/databricks-lakebase': './src/utils/databricks-lakebase.ts',
      './utils/send-and-wait': './src/utils/send-and-wait/index.ts',
      './utils/user-auth': './src/utils/user-auth.ts',
      './utils/document-text': './src/utils/document-text.ts',
      './utils/workspace-signin': './src/utils/workspace-signin.ts',
      './utils/connect-panel': './src/utils/connect-panel.ts',
    });
    for (const file of Object.values(pkg.exports)) expect(existsSync(resolve(root, file)), file).toBe(true);
  });
});

describe('Lakebase client contract', () => {
  it('pages 1000 rows at a time, 100 pages at most', () => {
    expect(LAKEBASE_PAGE_SIZE).toBe(1000);
    expect(LAKEBASE_MAX_PAGES).toBe(100);
  });

  it('has the four locators, each listing through its own list search', () => {
    expect(names(lakebaseLocatorProperties)).toEqual(['project', 'branch', 'database', 'schema']);
    const methods = lakebaseLocatorProperties.map(
      (p) => p.modes?.find((m) => m.type === 'list')?.typeOptions?.searchListMethod,
    );
    expect(methods).toEqual(['projects', 'branches', 'databases', 'schemas']);
    expect(Object.keys(lakebaseListSearch).sort()).toEqual([...methods].sort());
    for (const p of lakebaseLocatorProperties) {
      expect(p.type).toBe('resourceLocator');
      expect(p.modes?.map((m) => m.name)).toEqual(['list', 'id']);
    }
  });
});
