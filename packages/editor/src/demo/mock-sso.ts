/**
 * P6-13: the demo's SSO settings, answering the server's codes and texts. `GET /auth/sso-options` is public (the
 * sign-in page asks it before anyone is signed in): it answers what `MockBackend.setDemoSso` set, else what the
 * saved method says (email when none is on). The method, the SAML and OIDC settings and the per-member manual
 * login flag need the scopes the server asks for. One method is on at a time; moving from one to another goes
 * through email; a method with nothing saved cannot be turned on. The OIDC client secret is blank on read and a
 * blank on save keeps the old one. L11 owns this file.
 */
import type {
  OidcConfig,
  OidcConfigBody,
  SamlConfig,
  SamlConfigBody,
  SsoMethod,
  SsoOptions,
} from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, HttpError } from './mock-http';

const DEMO_BASE = 'https://workflow.example.com';

const SAML_DEFAULT_MAPPING: SamlConfig['mapping'] = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/firstname',
  lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/lastname',
  userPrincipalName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
};

const METHOD_NAMES: Record<SsoMethod, string> = { email: 'Email', saml: 'SAML', oidc: 'OIDC', ldap: 'LDAP' };
const METHODS: readonly SsoMethod[] = ['email', 'saml', 'oidc', 'ldap'];
const PROMPTS: readonly string[] = ['none', 'login', 'consent', 'select_account', 'create'];

interface SsoState {
  /** what `setDemoSso` set (null: the sign-in options follow the saved method) */
  options: SsoOptions | null;
  method: SsoMethod;
  saml: SamlConfig;
  oidc: OidcConfig;
  /** the stored OIDC secret (never answered) */
  oidcSecret: string;
}

function state(backend: MockBackend): SsoState {
  let s = backend.ext.sso as SsoState | undefined;
  if (!s) {
    s = {
      options: null,
      method: 'email',
      saml: {
        metadata: '',
        metadataUrl: '',
        mapping: { ...SAML_DEFAULT_MAPPING },
        loginBinding: 'redirect',
        loginEnabled: false,
        loginLabel: 'SAML',
        emailVerifiedRequired: false,
      },
      oidc: {
        clientId: '',
        clientSecret: '',
        discoveryEndpoint: '',
        loginEnabled: false,
        prompt: 'select_account',
        authenticationContextClassReference: [],
        additionalScopes: '',
        emailVerifiedRequired: false,
        rpInitiatedLogoutEnabled: false,
      },
      oidcSecret: '',
    };
    backend.ext.sso = s;
  }
  return s;
}

/** the sign-in options of the demo, as `GET /auth/sso-options` answers them (email when none is set) */
export function demoSsoOptions(backend: MockBackend): SsoOptions {
  const s = state(backend);
  if (s.options) return copy(s.options);
  if (s.method === 'saml') return { method: 'saml', label: s.saml.loginLabel || 'SAML', redirect: false };
  if (s.method === 'oidc') return { method: 'oidc', label: null, redirect: false };
  return { method: s.method, redirect: false };
}

/** tests and demo (`MockBackend.setDemoSso`): the sign-in options; null goes back to the saved method */
export function setDemoSsoOptions(backend: MockBackend, options: SsoOptions | null): void {
  state(backend).options = options ? copy(options) : null;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

function samlView(backend: MockBackend, s: SsoState): SamlConfig {
  const slug = backend.auth().tenant.slug;
  return {
    ...copy(s.saml),
    loginEnabled: s.method === 'saml',
    entityID: `${DEMO_BASE}/sso/saml/${slug}/metadata`,
    returnUrl: `${DEMO_BASE}/sso/saml/${slug}/acs`,
  };
}

function oidcView(backend: MockBackend, s: SsoState): OidcConfig {
  const slug = backend.auth().tenant.slug;
  return {
    ...copy(s.oidc),
    clientSecret: '',
    loginEnabled: s.method === 'oidc',
    callbackUrl: `${DEMO_BASE}/sso/oidc/${slug}/callback`,
  };
}

const samlSaved = (s: SsoState): boolean => Boolean(s.saml.metadata.trim() || s.saml.metadataUrl.trim());
const oidcSaved = (s: SsoState): boolean =>
  Boolean(s.oidc.clientId.trim() && s.oidc.discoveryEndpoint.trim());

function saved(s: SsoState, method: SsoMethod): boolean {
  if (method === 'saml') return samlSaved(s);
  if (method === 'oidc') return oidcSaved(s);
  return true;
}

function moveTo(s: SsoState, method: SsoMethod): void {
  if (s.method === method) return;
  if (s.method !== 'email' && method !== 'email') {
    throw new HttpError(
      400,
      'sso_switch_through_email',
      `Turn ${METHOD_NAMES[s.method]} off first. A workspace moves from one sign-in method to another through email sign-in.`,
    );
  }
  if (method !== 'ldap' && !saved(s, method)) {
    throw new HttpError(
      400,
      'sso_config_missing',
      `Save the ${METHOD_NAMES[method]} settings before turning ${METHOD_NAMES[method]} on.`,
    );
  }
  s.method = method;
}

/** off means email, but only when this protocol is the one that is on */
function switchProtocol(s: SsoState, protocol: 'saml' | 'oidc', on: boolean): void {
  if (on) moveTo(s, protocol);
  else if (s.method === protocol) s.method = 'email';
}

/** any of `saml:manage`, `oidc:manage`, `ldap:manage` (the server's `requireAnyScope`) */
function requireManage(backend: MockBackend): void {
  for (const scope of ['saml:manage', 'oidc:manage', 'ldap:manage'] as const) {
    try {
      backend.requireScope(scope);
      return;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  backend.requireScope('saml:manage');
}

function applySaml(s: SsoState, body: Record<string, unknown>): void {
  const next = copy(s.saml);
  const metadata = text(body.metadata);
  const metadataUrl = text(body.metadataUrl);
  if (metadata !== undefined) next.metadata = metadata.trim();
  if (metadataUrl !== undefined) next.metadataUrl = metadataUrl.trim();
  if (next.metadata.includes('<!DOCTYPE')) {
    throw new HttpError(400, 'bad_request', 'The identity provider metadata is not accepted');
  }
  if (!next.metadata && !next.metadataUrl) {
    throw new HttpError(400, 'bad_request', 'Add the identity provider metadata (XML or a URL)');
  }
  if (next.metadataUrl && !/^https:\/\//i.test(next.metadataUrl)) {
    throw new HttpError(400, 'bad_request', 'The metadata URL must start with https://');
  }
  const mapping = body.mapping as Record<string, unknown> | undefined;
  if (mapping && typeof mapping === 'object') {
    for (const key of Object.keys(next.mapping) as (keyof SamlConfig['mapping'])[]) {
      const value = text(mapping[key])?.trim();
      if (value !== undefined) next.mapping[key] = value || SAML_DEFAULT_MAPPING[key];
    }
  }
  if (body.loginBinding === 'redirect' || body.loginBinding === 'post') next.loginBinding = body.loginBinding;
  const label = text(body.loginLabel)?.trim();
  if (label !== undefined) next.loginLabel = label || 'SAML';
  const verified = flag(body.emailVerifiedRequired);
  if (verified !== undefined) next.emailVerifiedRequired = verified;
  s.saml = next;
}

function applyOidc(s: SsoState, body: Record<string, unknown>): void {
  const next = copy(s.oidc);
  const clientId = text(body.clientId)?.trim();
  const discovery = text(body.discoveryEndpoint)?.trim();
  if (clientId !== undefined) next.clientId = clientId;
  if (discovery !== undefined) next.discoveryEndpoint = discovery;
  if (!next.clientId) throw new HttpError(400, 'bad_request', 'The client ID is required');
  if (!next.discoveryEndpoint) throw new HttpError(400, 'bad_request', 'The discovery endpoint is required');
  if (!/^https:\/\//i.test(next.discoveryEndpoint)) {
    throw new HttpError(400, 'bad_request', 'The discovery endpoint must start with https://');
  }
  const secret = text(body.clientSecret);
  if (!s.oidcSecret && !secret) throw new HttpError(400, 'bad_request', 'The client secret is required');
  const prompt = text(body.prompt);
  if (prompt !== undefined) {
    if (!PROMPTS.includes(prompt)) throw new HttpError(400, 'validation_error', 'Request validation failed');
    next.prompt = prompt as OidcConfig['prompt'];
  }
  if (Array.isArray(body.authenticationContextClassReference)) {
    next.authenticationContextClassReference = body.authenticationContextClassReference
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  const scopes = text(body.additionalScopes);
  if (scopes !== undefined) next.additionalScopes = scopes.trim();
  const verified = flag(body.emailVerifiedRequired);
  if (verified !== undefined) next.emailVerifiedRequired = verified;
  const logout = flag(body.rpInitiatedLogoutEnabled);
  if (logout !== undefined) next.rpInitiatedLogoutEnabled = logout;
  if (secret) s.oidcSecret = secret;
  s.oidc = next;
}

export function registerSsoRoutes(backend: MockBackend): void {
  // public, as the server's: the sign-in page reads the method before a session exists (`?workspace=<slug>`)
  backend.on('GET', '/auth/sso-options', () => demoSsoOptions(backend));

  backend.on('GET', '/sso/method', () => {
    requireManage(backend);
    return { method: state(backend).method };
  });
  backend.on('PUT', '/sso/method', ({ body }) => {
    requireManage(backend);
    const method = METHODS.find((m) => m === body.method);
    if (!method) throw new HttpError(400, 'validation_error', 'Request validation failed');
    moveTo(state(backend), method);
    return { method: state(backend).method };
  });

  // a member's password sign-in while SSO is on
  backend.on('PATCH', '/members/:userId/sso-settings', ({ params, body }) => {
    const { tenant } = backend.requireScope('user:update');
    const userId = params[0];
    if (typeof body.allowSsoManualLogin !== 'boolean') {
      throw new HttpError(400, 'validation_error', 'Request validation failed');
    }
    const membership = backend.memberships.find((m) => m.tenantId === tenant.id && m.userId === userId);
    const user = backend.users.find((u) => u.id === userId);
    if (!membership || !user) throw new HttpError(404, 'not_found', 'Member not found');
    membership.allowSsoManualLogin = body.allowSsoManualLogin;
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: membership.role,
      status: membership.status ?? 'active',
      allowSsoManualLogin: body.allowSsoManualLogin,
    };
  });

  backend.on('GET', '/sso/saml/config', () => {
    backend.requireScope('saml:manage');
    return samlView(backend, state(backend));
  });
  backend.on('POST', '/sso/saml/config', ({ body }) => {
    backend.requireScope('saml:manage');
    const s = state(backend);
    applySaml(s, body as SamlConfigBody as Record<string, unknown>);
    if (typeof body.loginEnabled === 'boolean') switchProtocol(s, 'saml', body.loginEnabled);
    return samlView(backend, s);
  });
  backend.on('POST', '/sso/saml/config/toggle', ({ body }) => {
    backend.requireScope('saml:manage');
    if (typeof body.loginEnabled !== 'boolean') {
      throw new HttpError(400, 'validation_error', 'Request validation failed');
    }
    const s = state(backend);
    switchProtocol(s, 'saml', body.loginEnabled);
    return samlView(backend, s);
  });
  backend.on('POST', '/sso/saml/config/test', () => {
    backend.requireScope('saml:manage');
    const s = state(backend);
    if (!samlSaved(s)) {
      throw new HttpError(400, 'sso_config_missing', 'Save the SAML settings before turning SAML on.');
    }
    return { url: `${DEMO_BASE}/sso/saml/${backend.auth().tenant.slug}/initsso?test=demo` };
  });

  backend.on('GET', '/sso/oidc/config', () => {
    backend.requireScope('oidc:manage');
    return oidcView(backend, state(backend));
  });
  backend.on('POST', '/sso/oidc/config', ({ body }) => {
    backend.requireScope('oidc:manage');
    const s = state(backend);
    applyOidc(s, body as OidcConfigBody as Record<string, unknown>);
    if (typeof body.loginEnabled === 'boolean') switchProtocol(s, 'oidc', body.loginEnabled);
    return oidcView(backend, s);
  });
  backend.on('POST', '/sso/oidc/config/test', () => {
    backend.requireScope('oidc:manage');
    const s = state(backend);
    if (!oidcSaved(s)) {
      throw new HttpError(400, 'sso_config_missing', 'Save the OIDC settings before turning OIDC on.');
    }
    return { url: `${DEMO_BASE}/sso/oidc/${backend.auth().tenant.slug}/login?test=demo` };
  });
}
