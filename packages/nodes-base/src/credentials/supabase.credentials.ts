/**
 * The Supabase credential, with n8n's field names: the project URL and the secret (service role) key. Every
 * request carries the key twice, as PostgREST asks: in `apikey` and as a bearer token.
 */
import type { CredentialType } from '@workflow/workflow';

export const supabaseApi: CredentialType = {
  name: 'supabaseApi',
  displayName: 'Supabase API',
  icon: 'simple:supabase',
  documentationUrl: 'https://supabase.com/docs/guides/api/api-keys',
  properties: [
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://your-project.supabase.co',
      description: 'The project URL, without a path',
    },
    {
      displayName: 'Secret Key',
      name: 'serviceRole',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
      description: 'The secret or service role key of the project; it bypasses row level security',
    },
  ],
  authenticate: {
    type: 'generic',
    properties: {
      headers: {
        apikey: '={{$credentials.serviceRole}}',
        authorization: '=Bearer {{$credentials.serviceRole}}',
      },
    },
  },
  test: { request: { url: '={{$credentials.host}}/rest/v1/', method: 'GET' } },
};
