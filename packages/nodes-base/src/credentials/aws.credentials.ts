/**
 * AWS credentials, with the field names of n8n. Stub of the shared-contracts step: the properties are
 * final, L1 fills the region check and `authenticate`. "Use System Credentials" is left out on purpose:
 * lending the host's AWS identity to tenant workflows would break the tenant rule.
 */
import type { CredentialType, NodeProperty } from '@workflow/workflow';

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
  authenticate: async () => {
    throw new Error('not implemented (L1)');
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
  authenticate: async () => {
    throw new Error('not implemented (L1)');
  },
};
