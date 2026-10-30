import type { CredentialType } from '@workflow/workflow';

export const httpBasicAuth: CredentialType = {
  name: 'httpBasicAuth',
  displayName: 'Basic Auth',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'User', name: 'user', type: 'string', default: '' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
  ],
  authenticate: {
    type: 'generic',
    properties: { auth: { username: '={{$credentials.user}}', password: '={{$credentials.password}}' } },
  },
};

export const httpHeaderAuth: CredentialType = {
  name: 'httpHeaderAuth',
  displayName: 'Header Auth',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'X-API-Key' },
    { displayName: 'Value', name: 'value', type: 'string', default: '', typeOptions: { password: true } },
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { '={{$credentials.name}}': '={{$credentials.value}}' } },
  },
};
