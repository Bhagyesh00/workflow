/**
 * AWS credentials, with the field names of n8n. A signature goes only to an https amazonaws.com host, since
 * it leaks the key id and can be replayed. "Use System Credentials" is left out on purpose: lending the
 * host's AWS identity to tenant workflows would break the tenant rule.
 */
import {
  type CredentialAuthHelpers,
  type CredentialTestRequest,
  type CredentialType,
  type DataObject,
  formEntries,
  type HttpRequestOptions,
  type NodeProperty,
} from '@workflow/workflow';

const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'ca-west-1',
  'mx-central-1',
  'sa-east-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-6',
  'ap-southeast-7',
  'cn-north-1',
  'cn-northwest-1',
  'us-gov-east-1',
  'us-gov-west-1',
];

const region: NodeProperty = {
  displayName: 'Region',
  name: 'region',
  type: 'options',
  default: 'us-east-1',
  options: AWS_REGIONS.map((value) => ({ name: value, value })),
};

function endpoint(displayName: string, name: string): NodeProperty {
  return {
    displayName,
    name,
    type: 'string',
    default: '',
    displayOptions: { show: { customEndpoints: [true] } },
  };
}

const customEndpoints: NodeProperty[] = [
  {
    displayName: 'Custom Endpoints',
    name: 'customEndpoints',
    type: 'boolean',
    default: false,
    description: 'Send requests to your own service endpoints instead of the default AWS ones',
  },
  endpoint('Rekognition Endpoint', 'rekognitionEndpoint'),
  endpoint('Lambda Endpoint', 'lambdaEndpoint'),
  endpoint('SNS Endpoint', 'snsEndpoint'),
  endpoint('SES Endpoint', 'sesEndpoint'),
  endpoint('SQS Endpoint', 'sqsEndpoint'),
  endpoint('S3 Endpoint', 's3Endpoint'),
  endpoint('SSM Endpoint', 'ssmEndpoint'),
  endpoint('Bedrock Endpoint', 'bedrockEndpoint'),
  endpoint('Bedrock Runtime Endpoint', 'bedrockRuntimeEndpoint'),
];

const AWS_HOST = /(^|\.)amazonaws\.com(\.cn)?$/i;
const REGION_NAME = /^[a-z]{2}(-[a-z]+)+-\d$/;
const DEFAULT_SESSION_NAME = 'workflow-session';
const STS_VERSION = '2011-06-15';
/** set by the signer alone; a caller's copy would go into the signature */
const SIGNER_HEADERS = new Set(['host', 'authorization', 'x-amz-date', 'x-amz-security-token']);

interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function signingHelpers(helpers: CredentialAuthHelpers | undefined): CredentialAuthHelpers {
  if (!helpers) throw new Error('This credential can only sign through the workflow engine');
  return helpers;
}

function assertSignableUrl(url: string): void {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !AWS_HOST.test(target.hostname)) {
    throw new Error('AWS credentials only sign https requests to amazonaws.com hosts');
  }
}

function assertRegion(credentials: DataObject): string {
  const region = text(credentials.region);
  if (!REGION_NAME.test(region)) throw new Error('The AWS region is not valid');
  return region;
}

/** some hosts differ from the name their signature uses */
function signingName(label: string): string {
  const name = label.replace(/-fips$/, '');
  if (name === 'bedrock' || name.startsWith('bedrock-')) return 'bedrock';
  return name === 'email' ? 'ses' : name;
}

/**
 * Service and region as the host names them: `<service>.<region>`, `<bucket>.s3.<region>`,
 * `s3.dualstack.<region>`, `vpce-<id>.<service>.<region>.vpce`. A host with no region is a global endpoint,
 * which AWS signs for the first region of its partition.
 */
function signingScope(hostname: string): { service: string; region: string } {
  const labels = hostname.replace(AWS_HOST, '').split('.').filter(Boolean);
  const regionAt = labels.findIndex((label) => REGION_NAME.test(label));
  const named = (regionAt === -1 ? labels : labels.slice(0, regionAt)).filter((l) => l !== 'dualstack');
  const service = named[named.length - 1];
  if (!service) throw new Error('The AWS host name holds no service to sign for');
  const global = /\.cn$/i.test(hostname) ? 'cn-north-1' : 'us-east-1';
  return { service: signingName(service), region: regionAt === -1 ? global : (labels[regionAt] ?? global) };
}

/** `qs` joins the URL: added after signing it would break the signature */
function urlWithQuery(url: string, qs: HttpRequestOptions['qs']): string {
  const target = new URL(url);
  for (const [name, value] of Object.entries(qs ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const entry of value) target.searchParams.append(name, String(entry));
    else target.searchParams.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  // the signer reads `+` as a space and signs %20: the URL sent says the same
  target.search = target.search.replace(/\+/g, '%20');
  target.hash = '';
  return target.toString();
}

function headersToSign(request: HttpRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!SIGNER_HEADERS.has(lower)) headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/** the exact text that goes out, as the client would turn it out, so the signature covers it */
function bodyToSign(
  request: HttpRequestOptions,
  method: string,
  headers: Record<string, string>,
): string | Uint8Array | undefined {
  const { body } = request;
  if (body === undefined || method === 'GET' || method === 'HEAD') return undefined;
  const given = body instanceof Uint8Array || typeof body === 'string';
  const type = request.bodyType ?? (given ? 'raw' : 'json');
  if (type === 'multipart') throw new Error('An AWS signature cannot cover a multipart body');
  if (type === 'json') {
    headers['content-type'] ??= 'application/json';
    return JSON.stringify(body);
  }
  if (type === 'form-urlencoded') {
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
    return new URLSearchParams(formEntries(body)).toString();
  }
  return given ? body : String(body);
}

function signRequest(
  request: HttpRequestOptions,
  keys: AwsKeys,
  helpers: CredentialAuthHelpers,
): HttpRequestOptions {
  const { qs, body: _body, bodyType: _bodyType, ...rest } = request;
  const url = urlWithQuery(request.url, qs);
  const method = (request.method ?? 'GET').toUpperCase();
  const headers = headersToSign(request);
  const body = bodyToSign(request, method, headers);
  const scope = signingScope(new URL(url).hostname);
  const signed = helpers.signAwsV4({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { body }),
    ...scope,
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    ...(keys.sessionToken ? { sessionToken: keys.sessionToken } : {}),
  });
  return {
    ...rest,
    url,
    headers: signed.headers,
    // a signature holds for one host only, and a redirect would carry the session token to the next
    followRedirects: false,
    ...(body === undefined ? {} : { body, bodyType: 'raw' as const }),
  };
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/** the text of one leaf element; an STS answer holds each name read here once */
function xmlText(xml: string, tag: string): string {
  const found = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? '';
  return found.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity).trim();
}

function secondsUntil(expiration: string): number {
  const at = Date.parse(expiration);
  return Number.isNaN(at) ? 3600 : Math.max(0, Math.floor((at - Date.now()) / 1000));
}

/**
 * The temporary keys of the role, from the cache while they last. AssumeRole goes through the guarded
 * client, so the STS host must be inside the credential's allowed domains. The cache holds the three keys
 * as one JSON text; the session name is the subject and the external ID the resource of the role's key.
 */
async function assumeRole(credentials: DataObject, helpers: CredentialAuthHelpers): Promise<AwsKeys> {
  const region = assertRegion(credentials);
  const accessKeyId = text(credentials.stsAccessKeyId);
  const secretAccessKey = text(credentials.stsSecretAccessKey);
  const roleArn = text(credentials.roleArn);
  const externalId = text(credentials.externalId);
  if (!accessKeyId || !secretAccessKey || !roleArn || !externalId) {
    throw new Error('The AWS Assume Role credential needs STS keys, a Role ARN and an External ID');
  }
  const sessionToken = text(credentials.stsSessionToken);
  const sessionName = text(credentials.roleSessionName) || DEFAULT_SESSION_NAME;
  const url = `https://sts.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}/`;
  assertSignableUrl(url);

  const cached = await helpers.cachedToken(
    secretAccessKey,
    JSON.stringify({ tokenUrl: url, subject: sessionName, scopes: [], resource: externalId, role: roleArn }),
    async () => {
      const body = new URLSearchParams({
        Action: 'AssumeRole',
        Version: STS_VERSION,
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        ExternalId: externalId,
      }).toString();
      const { headers } = helpers.signAwsV4({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        region,
        service: 'sts',
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      });
      const answer = await helpers.http<unknown>({
        url,
        method: 'POST',
        headers,
        body,
        bodyType: 'raw',
        responseType: 'text',
        followRedirects: false,
      });
      const xml = typeof answer === 'string' ? answer : '';
      const keys: AwsKeys = {
        accessKeyId: xmlText(xml, 'AccessKeyId'),
        secretAccessKey: xmlText(xml, 'SecretAccessKey'),
        sessionToken: xmlText(xml, 'SessionToken'),
      };
      if (!keys.accessKeyId || !keys.secretAccessKey || !keys.sessionToken) {
        throw new Error('AWS STS answered without temporary credentials');
      }
      return { token: JSON.stringify(keys), expiresInSeconds: secondsUntil(xmlText(xml, 'Expiration')) };
    },
  );
  return JSON.parse(cached) as AwsKeys;
}

/** the check n8n runs: who am I, on the STS host of the credential's region */
const stsConnectionTest: CredentialTestRequest = {
  request: {
    url: '={{"https://sts." + $credentials.region + ($credentials.region.startsWith("cn-") ? ".amazonaws.com.cn" : ".amazonaws.com") + "/?Action=GetCallerIdentity&Version=2011-06-15"}}',
    method: 'POST',
  },
};

export const aws: CredentialType = {
  name: 'aws',
  displayName: 'AWS (IAM)',
  properties: [
    region,
    { displayName: 'Access Key ID', name: 'accessKeyId', type: 'string', default: '', required: true },
    {
      displayName: 'Secret Access Key',
      name: 'secretAccessKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
    {
      displayName: 'Temporary Security Credentials',
      name: 'temporaryCredentials',
      type: 'boolean',
      default: false,
      description: 'Turn on to use a session token from AWS STS',
    },
    {
      displayName: 'Session Token',
      name: 'sessionToken',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      displayOptions: { show: { temporaryCredentials: [true] } },
    },
    ...customEndpoints,
  ],
  test: stsConnectionTest,
  authenticate: async (credentials, request, helpers) => {
    const auth = signingHelpers(helpers);
    assertSignableUrl(request.url);
    assertRegion(credentials);
    const accessKeyId = text(credentials.accessKeyId);
    const secretAccessKey = text(credentials.secretAccessKey);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('The AWS credential needs an access key ID and a secret access key');
    }
    const sessionToken = credentials.temporaryCredentials === true ? text(credentials.sessionToken) : '';
    return signRequest(request, { accessKeyId, secretAccessKey, sessionToken }, auth);
  },
};

export const awsAssumeRole: CredentialType = {
  name: 'awsAssumeRole',
  displayName: 'AWS (Assume Role)',
  properties: [
    region,
    { displayName: 'STS Access Key ID', name: 'stsAccessKeyId', type: 'string', default: '', required: true },
    {
      displayName: 'STS Access Key Secret',
      name: 'stsSecretAccessKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
    {
      displayName: 'STS Session Token',
      name: 'stsSessionToken',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
    {
      displayName: 'Role ARN',
      name: 'roleArn',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'arn:aws:iam::123456789012:role/my-role',
    },
    { displayName: 'External ID', name: 'externalId', type: 'string', default: '', required: true },
    {
      displayName: 'Role Session Name',
      name: 'roleSessionName',
      type: 'string',
      default: 'workflow-session',
      required: true,
    },
    ...customEndpoints,
  ],
  test: stsConnectionTest,
  authenticate: async (credentials, request, helpers) => {
    const auth = signingHelpers(helpers);
    assertSignableUrl(request.url);
    return signRequest(request, await assumeRole(credentials, auth), auth);
  },
};
