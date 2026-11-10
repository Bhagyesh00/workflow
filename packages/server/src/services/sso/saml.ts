/**
 * P6-09 (L7): SAML 2.0 sign-in per workspace (samlify, both messages and assertions signed, schema
 * validation through xmllint-wasm, any DOCTYPE refused, 1 MB cap, replay guard on the assertion id). The
 * entity id and ACS hold the workspace slug; audience, destination and issuer are checked against the
 * workspace's row. IdP metadata by XML or by an https URL through `ctx.http`. The test flow renders a result
 * page and never makes a session. A sign-in goes through `ctx.ssoLogin.signIn(..., { authMethod: 'saml' })`.
 * Stub from C0: every method throws until L7.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthResult, SessionMeta } from '../auth';

/** what the ACS answers the browser: a session, or the test flow's result page */
export type SamlAcsResult =
  | { kind: 'session'; result: AuthResult; redirect: string }
  | { kind: 'test'; html: string };

export class SamlService {
  constructor(readonly deps: ServiceDeps) {}

  /** GET /sso/saml/:slug/metadata: the service provider metadata XML */
  async metadata(_slug: string): Promise<string> {
    throw new Error('not implemented (L7)');
  }

  /** GET /sso/saml/:slug/initsso: the IdP address to send the browser to (redirect binding) or a POST page */
  async initSso(_slug: string, _relayState?: string): Promise<{ redirect?: string; html?: string }> {
    throw new Error('not implemented (L7)');
  }

  /** GET (redirect binding) and POST (POST binding) /sso/saml/:slug/acs */
  async acs(
    _slug: string,
    _binding: 'redirect' | 'post',
    _message: DataObject,
    _meta: SessionMeta,
  ): Promise<SamlAcsResult> {
    throw new Error('not implemented (L7)');
  }

  /** GET /rest/sso/saml/config (`saml:manage`): the config with secrets blanked */
  async getConfig(_tenantId: string): Promise<DataObject> {
    throw new Error('not implemented (L7)');
  }

  /** POST /rest/sso/saml/config (`saml:manage`); also the public `PUT /settings/sso/saml` (L12) */
  async saveConfig(_tenantId: string, _input: DataObject, _actorId: string | null): Promise<DataObject> {
    throw new Error('not implemented (L7)');
  }

  /** POST /rest/sso/saml/config/toggle */
  async toggle(_tenantId: string, _enabled: boolean, _actorId: string | null): Promise<void> {
    throw new Error('not implemented (L7)');
  }

  /** POST /rest/sso/saml/config/test: the IdP address of a test sign-in (runs while the method is off) */
  async testUrl(_tenantId: string): Promise<{ url: string }> {
    throw new Error('not implemented (L7)');
  }
}
