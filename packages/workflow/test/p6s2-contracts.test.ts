/** Phase 6 S2 contract step, C0a: identity triggers, the credential readiness gate body, and the new type fields. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CREDENTIAL_CONNECTIONS_REQUIRED,
  type CredentialGateHelper,
  type CredentialGateResult,
  credentialConnectionsRequiredBody,
  type DataObject,
  IDENTITY_TRIGGERS_TEXT,
  type NodeProperty,
  triggerProvidesIdentity,
  type WebhookContext,
  type WebhookResponseData,
} from '../src';

describe('triggerProvidesIdentity', () => {
  // each row: a trigger that gives a user identity, and its twin that does not
  const rows: Array<{
    name: string;
    yes: [string, DataObject | undefined];
    no: [string, DataObject | undefined];
  }> = [
    { name: 'manual', yes: ['core.manualTrigger', undefined], no: ['core.scheduleTrigger', undefined] },
    {
      name: 'sub-workflow',
      yes: ['core.executeWorkflowTrigger', {}],
      no: ['core.errorTrigger', {}],
    },
    {
      name: 'hosted chat with workspace sign-in',
      yes: ['ai.chatTrigger', { public: true, authentication: 'n8nUserAuth', mode: 'hostedChat' }],
      no: ['ai.chatTrigger', { public: false, authentication: 'n8nUserAuth', mode: 'hostedChat' }],
    },
    {
      name: 'hosted chat, mode left at its default',
      yes: ['ai.chatTrigger', { public: true, authentication: 'n8nUserAuth' }],
      no: ['ai.chatTrigger', { public: true, authentication: 'basicAuth' }],
    },
    {
      name: 'embedded chat',
      yes: ['ai.chatTrigger', { public: true, authentication: 'n8nUserAuth', mode: 'hostedChat' }],
      no: ['ai.chatTrigger', { public: true, authentication: 'n8nUserAuth', mode: 'webhook' }],
    },
    {
      name: 'MCP with OAuth',
      yes: ['ai.mcpTrigger', { authentication: 'n8nOAuth2' }],
      no: ['ai.mcpTrigger', { authentication: 'bearerAuth' }],
    },
    {
      name: 'webhook with OAuth',
      yes: ['core.webhook', { authentication: 'n8nOAuth2' }],
      no: ['core.webhook', { authentication: 'none' }],
    },
    {
      name: 'form with user auth',
      yes: ['core.formTrigger', { authentication: 'n8nUserAuth' }],
      no: ['core.formTrigger', { authentication: 'basicAuth' }],
    },
  ];

  it.each(rows)('$name gives an identity, its twin does not', ({ yes, no }) => {
    expect(triggerProvidesIdentity(...yes)).toBe(true);
    expect(triggerProvidesIdentity(...no)).toBe(false);
  });

  it('needs the parameters where the type alone is not enough', () => {
    for (const type of ['ai.chatTrigger', 'ai.mcpTrigger', 'core.webhook', 'core.formTrigger']) {
      expect(triggerProvidesIdentity(type, undefined), type).toBe(false);
    }
    // a string "true" is not the boolean the node stores
    expect(triggerProvidesIdentity('ai.chatTrigger', { public: 'true', authentication: 'n8nUserAuth' })).toBe(
      false,
    );
  });

  it('names every identity trigger for the publish error, with no "n8n" in it', () => {
    for (const label of [
      'Manual Trigger',
      'When Executed by Another Workflow',
      'Chat Trigger',
      'MCP Server Trigger',
      'Webhook',
      'Form Trigger',
    ]) {
      expect(IDENTITY_TRIGGERS_TEXT).toContain(label);
    }
    expect(IDENTITY_TRIGGERS_TEXT).not.toMatch(/n8n/i);
  });
});

describe('credential readiness gate', () => {
  const result: CredentialGateResult = {
    readyToExecute: false,
    credentials: [
      { credentialId: 'c1', credentialName: 'Google', credentialType: 'googleOAuth2Api', status: 'missing' },
      { credentialId: 'c2', credentialName: 'Slack', credentialType: 'slackOAuth2Api', status: 'configured' },
    ],
  };

  it('answers with the status code word and every credential under its n8n field names', () => {
    expect(CREDENTIAL_CONNECTIONS_REQUIRED).toBe('credential_connections_required');
    expect(credentialConnectionsRequiredBody(result)).toEqual({
      status: 'credential_connections_required',
      readyToExecute: false,
      credentials: [
        {
          credentialId: 'c1',
          credentialName: 'Google',
          credentialType: 'googleOAuth2Api',
          credentialStatus: 'missing',
        },
        {
          credentialId: 'c2',
          credentialName: 'Slack',
          credentialType: 'slackOAuth2Api',
          credentialStatus: 'configured',
        },
      ],
    });
  });

  it('puts no URL in the body', () => {
    const body = JSON.stringify(credentialConnectionsRequiredBody(result));
    expect(body).not.toMatch(/url|https?:|\//i);
  });

  it('types the helper and the webhook seams', () => {
    expectTypeOf<CredentialGateHelper['check']>().toEqualTypeOf<
      (userId: string) => Promise<CredentialGateResult>
    >();
    expectTypeOf<CredentialGateHelper['connectPageUrl']>().toEqualTypeOf<
      (credentialId: string, action: 'connect' | 'disconnect', returnTo: string) => string
    >();
    // optional, like getMcpAuth, so hand-built contexts stay valid
    expectTypeOf<WebhookContext['getCredentialGate']>().toEqualTypeOf<
      (() => CredentialGateHelper | undefined) | undefined
    >();
    expectTypeOf<WebhookResponseData['triggerUserId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NodeProperty['doNotInherit']>().toEqualTypeOf<boolean | undefined>();
  });
});
