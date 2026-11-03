/** Authentication choice shared by the HTTP Request and GraphQL nodes. */
import type {
  ExecuteContext,
  HttpFullResponse,
  HttpRequestOptions,
  NodeCredentialDescription,
  NodeProperty,
} from '@workflow/workflow';
import { NodeOperationError } from '@workflow/workflow';

export const GENERIC_AUTH_TYPES = [
  { name: 'Basic Auth', value: 'httpBasicAuth' },
  { name: 'Bearer Auth', value: 'httpBearerAuth' },
  { name: 'Custom Auth', value: 'httpCustomAuth' },
  { name: 'Digest Auth', value: 'httpDigestAuth' },
  { name: 'Header Auth', value: 'httpHeaderAuth' },
  { name: 'OAuth1', value: 'oAuth1Api' },
  { name: 'OAuth2', value: 'oAuth2Api' },
  { name: 'Query Auth', value: 'httpQueryAuth' },
];

export const authCredentialDescriptions: NodeCredentialDescription[] = GENERIC_AUTH_TYPES.map((t) => ({
  name: t.value,
  required: true,
  displayOptions: { show: { authentication: ['genericCredentialType'], genericAuthType: [t.value] } },
}));

export const authProperties: NodeProperty[] = [
  {
    displayName: 'Authentication',
    name: 'authentication',
    type: 'options',
    default: 'none',
    noDataExpression: true,
    options: [
      { name: 'None', value: 'none' },
      {
        name: 'Predefined Credential Type',
        value: 'predefinedCredentialType',
        description: 'Reuse the credential of an app integration (tokens are refreshed automatically)',
      },
      {
        name: 'Generic Credential Type',
        value: 'genericCredentialType',
        description: 'Basic, digest, header, query, bearer, OAuth1, OAuth2 or custom authentication',
      },
    ],
  },
  {
    displayName: 'Credential Type',
    name: 'nodeCredentialType',
    type: 'credentialsSelect',
    default: '',
    required: true,
    noDataExpression: true,
    description: 'Any credential type, e.g. notionApi or slackApi',
    displayOptions: { show: { authentication: ['predefinedCredentialType'] } },
  },
  {
    displayName: 'Generic Auth Type',
    name: 'genericAuthType',
    type: 'options',
    default: 'httpHeaderAuth',
    noDataExpression: true,
    options: GENERIC_AUTH_TYPES,
    displayOptions: { show: { authentication: ['genericCredentialType'] } },
  },
];

/**
 * Send a request with the authentication configured on the node for item `itemIndex`. The URL is
 * typed by the user, so credentials are sent with `credentialScope: 'userUrl'` (their `none` domain
 * mode applies here only).
 */
export async function authenticatedRequest<T = unknown>(
  ctx: ExecuteContext,
  itemIndex: number,
  request: HttpRequestOptions,
): Promise<T | HttpFullResponse<T>> {
  const options: HttpRequestOptions = { ...request, credentialScope: 'userUrl' };
  const authentication = ctx.getNodeParameter('authentication', itemIndex, 'none') as string;
  if (authentication === 'predefinedCredentialType') {
    const type = String(ctx.getNodeParameter('nodeCredentialType', itemIndex, '') ?? '');
    if (!type) {
      throw new NodeOperationError(ctx.getNode(), 'Select a credential type', {
        itemIndex,
        parameter: 'nodeCredentialType',
      });
    }
    return ctx.helpers.httpRequestWithAuthentication<T>(type, options, itemIndex);
  }
  if (authentication === 'genericCredentialType') {
    const type = ctx.getNodeParameter('genericAuthType', itemIndex, 'httpHeaderAuth') as string;
    if (!GENERIC_AUTH_TYPES.some((t) => t.value === type)) {
      throw new NodeOperationError(ctx.getNode(), `Unknown generic auth type "${type}"`, { itemIndex });
    }
    return ctx.helpers.httpRequestWithAuthentication<T>(type, options, itemIndex);
  }
  return ctx.helpers.httpRequest<T>(request);
}
