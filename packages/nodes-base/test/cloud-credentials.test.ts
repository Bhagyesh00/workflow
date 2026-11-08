/**
 * P5-19 the AWS and Google credentials from their `authenticate`, on the harness `FakeHttpClient`: signed
 * requests, Assume Role, cached tokens, allowed domains and what never reaches an error text.
 */
import { createPublicKey, createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { applyAuthentication, createCredentialHelpers, signAwsRequest } from '@workflow/core';
import {
  CredentialDomainError,
  type CredentialType,
  type DataObject,
  evaluateSimple,
  getCredentialAllowedDomains,
  type HttpRequestOptions,
  type NodeType,
} from '@workflow/workflow';
import { beforeAll, describe, expect, it } from 'vitest';
import { aws, awsAssumeRole } from '../src/credentials/aws.credentials';
import { googleApi } from '../src/credentials/google.credentials';
import { FakeHttpClient, nodeTypes, type RecordedRequest, runNode } from './harness';

const SECRET = 'SEEDED-SECRET-wJalrXUtnFEMI';
const BEDROCK = 'https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const REFUSED_HOST = 'AWS credentials only sign https requests to amazonaws.com hosts';

/** hosts under amazonaws.com that a customer runs: they must never get a signature */
const CUSTOMER_HOSTS = [
  'ec2-1-2-3-4.compute-1.amazonaws.com',
  'ec2-1-2-3-4.us-west-2.compute.amazonaws.com',
  'x-123.us-east-1.elb.amazonaws.com',
  'abc.execute-api.us-east-1.amazonaws.com',
  'abc.appsync-api.us-east-1.amazonaws.com',
  'b.s3-website-us-east-1.amazonaws.com',
  'b.s3-website.us-east-1.amazonaws.com',
  'b.s3.amazonaws.com',
  'b.s3.us-east-1.amazonaws.com',
  'x.y.us-east-1.rds.amazonaws.com',
  'gateway.bedrock-agentcore.us-east-1.amazonaws.com',
  'abc.execute-api.cn-north-1.amazonaws.com.cn',
];

/** AWS service hosts: host, the service and the region the signature names */
const SERVICE_HOSTS: Array<[string, string, string]> = [
  ['bedrock-runtime.eu-west-1.amazonaws.com', 'bedrock', 'eu-west-1'],
  ['bedrock.eu-west-1.amazonaws.com', 'bedrock', 'eu-west-1'],
  ['bedrock-runtime-fips.us-east-1.amazonaws.com', 'bedrock', 'us-east-1'],
  ['sts.amazonaws.com', 'sts', 'us-east-1'],
  ['sts.eu-west-1.amazonaws.com', 'sts', 'eu-west-1'],
  ['iam.amazonaws.com', 'iam', 'us-east-1'],
  ['secretsmanager.us-west-2.amazonaws.com', 'secretsmanager', 'us-west-2'],
  ['s3.eu-central-1.amazonaws.com', 's3', 'eu-central-1'],
  ['s3.dualstack.us-east-1.amazonaws.com', 's3', 'us-east-1'],
  ['email.us-east-1.amazonaws.com', 'ses', 'us-east-1'],
  ['vpce-0abc123-xyz.bedrock-runtime.us-east-1.vpce.amazonaws.com', 'bedrock', 'us-east-1'],
  ['vpce-0abc123-xyz-us-east-1a.bedrock-runtime.us-east-1.vpce.amazonaws.com', 'bedrock', 'us-east-1'],
  ['bedrock-runtime.cn-north-1.amazonaws.com.cn', 'bedrock', 'cn-north-1'],
  ['bedrock-runtime.cn-northwest-1.amazonaws.com.cn', 'bedrock', 'cn-northwest-1'],
  ['sts.cn-north-1.amazonaws.com.cn', 'sts', 'cn-north-1'],
  ['vpce-0abc123.bedrock-runtime.cn-north-1.vpce.amazonaws.com.cn', 'bedrock', 'cn-north-1'],
];

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const awsKeys = (extra: DataObject = {}): DataObject => ({
  region: 'us-east-1',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: `${SECRET}-${randomUUID()}`,
  ...extra,
});

const roleKeys = (extra: DataObject = {}): DataObject => ({
  region: 'eu-west-1',
  stsAccessKeyId: 'AKIDSTS',
  stsSecretAccessKey: `${SECRET}-${randomUUID()}`,
  roleArn: 'arn:aws:iam::123456789012:role/r',
  externalId: 'ext-1',
  roleSessionName: 'workflow-session',
  ...extra,
});

let keyCounter = 0;
const googleKeys = (extra: DataObject = {}): DataObject => {
  keyCounter += 1;
  return {
    email: 'sa@p.iam.gserviceaccount.com',
    // a different text per credential, the same key: the cache is shared and keyed by the secret
    privateKey: `${privateKey}${'\n'.repeat(keyCounter)}`,
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
    ...extra,
  };
};

/** an `authenticate` and the send after it, as httpRequestWithAuthentication does them */
async function send(
  fake: FakeHttpClient,
  type: CredentialType,
  credentials: DataObject,
  request: HttpRequestOptions,
) {
  const domains = getCredentialAllowedDomains(credentials, { userUrl: false });
  const helpers = createCredentialHelpers(fake, domains);
  const authed = await applyAuthentication(type, credentials, request, helpers);
  await fake.request(authed);
  return authed;
}

const fakeWith = () => new FakeHttpClient().on('*', /bedrock-runtime|aiplatform|example/, () => ({ ok: 1 }));

/** recomputes the signature from what was recorded, as the service does */
function expectSigned(
  recorded: RecordedRequest,
  keys: { accessKeyId: string; secretAccessKey: string },
  service: string,
  region: string,
) {
  const headers = Object.fromEntries(Object.entries(recorded.headers).map(([k, v]) => [k, String(v)]));
  const authorization = headers.authorization ?? '';
  const signedNames = /SignedHeaders=([^,]+),/.exec(authorization)?.[1]?.split(';') ?? [];
  const stamp = headers['x-amz-date'] ?? '';
  const date = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
  const expected = signAwsRequest({
    method: recorded.method,
    url: recorded.url,
    headers: Object.fromEntries(
      signedNames
        .filter((n) => n !== 'host' && n !== 'x-amz-date' && n !== 'x-amz-security-token')
        .map((n) => [n, headers[n] ?? '']),
    ),
    body: recorded.body as string | undefined,
    region,
    service,
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    sessionToken: headers['x-amz-security-token'],
    date,
  });
  expect(authorization).toBe(expected.headers.authorization);
  expect(authorization).toContain(`/${region}/${service}/aws4_request`);
}

/** the scope text each `cachedToken` call was given during one `authenticate` */
async function cacheScopes(
  fake: FakeHttpClient,
  type: CredentialType,
  credentials: DataObject,
  request: HttpRequestOptions,
): Promise<string[]> {
  const helpers = createCredentialHelpers(fake, getCredentialAllowedDomains(credentials, { userUrl: false }));
  const scopes: string[] = [];
  await applyAuthentication(type, credentials, request, {
    ...helpers,
    cachedToken: (secret, scope, fetch) => {
      scopes.push(scope);
      return helpers.cachedToken(secret, scope, fetch);
    },
  });
  return scopes;
}

const CACHE_SCOPE_FIELDS = ['tokenUrl', 'subject', 'scopes', 'resource', 'role'];

async function messageOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

const keysOf = (creds: DataObject) => ({
  accessKeyId: String(creds.accessKeyId),
  secretAccessKey: String(creds.secretAccessKey),
});

describe('aws', () => {
  it('signs a request, with the service and region of the host', async () => {
    const fake = fakeWith();
    const creds = awsKeys();
    await send(fake, aws, creds, { url: BEDROCK, method: 'POST', body: { a: 1 } });
    const recorded = fake.requests[0] as RecordedRequest;
    expect(recorded.body).toBe('{"a":1}');
    expect(recorded.bodyType).toBe('raw');
    expect(recorded.headers['content-type']).toBe('application/json');
    expect(recorded.options.followRedirects).toBe(false);
    expectSigned(recorded, keysOf(creds), 'bedrock', 'us-east-1');
  });

  it('takes the region from the host, not the credential', async () => {
    const fake = fakeWith();
    const creds = awsKeys({ region: 'eu-west-1' });
    await send(fake, aws, creds, { url: BEDROCK, method: 'POST', body: '{}' });
    expectSigned(fake.requests[0] as RecordedRequest, keysOf(creds), 'bedrock', 'us-east-1');
  });

  it('signs a private endpoint host, with its service and region', async () => {
    const url = 'https://vpce-1a2b.bedrock-runtime.us-west-2.vpce.amazonaws.com/model/m/converse';
    const fake = new FakeHttpClient().on('*', /vpce/, () => ({ ok: 1 }));
    const creds = awsKeys();
    await send(fake, aws, creds, { url, method: 'POST', body: '{}' });
    expectSigned(fake.requests[0] as RecordedRequest, keysOf(creds), 'bedrock', 'us-west-2');
  });

  it('signs the China and the global hosts', async () => {
    const fake = new FakeHttpClient().on('*', /amazonaws/, () => ({ ok: 1 }));
    const creds = awsKeys();
    await send(fake, aws, creds, { url: 'https://sqs.cn-north-1.amazonaws.com.cn/', method: 'GET' });
    await send(fake, aws, creds, { url: 'https://iam.amazonaws.com/', method: 'GET' });
    expectSigned(fake.requests[0] as RecordedRequest, keysOf(creds), 'sqs', 'cn-north-1');
    expectSigned(fake.requests[1] as RecordedRequest, keysOf(creds), 'iam', 'us-east-1');
  });

  it('merges qs into the URL before signing, so the query is signed and nothing is added later', async () => {
    const fake = fakeWith();
    const creds = awsKeys();
    const authed = await send(fake, aws, creds, {
      url: `${BEDROCK}?z=1`,
      method: 'GET',
      qs: { a: 'x y', list: [1, 2], skip: undefined, o: { k: 1 } },
    });
    expect(authed.qs).toBeUndefined();
    expect(authed.url).toBe(`${BEDROCK}?z=1&a=x%20y&list=1&list=2&o=%7B%22k%22%3A1%7D`);
    expectSigned(fake.requests[0] as RecordedRequest, keysOf(creds), 'bedrock', 'us-east-1');
  });

  it('turns a form body into the string that is signed', async () => {
    const fake = fakeWith();
    const creds = awsKeys();
    await send(fake, aws, creds, {
      url: BEDROCK,
      method: 'POST',
      bodyType: 'form-urlencoded',
      body: { a: 'x y', b: 1 },
    });
    const recorded = fake.requests[0] as RecordedRequest;
    expect(recorded.body).toBe('a=x+y&b=1');
    expect(recorded.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expectSigned(recorded, keysOf(creds), 'bedrock', 'us-east-1');
  });

  it('refuses a multipart body: its boundary is not known when signing', async () => {
    const message = await messageOf(
      send(fakeWith(), aws, awsKeys(), {
        url: BEDROCK,
        method: 'POST',
        bodyType: 'multipart',
        body: { a: 1 },
      }),
    );
    expect(message).toContain('multipart');
  });

  it('ignores a body on a GET, as the client does', async () => {
    const fake = fakeWith();
    const creds = awsKeys();
    await send(fake, aws, creds, { url: BEDROCK, method: 'GET', body: { a: 1 } });
    const recorded = fake.requests[0] as RecordedRequest;
    expect(recorded.body).toBeUndefined();
    expectSigned(recorded, keysOf(creds), 'bedrock', 'us-east-1');
  });

  it('sends the session token of temporary credentials only', async () => {
    const fake = fakeWith();
    const request = { url: BEDROCK, method: 'POST', body: '{}' } as const;
    await send(fake, aws, awsKeys({ temporaryCredentials: true, sessionToken: 'tok-1' }), request);
    await send(fake, aws, awsKeys({ temporaryCredentials: false, sessionToken: 'tok-2' }), request);
    expect(fake.requests[0]?.headers['x-amz-security-token']).toBe('tok-1');
    expect(fake.requests[0]?.headers.authorization).toContain('x-amz-security-token');
    expect(fake.requests[1]?.headers['x-amz-security-token']).toBeUndefined();
  });

  it('replaces a caller header it signs itself', async () => {
    const fake = fakeWith();
    const creds = awsKeys();
    await send(fake, aws, creds, {
      url: BEDROCK,
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer other', Host: 'evil.test', 'X-Amz-Date': 'x', 'X-Custom': ' a  b ' },
    });
    const recorded = fake.requests[0] as RecordedRequest;
    expect(recorded.headers.host).toBeUndefined();
    expect(String(recorded.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(String(recorded.headers.authorization)).toContain('host;x-amz-date;x-custom');
    expectSigned(recorded, keysOf(creds), 'bedrock', 'us-east-1');
  });

  it.each([
    ['https://evilamazonaws.com/x'],
    ['https://amazonaws.com.evil.test/x'],
    ['https://bedrock-runtime.us-east-1.amazonaws.com.evil.test/x'],
    ['https://amazonaws.com@evil.test/x'],
    ['http://bedrock-runtime.us-east-1.amazonaws.com/x'],
    ['https://gateway.example.test/x'],
    ['https://user:pw@bedrock-runtime.us-east-1.amazonaws.com/x'],
    ['https://user@bedrock-runtime.us-east-1.amazonaws.com/x'],
    ...CUSTOMER_HOSTS.map((host) => [`https://${host}/x`]),
  ])('refuses %s before any signing', async (url) => {
    const fake = fakeWith();
    let signed = 0;
    const helpers = {
      ...createCredentialHelpers(fake, undefined),
      signAwsV4: () => {
        signed += 1;
        return { headers: {} };
      },
    };
    const run = applyAuthentication(aws, awsKeys(), { url, method: 'GET' }, helpers);
    expect(await messageOf(run)).toBe(REFUSED_HOST);
    expect(signed).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a bare domain: no service to sign for', async () => {
    const message = await messageOf(
      send(fakeWith(), aws, awsKeys(), { url: 'https://amazonaws.com/', method: 'GET' }),
    );
    expect(message).toBe(REFUSED_HOST);
  });

  it.each(SERVICE_HOSTS)('signs the service host %s for %s in %s', async (host, service, region) => {
    const fake = new FakeHttpClient().on('*', /amazonaws/, () => ({ ok: 1 }));
    const creds = awsKeys();
    await send(fake, aws, creds, { url: `https://${host}/`, method: 'GET' });
    expectSigned(fake.requests[0] as RecordedRequest, keysOf(creds), service, region);
  });

  it.each([['eu-west-1.evil.test/#'], ['not a region'], ['']])('refuses the region %j', async (region) => {
    const message = await messageOf(
      send(fakeWith(), aws, awsKeys({ region }), { url: BEDROCK, method: 'GET' }),
    );
    expect(message).toBe('The AWS region is not valid');
  });

  it('needs keys and helpers, and names neither key in a refusal', async () => {
    const creds = awsKeys();
    const missing = await messageOf(
      send(fakeWith(), aws, { ...creds, accessKeyId: '' }, { url: BEDROCK, method: 'GET' }),
    );
    expect(missing).toBe('The AWS credential needs an access key ID and a secret access key');
    const noHelpers = await messageOf(applyAuthentication(aws, creds, { url: BEDROCK, method: 'GET' }));
    expect(noHelpers).toBe('This credential can only sign through the workflow engine');
  });

  it('holds the STS connection test of n8n, on the credential region', () => {
    const url = String(aws.test?.request.url);
    expect(evaluateSimple(url, { $credentials: { region: 'eu-west-1' } })).toBe(
      'https://sts.eu-west-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
    );
    expect(evaluateSimple(url, { $credentials: { region: 'cn-north-1' } })).toBe(
      'https://sts.cn-north-1.amazonaws.com.cn/?Action=GetCallerIdentity&Version=2011-06-15',
    );
    expect(awsAssumeRole.test?.request.url).toBe(url);
  });
});

const stsAnswer = (
  key: string,
  expiration = new Date(Date.now() + 3_600_000).toISOString(),
) => `<?xml version="1.0"?>
<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <AssumedRoleUser><Arn>arn:aws:sts::1:assumed-role/r/s</Arn></AssumedRoleUser>
    <Credentials>
      <AccessKeyId>${key}</AccessKeyId>
      <SecretAccessKey>tmp/secret+1&amp;2</SecretAccessKey>
      <SessionToken>tmp-session-token</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
  </AssumeRoleResult>
</AssumeRoleResponse>`;

describe('awsAssumeRole', () => {
  const STS = 'https://sts.eu-west-1.amazonaws.com/';
  const stsFake = (answer: () => unknown = () => stsAnswer('ASIATEMP')) =>
    new FakeHttpClient().on('POST', STS, answer).on('*', /bedrock-runtime/, () => ({ ok: 1 }));
  const stsCalls = (fake: FakeHttpClient) => fake.requests.filter((r) => r.url === STS);

  it('assumes the role with its own keys, then signs with the temporary ones', async () => {
    const fake = stsFake();
    const creds = roleKeys();
    await send(fake, awsAssumeRole, creds, { url: BEDROCK, method: 'POST', body: '{}' });
    expect(fake.requests).toHaveLength(2);
    const [sts, call] = fake.requests as [RecordedRequest, RecordedRequest];
    expect(Object.fromEntries(new URLSearchParams(String(sts.body)))).toEqual({
      Action: 'AssumeRole',
      Version: '2011-06-15',
      RoleArn: 'arn:aws:iam::123456789012:role/r',
      RoleSessionName: 'workflow-session',
      ExternalId: 'ext-1',
    });
    expectSigned(
      sts,
      { accessKeyId: 'AKIDSTS', secretAccessKey: String(creds.stsSecretAccessKey) },
      'sts',
      'eu-west-1',
    );
    expect(call.headers['x-amz-security-token']).toBe('tmp-session-token');
    expectSigned(
      call,
      { accessKeyId: 'ASIATEMP', secretAccessKey: 'tmp/secret+1&2' },
      'bedrock',
      'us-east-1',
    );
  });

  it('sends the STS session token on the AssumeRole call', async () => {
    const fake = stsFake();
    await send(fake, awsAssumeRole, roleKeys({ stsSessionToken: 'sts-tok' }), {
      url: BEDROCK,
      method: 'GET',
    });
    expect(fake.requests[0]?.headers['x-amz-security-token']).toBe('sts-tok');
    expect(fake.requests[1]?.headers['x-amz-security-token']).toBe('tmp-session-token');
  });

  it('uses the China STS host for a China region', async () => {
    const url = 'https://sts.cn-north-1.amazonaws.com.cn/';
    const fake = new FakeHttpClient()
      .on('POST', url, () => stsAnswer('ASIATEMP'))
      .on('*', /bedrock-runtime/, () => ({ ok: 1 }));
    await send(fake, awsAssumeRole, roleKeys({ region: 'cn-north-1' }), { url: BEDROCK, method: 'GET' });
    expect(fake.requests[0]?.url).toBe(url);
  });

  it('keeps the temporary keys per secret and role until they near expiry', async () => {
    const fake = stsFake();
    const creds = roleKeys();
    const request = { url: BEDROCK, method: 'GET' } as const;
    await send(fake, awsAssumeRole, creds, request);
    await send(fake, awsAssumeRole, creds, request);
    expect(stsCalls(fake)).toHaveLength(1);
    await send(fake, awsAssumeRole, { ...creds, roleArn: 'arn:aws:iam::123456789012:role/other' }, request);
    expect(stsCalls(fake)).toHaveLength(2);
    await send(fake, awsAssumeRole, { ...creds, externalId: 'ext-2' }, request);
    expect(stsCalls(fake)).toHaveLength(3);
    await send(fake, awsAssumeRole, roleKeys(), request);
    expect(stsCalls(fake)).toHaveLength(4);
  });

  it('asks again when the temporary keys are about to expire', async () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const fake = stsFake(() => stsAnswer('ASIATEMP', soon));
    const creds = roleKeys();
    await send(fake, awsAssumeRole, creds, { url: BEDROCK, method: 'GET' });
    await send(fake, awsAssumeRole, creds, { url: BEDROCK, method: 'GET' });
    expect(stsCalls(fake)).toHaveLength(2);
  });

  it.each(CUSTOMER_HOSTS)('refuses the customer host %s before any STS call', async (host) => {
    const fake = stsFake();
    const request: HttpRequestOptions = { url: `https://${host}/`, method: 'GET' };
    expect(await messageOf(send(fake, awsAssumeRole, roleKeys(), request))).toBe(REFUSED_HOST);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses the target host before any STS call', async () => {
    const fake = stsFake();
    const message = await messageOf(
      send(fake, awsAssumeRole, roleKeys(), { url: 'https://evilamazonaws.com/x', method: 'GET' }),
    );
    expect(message).toBe(REFUSED_HOST);
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a missing external ID, role or key, and a bad region, before any call', async () => {
    const fake = stsFake();
    const request = { url: BEDROCK, method: 'GET' } as const;
    for (const extra of [
      { externalId: '' },
      { roleArn: '' },
      { stsAccessKeyId: '' },
      { stsSecretAccessKey: '' },
    ]) {
      expect(await messageOf(send(fake, awsAssumeRole, roleKeys(extra), request))).toBe(
        'The AWS Assume Role credential needs STS keys, a Role ARN and an External ID',
      );
    }
    expect(await messageOf(send(fake, awsAssumeRole, roleKeys({ region: 'x.evil.test/#' }), request))).toBe(
      'The AWS region is not valid',
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('uses the default session name when none is set', async () => {
    const fake = stsFake();
    await send(fake, awsAssumeRole, roleKeys({ roleSessionName: '' }), { url: BEDROCK, method: 'GET' });
    expect(new URLSearchParams(String(fake.requests[0]?.body)).get('RoleSessionName')).toBe(
      'workflow-session',
    );
  });

  it('refuses the STS host outside the allowed domains before any call', async () => {
    const fake = stsFake();
    const creds = roleKeys({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'bedrock-runtime.us-east-1.amazonaws.com',
    });
    await expect(send(fake, awsAssumeRole, creds, { url: BEDROCK, method: 'GET' })).rejects.toBeInstanceOf(
      CredentialDomainError,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('sends the STS call with the allowed domains on it, so every redirect hop is checked too', async () => {
    const fake = stsFake();
    const allowed = ['sts.eu-west-1.amazonaws.com', 'bedrock-runtime.us-east-1.amazonaws.com'];
    const creds = roleKeys({ allowedHttpRequestDomains: 'domains', allowedDomains: allowed.join(',') });
    await send(fake, awsAssumeRole, creds, { url: BEDROCK, method: 'GET' });
    expect(stsCalls(fake)[0]?.options.allowedDomains).toEqual(allowed);
  });

  it('passes as cache scope the JSON of the five named fields, and no secret', async () => {
    const creds = roleKeys();
    const [scope] = await cacheScopes(stsFake(), awsAssumeRole, creds, { url: BEDROCK, method: 'GET' });
    const parsed = JSON.parse(scope ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(CACHE_SCOPE_FIELDS);
    expect(parsed).toMatchObject({
      tokenUrl: STS,
      scopes: [],
      resource: creds.externalId,
      role: creds.roleArn,
    });
    expect(scope).not.toContain(String(creds.stsSecretAccessKey));
  });

  it('names no key when STS refuses, and follows no redirect', async () => {
    const fake = stsFake(() => ({ __status: 403, body: '<Error><Code>AccessDenied</Code></Error>' }));
    const creds = roleKeys();
    const message = await messageOf(send(fake, awsAssumeRole, creds, { url: BEDROCK, method: 'GET' }));
    expect(message).toContain('403');
    expect(message).not.toContain(String(creds.stsSecretAccessKey));
    expect(fake.requests[0]?.options.followRedirects).toBe(false);
    expect(fake.requests[0]?.options.timeout).toBe(30_000);
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses an answer with no credentials, and quotes none of it', async () => {
    for (const answer of [
      'SEEDED-ANSWER',
      { SEEDED: 'ANSWER' },
      '<Credentials><AccessKeyId>x</AccessKeyId></Credentials>',
    ]) {
      const fake = stsFake(() => answer);
      const message = await messageOf(send(fake, awsAssumeRole, roleKeys(), { url: BEDROCK, method: 'GET' }));
      expect(message).toBe('AWS STS answered without temporary credentials');
    }
  });
});

describe('googleApi', () => {
  const API = 'https://aiplatform.googleapis.com/v1/x';
  const tokenFake = () => {
    let n = 0;
    return new FakeHttpClient()
      .on('POST', GOOGLE_TOKEN, () => {
        n += 1;
        return { access_token: `tok-${n}`, expires_in: 3600 };
      })
      .on('*', /aiplatform/, () => ({ ok: 1 }));
  };
  const tokenCalls = (fake: FakeHttpClient) => fake.requests.filter((r) => r.url === GOOGLE_TOKEN);
  const claimsOf = (r: RecordedRequest | undefined) =>
    JSON.parse(
      Buffer.from(
        String((r?.body as { assertion: string } | undefined)?.assertion).split('.')[1] ?? '',
        'base64url',
      ).toString('utf8'),
    ) as Record<string, unknown>;

  it('puts a bearer token from the service account on the request', async () => {
    const fake = tokenFake();
    await send(fake, googleApi, googleKeys(), {
      url: API,
      headers: { Authorization: 'old', 'x-other': '1' },
    });
    const [token, call] = fake.requests as [RecordedRequest, RecordedRequest];
    expect(token.url).toBe(GOOGLE_TOKEN);
    const assertion = String((token.body as { assertion: string }).assertion).split('.');
    expect(
      createVerify('RSA-SHA256')
        .update(`${assertion[0]}.${assertion[1]}`)
        .verify(createPublicKey(privateKey), Buffer.from(assertion[2] ?? '', 'base64url')),
    ).toBe(true);
    expect(claimsOf(token)).toMatchObject({
      iss: 'sa@p.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: GOOGLE_TOKEN,
    });
    expect(claimsOf(token).sub).toBeUndefined();
    expect(call.headers.authorization).toBe('Bearer tok-1');
    expect(call.headers['x-other']).toBe('1');
    expect(call.options.headers?.Authorization).toBeUndefined();
  });

  it('caches the token: one call per credential', async () => {
    const fake = tokenFake();
    const creds = googleKeys();
    await send(fake, googleApi, creds, { url: API });
    await send(fake, googleApi, creds, { url: API });
    expect(tokenCalls(fake)).toHaveLength(1);
    expect(fake.requests[2]?.headers.authorization).toBe('Bearer tok-1');
  });

  it('never gives a second credential the token of the first', async () => {
    const fake = tokenFake();
    await send(fake, googleApi, googleKeys(), { url: API });
    await send(fake, googleApi, googleKeys(), { url: API });
    expect(tokenCalls(fake)).toHaveLength(2);
    expect(fake.requests[3]?.headers.authorization).toBe('Bearer tok-2');
  });

  it('fetches a new token for the same key with another subject or other scopes', async () => {
    const fake = tokenFake();
    const creds = googleKeys({ inpersonate: true, delegatedEmail: 'one@x.test' });
    await send(fake, googleApi, creds, { url: API });
    await send(fake, googleApi, { ...creds, delegatedEmail: 'two@x.test' }, { url: API });
    await send(fake, googleApi, { ...creds, scopes: 'a b' }, { url: API });
    const tokens = tokenCalls(fake);
    expect(tokens).toHaveLength(3);
    expect(claimsOf(tokens[0]).sub).toBe('one@x.test');
    expect(claimsOf(tokens[1]).sub).toBe('two@x.test');
    expect(claimsOf(tokens[2]).scope).toBe('a b');
  });

  it('ignores the delegated email when impersonation is off, and splits scopes on commas too', async () => {
    const fake = tokenFake();
    await send(fake, googleApi, googleKeys({ delegatedEmail: 'one@x.test', scopes: ' a,b\nc ' }), {
      url: API,
    });
    expect(claimsOf(fake.requests[0]).sub).toBeUndefined();
    expect(claimsOf(fake.requests[0]).scope).toBe('a b c');
  });

  it('refetches once the token nears expiry', async () => {
    const fake = new FakeHttpClient()
      .on('POST', GOOGLE_TOKEN, () => ({ access_token: 'short', expires_in: 30 }))
      .on('*', /aiplatform/, () => ({ ok: 1 }));
    const creds = googleKeys();
    await send(fake, googleApi, creds, { url: API });
    await send(fake, googleApi, creds, { url: API });
    expect(tokenCalls(fake)).toHaveLength(2);
  });

  it('refuses the token host outside the allowed domains before any call', async () => {
    const fake = tokenFake();
    const creds = googleKeys({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'aiplatform.googleapis.com',
    });
    await expect(send(fake, googleApi, creds, { url: API })).rejects.toBeInstanceOf(CredentialDomainError);
    expect(fake.requests).toHaveLength(0);
  });

  it('passes as cache scope the JSON of the five named fields, and no secret', async () => {
    const creds = googleKeys();
    const [scope] = await cacheScopes(tokenFake(), googleApi, creds, { url: API });
    const parsed = JSON.parse(scope ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(CACHE_SCOPE_FIELDS);
    expect(parsed).toMatchObject({ tokenUrl: GOOGLE_TOKEN, subject: creds.email });
    expect(scope).not.toContain(String(creds.privateKey));
  });

  it('asks for the cloud-platform scope on the Vertex AI and project list hosts when none is typed', async () => {
    for (const url of [
      API,
      'https://aiplatform.eu.rep.googleapis.com/v1/x',
      'https://us-central1-aiplatform.googleapis.com/v1/x',
      'https://cloudresourcemanager.googleapis.com/v3/projects:search',
    ]) {
      const fake = new FakeHttpClient()
        .on('POST', GOOGLE_TOKEN, () => ({ access_token: 'tok', expires_in: 3600 }))
        .on('*', /googleapis/, () => ({ ok: 1 }));
      const creds = googleKeys({ scopes: '' });
      await send(fake, googleApi, creds, { url });
      expect(claimsOf(tokenCalls(fake)[0]).scope).toBe('https://www.googleapis.com/auth/cloud-platform');
    }
  });

  it('keeps a typed scope on a Vertex AI host', async () => {
    const fake = tokenFake();
    await send(fake, googleApi, googleKeys({ scopes: 'a' }), { url: API });
    expect(claimsOf(tokenCalls(fake)[0]).scope).toBe('a');
  });

  it("asks for n8n's Sheets scopes on the Sheets host when none is typed", async () => {
    const fake = new FakeHttpClient()
      .on('POST', GOOGLE_TOKEN, () => ({ access_token: 'tok', expires_in: 3600 }))
      .on('*', /googleapis/, () => ({ ok: 1 }));
    await send(fake, googleApi, googleKeys({ scopes: '' }), { url: 'https://sheets.googleapis.com/v4/x' });
    expect(claimsOf(tokenCalls(fake)[0]).scope).toBe(
      'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata',
    );
  });

  it('refuses a missing email, key or scope, and a bad key with no key text', async () => {
    const fake = tokenFake();
    // a Google host that gets no default scope
    const OTHER = 'https://www.googleapis.com/x';
    for (const [extra, url] of [
      [{ email: '' }, API],
      [{ privateKey: '' }, API],
      [{ scopes: '  ' }, OTHER],
      // the default scope is for https calls to these hosts only
      [{ scopes: '  ' }, 'http://aiplatform.googleapis.com/v1/x'],
      [{ scopes: '  ' }, 'https://aiplatform.googleapis.com.evil.example/v1/x'],
    ] as const) {
      expect(await messageOf(send(fake, googleApi, googleKeys(extra), { url }))).toBe(
        'The Google credential needs an email, a private key and at least one scope',
      );
    }
    const bad = await messageOf(send(fake, googleApi, googleKeys({ privateKey: SECRET }), { url: API }));
    expect(bad).toBe('The service account private key is not valid');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('credential icons', () => {
  it('shows a brand icon for the AWS and Google types', () => {
    expect(aws.icon).toBe('simple:amazonaws');
    expect(awsAssumeRole.icon).toBe('simple:amazonaws');
    expect(googleApi.icon).toBe('simple:googlecloud');
  });
});

describe('through a running node', () => {
  const caller: NodeType = {
    description: {
      name: 'test.p519Caller',
      displayName: 'Cloud caller',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Cloud caller' },
      inputs: ['main'],
      outputs: ['main'],
      credentials: [{ name: 'aws', required: true }],
      properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '' }],
    },
    async execute(ctx) {
      const url = String(ctx.getNodeParameter('url', 0));
      const body = await ctx.helpers.httpRequestWithAuthentication(
        'aws',
        { url, method: 'POST', body: { a: 1 } },
        0,
      );
      return [[{ json: { body: body as never } }]];
    },
  };

  beforeAll(() => {
    nodeTypes.register(caller);
  });

  it('signs through httpRequestWithAuthentication', async () => {
    const creds = awsKeys();
    const fake = fakeWith();
    const run = await runNode('test.p519Caller', { url: BEDROCK }, [{ json: {} }], {
      creds: { aws: creds },
      services: { http: fake },
    });
    expect(run.status).toBe('success');
    expectSigned(fake.requests[0] as RecordedRequest, keysOf(creds), 'bedrock', 'us-east-1');
  });

  it('a refused host fails the run before any call, and the secret is nowhere in the result', async () => {
    const creds = awsKeys();
    const fake = fakeWith();
    const run = await runNode('test.p519Caller', { url: 'https://evilamazonaws.com/x' }, [{ json: {} }], {
      creds: { aws: creds },
      services: { http: fake },
    });
    expect(run.status).toBe('error');
    expect(String(run.error?.message)).toContain('only sign https');
    expect(JSON.stringify(run.result)).not.toContain(String(creds.secretAccessKey));
    expect(fake.requests).toHaveLength(0);
  });
});
