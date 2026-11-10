/**
 * P6-09 (L7): SAML 2.0 sign-in per workspace (samlify, both messages and assertions signed, schema
 * validation through xmllint-wasm, any DOCTYPE refused, 1 MB cap, replay guard on the assertion id). The
 * entity id and ACS hold the workspace slug; audience, destination and issuer are checked against the
 * workspace's row. IdP metadata by XML or by an https URL through `ctx.http`. The test flow renders a result
 * page and never makes a session. A sign-in goes through `ctx.ssoLogin.signIn(..., { authMethod: 'saml' })`.
 *
 * Stored in `tenant_auth_settings`: the identity provider's metadata XML in `saml_metadata` (pasted, or the
 * copy read from the URL), the rest in the `saml` section (metadataUrl, mapping, loginBinding, loginLabel,
 * emailVerifiedRequired, metadataFetchedAt). The service provider and identity provider objects are built
 * per workspace and kept while the row's `updated_at` stays the same (n8n keeps one for the whole process).
 * A metadata URL is read again when the stored copy is older than 24 hours; a failed read keeps the copy.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DataObject } from '@workflow/workflow';
import type { IdentityProviderInstance, ServiceProviderInstance } from 'samlify';
import { z } from 'zod';
import type { ServiceDeps } from '../../context';
import type { TenantAuthSettingsRow, TenantRow } from '../../db/schema';
import { ApiError, parse } from '../../http/errors';
import { createRepositories } from '../../repositories';
import type { AuthResult, SessionMeta } from '../auth';
import type { SsoProfile } from './login';
import { safeSsoRedirect } from './redirect';
import {
  decodePostMessage,
  decodeRedirectMessage,
  installSamlSchemaValidator,
  SAML_MAX_BYTES,
  validateIdpMetadata,
} from './saml-validator';
import { hasSavedConfig, SSO_METHOD_NAMES } from './settings';
import { type SamlTestOutcome, samlPostCsp, samlPostPage, samlTestResultPage } from './views';

// samlify is CommonJS and exports `SamlLib` through a getter Node's ESM loader does not see
const samlify: typeof import('samlify') = createRequire(import.meta.url)('samlify');

/** what the ACS answers the browser: a session, or the test flow's result page */
export type SamlAcsResult =
  | { kind: 'session'; result: AuthResult; redirect: string }
  | { kind: 'test'; html: string };

/** the mapped attribute names (the editor's `SamlAttributeMapping`) */
export interface SamlAttributeMapping {
  email: string;
  firstName: string;
  lastName: string;
  userPrincipalName: string;
}

/** n8n's default claim URIs */
export const SAML_DEFAULT_MAPPING: Readonly<SamlAttributeMapping> = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/firstname',
  lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/lastname',
  userPrincipalName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
};

export const SAML_DEFAULT_LOGIN_LABEL = 'SAML';

/** where a sign-in whose response carried no name goes, so the person can give one (P6-13 page) */
export const SAML_ONBOARDING_PATH = '/saml/onboarding';

/**
 * The refusals of the ACS before `signIn`, by code (the browser goes to `/signin?ssoError=<code>`). The
 * response's own faults share one code; the audit line keeps samlify's reason (`detail`).
 */
export const SAML_SIGN_IN_ERRORS = {
  saml_response_invalid: "The identity provider's SAML response couldn't be verified.",
  saml_response_replayed: 'This SAML response was already used. Sign in again.',
  saml_attributes_missing: "The identity provider's SAML response is missing attributes.",
  saml_config_invalid: "The workspace's SAML settings can't be read. Ask an admin of the workspace.",
} as const;
export type SamlSignInErrorCode = keyof typeof SAML_SIGN_IN_ERRORS;

const BINDING = samlify.Constants.namespace.binding;
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
/** RSA with SHA-256 or SHA-512; SHA-1 signatures and digests are refused */
const SIGNATURE_ALGORITHMS = [
  samlify.Constants.algorithms.signature.RSA_SHA256,
  samlify.Constants.algorithms.signature.RSA_SHA512,
];
/** clock difference allowed with the identity provider on NotBefore and NotOnOrAfter */
const CLOCK_DRIFT_MS = 60_000;
const TEST_TTL_MS = 10 * 60_000;
const METADATA_MAX_AGE_MS = 24 * 60 * 60_000;
/** a failed refresh of a metadata URL is tried again after this long, not on every sign-in */
const METADATA_RETRY_MS = 5 * 60_000;
const METADATA_FETCH_TIMEOUT_MS = 10_000;
const MAX_METADATA_REDIRECTS = 3;
/** a RelayState that starts the test flow: the prefix and the test's token */
const TEST_RELAY_PREFIX = 'saml-test:';
const MAX_ENTITY_CACHE = 500;
const MAX_ATTRIBUTE_LENGTH = 1024;

const mappingSchema = z
  .object({
    email: z.string().trim().min(1).max(512),
    firstName: z.string().trim().min(1).max(512),
    lastName: z.string().trim().min(1).max(512),
    userPrincipalName: z.string().trim().min(1).max(512),
  })
  .partial();

const configBody = z.object({
  metadata: z.string().max(SAML_MAX_BYTES).optional(),
  metadataUrl: z.string().trim().max(2048).optional(),
  mapping: mappingSchema.optional(),
  loginBinding: z.enum(['redirect', 'post']).optional(),
  loginEnabled: z.boolean().optional(),
  loginLabel: z.string().trim().max(100).optional(),
  emailVerifiedRequired: z.boolean().optional(),
  // always true here (decisions "Security, final"); accepted and ignored so a GET answer can be sent back
  wantAssertionsSigned: z.boolean().optional(),
  wantMessageSigned: z.boolean().optional(),
  // signed requests are hidden in n8n and not offered; accepted and ignored
  authnRequestsSigned: z.boolean().optional(),
});
type SamlConfigBody = z.output<typeof configBody>;

/** the `saml` section of `tenant_auth_settings` */
interface SamlSection {
  metadataUrl: string;
  mapping: SamlAttributeMapping;
  loginBinding: 'redirect' | 'post';
  loginLabel: string;
  emailVerifiedRequired: boolean;
  /** when the copy of `metadataUrl` was read (ISO) */
  metadataFetchedAt?: string;
}

/** a test sign-in's settings, kept 10 minutes under its token */
interface SamlTestRecord {
  tenantId: string;
  metadata: string;
  mapping: SamlAttributeMapping;
  loginBinding: 'redirect' | 'post';
}

interface SamlEntities {
  sp: ServiceProviderInstance;
  idp: IdentityProviderInstance;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readSection(row: TenantAuthSettingsRow | undefined): SamlSection {
  const raw = (row?.saml ?? {}) as Record<string, unknown>;
  const mapping = (raw.mapping && typeof raw.mapping === 'object' ? raw.mapping : {}) as Record<
    string,
    unknown
  >;
  return {
    metadataUrl: typeof raw.metadataUrl === 'string' ? raw.metadataUrl : '',
    mapping: {
      email: text(mapping.email, SAML_DEFAULT_MAPPING.email),
      firstName: text(mapping.firstName, SAML_DEFAULT_MAPPING.firstName),
      lastName: text(mapping.lastName, SAML_DEFAULT_MAPPING.lastName),
      userPrincipalName: text(mapping.userPrincipalName, SAML_DEFAULT_MAPPING.userPrincipalName),
    },
    loginBinding: raw.loginBinding === 'post' ? 'post' : 'redirect',
    loginLabel: text(raw.loginLabel, SAML_DEFAULT_LOGIN_LABEL),
    emailVerifiedRequired: raw.emailVerifiedRequired === true,
    ...(typeof raw.metadataFetchedAt === 'string' ? { metadataFetchedAt: raw.metadataFetchedAt } : {}),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** a refusal of the ACS; `detail` (a samlify code or our own) goes to the audit line only */
class SamlRefusal extends ApiError {
  constructor(
    code: SamlSignInErrorCode,
    readonly detail: string,
    message: string = SAML_SIGN_IN_ERRORS[code],
    readonly missing?: string[],
    readonly attributes?: Record<string, unknown>,
  ) {
    super(code === 'saml_config_invalid' ? 400 : 401, code, message);
  }
}

/** samlify's error codes are fixed upper-case words; anything else is reported as one word */
function samlifyCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'ERR_INVALID_RESPONSE';
}

/** the first value of an attribute, as a trimmed string */
function firstValue(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim().slice(0, MAX_ATTRIBUTE_LENGTH) : '';
}

function boolAttribute(value: unknown): boolean | undefined {
  const first = firstValue(value).toLowerCase();
  if (first === 'true' || first === '1') return true;
  if (first === 'false' || first === '0') return false;
  return undefined;
}

export class SamlService {
  /** the samlify objects per workspace, keyed on the settings row's `updated_at` */
  private readonly entities = new Map<string, SamlEntities>();
  /** memory store (no Redis): assertion ids seen, test records */
  private readonly memory = new Map<string, { value: string; expires: number }>();
  /** the last failed refresh of a workspace's metadata URL */
  private readonly refreshFailedAt = new Map<string, number>();

  constructor(readonly deps: ServiceDeps) {
    installSamlSchemaValidator();
  }

  // -------------------------------------------------------------------------------------------
  // public routes

  /** GET /sso/saml/:slug/metadata: the service provider metadata XML */
  async metadata(slug: string): Promise<string> {
    const tenant = await this.tenantBySlug(slug);
    return this.serviceProvider(tenant.slug).getMetadata();
  }

  /**
   * GET /sso/saml/:slug/initsso: the IdP address to send the browser to (redirect binding) or a POST page
   * with its own CSP. A RelayState of the test flow (`testUrl`) uses the test's settings and runs while SAML
   * is off; any other needs SAML as the workspace's active method.
   */
  async initSso(
    slug: string,
    relayState?: string,
  ): Promise<{ redirect?: string; html?: string; csp?: string }> {
    const tenant = await this.tenantBySlug(slug);
    const token = this.testToken(relayState);
    if (token !== undefined) {
      const record = await this.readTest(token);
      if (!record || record.tenantId !== tenant.id) {
        throw new ApiError(400, 'saml_test_expired', 'The SAML test has expired. Start it again.');
      }
      const idp = await this.identityProvider(record.metadata);
      return this.loginRequest(
        { sp: this.serviceProvider(tenant.slug), idp },
        record.loginBinding,
        relayState,
      );
    }
    const row = await this.deps.repos.sso.get(tenant.id);
    if (row?.method !== 'saml') {
      throw new ApiError(
        403,
        'sso_method_inactive',
        'This sign-in method is not turned on for the workspace.',
      );
    }
    const current = await this.current(tenant, row);
    const entities = await this.entitiesFor(tenant, current);
    return this.loginRequest(entities, readSection(current).loginBinding, relayState || undefined);
  }

  /** GET (redirect binding) and POST (POST binding) /sso/saml/:slug/acs */
  async acs(
    slug: string,
    binding: 'redirect' | 'post',
    message: DataObject,
    meta: SessionMeta,
  ): Promise<SamlAcsResult> {
    const tenant = await this.tenantBySlug(slug);
    const relayState = typeof message.RelayState === 'string' ? message.RelayState : undefined;
    const token = this.testToken(relayState);
    if (token !== undefined)
      return { kind: 'test', html: await this.testAcs(tenant, token, binding, message) };

    const { repos } = this.deps;
    const row = await repos.sso.get(tenant.id);
    let profile: SsoProfile;
    let noName = false;
    try {
      // GHSA-pf83-w3f9-8m37: only the active method signs anyone in (signIn checks it again)
      if (row?.method !== 'saml') {
        throw new ApiError(
          403,
          'sso_method_inactive',
          'This sign-in method is not turned on for the workspace.',
        );
      }
      const current = await this.current(tenant, row);
      const section = readSection(current);
      let entities: SamlEntities;
      try {
        entities = await this.entitiesFor(tenant, current);
      } catch {
        // n8n turns SAML off on corrupt metadata; here the config stays and the sign-in is refused
        throw new SamlRefusal('saml_config_invalid', 'metadata');
      }
      const extract = await this.verify(entities, tenant.slug, binding, message);
      profile = this.profile(extract, section);
      noName = !profile.firstName && !profile.lastName;
    } catch (error) {
      if (error instanceof ApiError) {
        await repos.audit.add(tenant.id, {
          userId: null,
          action: 'auth.sso_login_failed',
          metadata: {
            method: 'saml',
            reason: error.code,
            ...(error instanceof SamlRefusal ? { detail: error.detail } : {}),
            ...(error instanceof SamlRefusal && error.missing ? { missing: error.missing } : {}),
          },
          ip: meta.ip,
        });
      }
      throw error;
    }
    const result = await this.deps.context().ssoLogin.signIn(tenant, profile, meta, { authMethod: 'saml' });
    const redirect = noName ? SAML_ONBOARDING_PATH : safeSsoRedirect(relayState, this.deps.config.baseUrl);
    return { kind: 'session', result, redirect };
  }

  // -------------------------------------------------------------------------------------------
  // settings (`saml:manage`)

  /** GET /rest/sso/saml/config (`saml:manage`): the config with secrets blanked */
  async getConfig(tenantId: string): Promise<DataObject> {
    const tenant = await this.tenantById(tenantId);
    const row = await this.deps.repos.sso.get(tenant.id);
    const section = readSection(row);
    const { entityId, acsUrl } = this.urls(tenant.slug);
    // SAML holds no secret: the metadata and the certificates in it are public
    return {
      metadata: row?.samlMetadata ?? '',
      metadataUrl: section.metadataUrl,
      mapping: { ...section.mapping },
      loginBinding: section.loginBinding,
      loginEnabled: row?.method === 'saml',
      loginLabel: section.loginLabel,
      emailVerifiedRequired: section.emailVerifiedRequired,
      wantAssertionsSigned: true,
      wantMessageSigned: true,
      authnRequestsSigned: false,
      entityID: entityId,
      returnUrl: acsUrl,
    };
  }

  /** POST /rest/sso/saml/config (`saml:manage`); also the public `PUT /settings/sso/saml` (L12) */
  async saveConfig(tenantId: string, input: DataObject, actorId: string | null): Promise<DataObject> {
    const tenant = await this.tenantById(tenantId);
    const body = parse(configBody, input);
    const { repos } = this.deps;
    const row = await repos.sso.get(tenant.id);
    const section = readSection(row);
    const resolved = await this.resolveMetadata(body, row);
    const next: SamlSection = {
      metadataUrl: resolved.metadataUrl,
      mapping: { ...section.mapping, ...(body.mapping ?? {}) },
      loginBinding: body.loginBinding ?? section.loginBinding,
      loginLabel:
        body.loginLabel === undefined ? section.loginLabel : text(body.loginLabel, SAML_DEFAULT_LOGIN_LABEL),
      emailVerifiedRequired: body.emailVerifiedRequired ?? section.emailVerifiedRequired,
      ...(resolved.fetchedAt
        ? { metadataFetchedAt: resolved.fetchedAt }
        : resolved.metadataUrl && section.metadataFetchedAt
          ? { metadataFetchedAt: section.metadataFetchedAt }
          : {}),
    };
    await repos.sso.upsert(tenant.id, {
      saml: { ...next, mapping: { ...next.mapping } },
      ...(resolved.metadata !== undefined ? { samlMetadata: resolved.metadata } : {}),
    });
    await repos.audit.add(tenant.id, {
      userId: actorId,
      action: 'sso.saml_config_updated',
      resourceType: 'tenant',
      resourceId: tenant.id,
      metadata: { metadata: resolved.source, fields: Object.keys(body).sort() },
    });
    if (body.loginEnabled !== undefined) await this.toggle(tenant.id, body.loginEnabled, actorId);
    return this.getConfig(tenant.id);
  }

  /**
   * POST /rest/sso/saml/config/toggle: SAML on makes it the workspace's sign-in method (from email only, with
   * readable metadata); off returns to email. Audit `sso.method_changed`, as `SsoSettingsService.setMethod`;
   * SAML off turns SCIM off (the token is kept).
   */
  async toggle(tenantId: string, enabled: boolean, actorId: string | null): Promise<void> {
    const tenant = await this.tenantById(tenantId);
    const before = await this.deps.repos.sso.get(tenant.id);
    if (enabled && (before?.method ?? 'email') === 'email') {
      if (!hasSavedConfig(before, 'saml')) {
        throw new ApiError(400, 'sso_config_missing', 'Save the SAML settings before turning SAML on.');
      }
      await validateIdpMetadata(before?.samlMetadata ?? '');
    }
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const row = await repos.sso.get(tenant.id);
      const current = row?.method ?? 'email';
      const target = enabled ? 'saml' : current === 'saml' ? 'email' : current;
      if (target === current) return;
      if (enabled && current !== 'email') {
        throw new ApiError(
          400,
          'sso_switch_through_email',
          `Turn ${SSO_METHOD_NAMES[current]} off first. A workspace moves from one sign-in method to another through email sign-in.`,
        );
      }
      if (enabled && !hasSavedConfig(row, 'saml')) {
        throw new ApiError(400, 'sso_config_missing', 'Save the SAML settings before turning SAML on.');
      }
      await repos.sso.upsert(tenant.id, { method: target });
      if (current === 'saml') await repos.sso.disableScim(tenant.id);
      await repos.audit.add(tenant.id, {
        userId: actorId,
        action: 'sso.method_changed',
        resourceType: 'tenant',
        resourceId: tenant.id,
        metadata: { from: current, to: target },
      });
    });
  }

  /**
   * POST /rest/sso/saml/config/test: the address of a test sign-in (runs while the method is off). The body may
   * carry unsaved metadata, a metadata URL, mapping and binding; they are kept 10 minutes under a token that
   * travels in the RelayState. The ACS then shows a result page and makes no session.
   */
  async testUrl(tenantId: string, input: DataObject = {}): Promise<{ url: string }> {
    const tenant = await this.tenantById(tenantId);
    const body = parse(configBody, input);
    const row = await this.deps.repos.sso.get(tenant.id);
    const section = readSection(row);
    const resolved = await this.resolveMetadata(body, row);
    const metadata = resolved.metadata ?? row?.samlMetadata ?? '';
    if (!metadata.trim()) {
      throw new ApiError(
        400,
        'saml_metadata_missing',
        "Add the identity provider's metadata before testing.",
      );
    }
    await validateIdpMetadata(metadata);
    const token = randomBytes(32).toString('base64url');
    await this.keep(
      this.testKey(token),
      JSON.stringify({
        tenantId: tenant.id,
        metadata,
        mapping: { ...section.mapping, ...(body.mapping ?? {}) },
        loginBinding: body.loginBinding ?? section.loginBinding,
      } satisfies SamlTestRecord),
      TEST_TTL_MS,
    );
    const query = new URLSearchParams({ test: token });
    return { url: `${this.urls(tenant.slug).base}/initsso?${query.toString()}` };
  }

  /** the RelayState that starts the test with `token` (the initsso route builds it from `?test=`) */
  testRelayState(token: string): string {
    return `${TEST_RELAY_PREFIX}${token}`;
  }

  // -------------------------------------------------------------------------------------------
  // internals

  private urls(slug: string): { base: string; entityId: string; acsUrl: string } {
    const base = `${this.deps.config.baseUrl}/sso/saml/${encodeURIComponent(slug)}`;
    return { base, entityId: `${base}/metadata`, acsUrl: `${base}/acs` };
  }

  private async tenantBySlug(slug: string): Promise<TenantRow> {
    const tenant = await this.deps.repos.tenants.getBySlug(slug);
    if (!tenant) throw ApiError.notFound('Workspace');
    return tenant;
  }

  private async tenantById(tenantId: string): Promise<TenantRow> {
    const tenant = await this.deps.repos.tenants.get(tenantId);
    if (!tenant) throw ApiError.notFound('Workspace');
    return tenant;
  }

  private testToken(relayState: string | undefined): string | undefined {
    if (!relayState?.startsWith(TEST_RELAY_PREFIX)) return undefined;
    const token = relayState.slice(TEST_RELAY_PREFIX.length);
    return /^[A-Za-z0-9_-]{20,128}$/.test(token) ? token : '';
  }

  /** the service provider of one workspace: its entity id and ACS hold the slug */
  private serviceProvider(slug: string): ServiceProviderInstance {
    const { entityId, acsUrl } = this.urls(slug);
    return samlify.ServiceProvider({
      entityID: entityId,
      authnRequestsSigned: false,
      wantAssertionsSigned: true,
      wantMessageSigned: true,
      nameIDFormat: [EMAIL_FORMAT],
      assertionConsumerService: [
        { Binding: BINDING.post, Location: acsUrl },
        { Binding: BINDING.redirect, Location: acsUrl },
      ],
      allowedSignatureAlgorithms: SIGNATURE_ALGORITHMS,
      clockDrifts: [-CLOCK_DRIFT_MS, CLOCK_DRIFT_MS],
      wantAudienceCheck: true,
      replayCache: { saveIfAbsent: (key, expiresAt) => this.saveIfAbsent(key, expiresAt) },
    });
  }

  private async identityProvider(metadata: string): Promise<IdentityProviderInstance> {
    return validateIdpMetadata(metadata);
  }

  private async entitiesFor(tenant: TenantRow, row: TenantAuthSettingsRow): Promise<SamlEntities> {
    const key = `${tenant.id}:${tenant.slug}:${row.updatedAt.getTime()}`;
    const cached = this.entities.get(key);
    if (cached) return cached;
    const idp = await this.identityProvider(row.samlMetadata ?? '');
    const entities = { sp: this.serviceProvider(tenant.slug), idp };
    for (const old of this.entities.keys()) {
      if (old.startsWith(`${tenant.id}:`)) this.entities.delete(old);
    }
    if (this.entities.size >= MAX_ENTITY_CACHE) {
      const oldest = this.entities.keys().next().value;
      if (oldest !== undefined) this.entities.delete(oldest);
    }
    this.entities.set(key, entities);
    return entities;
  }

  /** the row, with the metadata URL read again when the stored copy is older than 24 hours */
  private async current(tenant: TenantRow, row: TenantAuthSettingsRow): Promise<TenantAuthSettingsRow> {
    const section = readSection(row);
    if (!section.metadataUrl) return row;
    const fetchedAt = Date.parse(section.metadataFetchedAt ?? '');
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < METADATA_MAX_AGE_MS) return row;
    const failedAt = this.refreshFailedAt.get(tenant.id);
    if (failedAt !== undefined && Date.now() - failedAt < METADATA_RETRY_MS) return row;
    try {
      const metadata = await this.fetchMetadata(section.metadataUrl);
      await validateIdpMetadata(metadata);
      this.refreshFailedAt.delete(tenant.id);
      return await this.deps.repos.sso.upsert(tenant.id, {
        samlMetadata: metadata,
        saml: { ...(row.saml ?? {}), metadataFetchedAt: new Date().toISOString() },
      });
    } catch {
      // the stored copy stays in use (n8n's fallback, saml.service.ee.ts:586-599)
      this.refreshFailedAt.set(tenant.id, Date.now());
      return row;
    }
  }

  /** the metadata a save or a test uses: read from the URL, the pasted XML, or none (keep the stored one) */
  private async resolveMetadata(
    body: SamlConfigBody,
    row: TenantAuthSettingsRow | undefined,
  ): Promise<{
    metadata?: string;
    metadataUrl: string;
    fetchedAt?: string;
    source: 'url' | 'xml' | 'unchanged';
  }> {
    const url = body.metadataUrl?.trim() ?? '';
    if (url) {
      const metadata = await this.fetchMetadata(url);
      await validateIdpMetadata(metadata);
      return { metadata, metadataUrl: url, fetchedAt: new Date().toISOString(), source: 'url' };
    }
    const xml = body.metadata?.trim() ?? '';
    if (xml) {
      await validateIdpMetadata(xml);
      return { metadata: xml, metadataUrl: '', source: 'xml' };
    }
    // a blank URL with no XML keeps the stored metadata; it drops the URL only when the body says so
    const stored = readSection(row).metadataUrl;
    return { metadataUrl: body.metadataUrl === undefined ? stored : '', source: 'unchanged' };
  }

  private assertMetadataUrl(target: URL): void {
    const insecure = this.deps.context().allowInsecureIdp && target.protocol === 'http:';
    if (target.protocol !== 'https:' && !insecure) {
      throw new ApiError(400, 'saml_metadata_url_insecure', 'The metadata URL must start with https://.');
    }
    if (target.username || target.password) {
      throw new ApiError(
        400,
        'saml_metadata_url_invalid',
        "The metadata URL can't hold a user name or password.",
      );
    }
  }

  /**
   * GET of a metadata URL through `ctx.http` (the SSRF guard on every connection). Redirects are followed by
   * hand, at most 3, each one checked again (https only); 1 MB at most. TLS is always verified (n8n's switch
   * to skip it is not offered): the metadata carries the signing certificate (deviation from n8n on purpose).
   */
  private async fetchMetadata(url: string): Promise<string> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new ApiError(400, 'saml_metadata_url_invalid', "The metadata URL isn't a valid URL.");
    }
    for (let hop = 0; hop <= MAX_METADATA_REDIRECTS; hop++) {
      this.assertMetadataUrl(target);
      let response: { body: unknown; headers: Record<string, string>; statusCode: number };
      try {
        response = (await this.deps.context().http.request<unknown>({
          url: target.toString(),
          method: 'GET',
          headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
          responseType: 'text',
          returnFullResponse: true,
          followRedirects: false,
          ignoreHttpStatusErrors: true,
          timeout: METADATA_FETCH_TIMEOUT_MS,
        })) as { body: unknown; headers: Record<string, string>; statusCode: number };
      } catch {
        throw new ApiError(
          400,
          'saml_metadata_fetch_failed',
          "Couldn't read the identity provider's metadata from the URL.",
        );
      }
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        try {
          target = new URL(location, target);
        } catch {
          break;
        }
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300 || typeof response.body !== 'string') break;
      if (Buffer.byteLength(response.body, 'utf8') > SAML_MAX_BYTES) {
        throw new ApiError(400, 'saml_too_large', 'The SAML document is larger than 1 MB.');
      }
      return response.body;
    }
    throw new ApiError(
      400,
      'saml_metadata_fetch_failed',
      "Couldn't read the identity provider's metadata from the URL.",
    );
  }

  /** the sign-in request: a redirect to the IdP, or the POST page with its own CSP */
  private loginRequest(
    entities: SamlEntities,
    binding: 'redirect' | 'post',
    relayState: string | undefined,
  ): { redirect?: string; html?: string; csp?: string } {
    const options = relayState ? { relayState } : {};
    const hasPost = typeof entities.idp.entityMeta.getSingleSignOnService('post') === 'string';
    if (binding === 'post' && hasPost) {
      const request = entities.sp.createLoginRequest(entities.idp, 'post', options) as {
        context: string;
        entityEndpoint: string;
        relayState?: string;
      };
      this.assertIdpAddress(request.entityEndpoint);
      const nonce = randomBytes(16).toString('base64');
      const fields: Record<string, string> = { SAMLRequest: request.context };
      if (relayState) fields.RelayState = relayState;
      return {
        html: samlPostPage({ action: request.entityEndpoint, fields, nonce }),
        csp: samlPostCsp(request.entityEndpoint, nonce),
      };
    }
    const request = entities.sp.createLoginRequest(entities.idp, 'redirect', options);
    this.assertIdpAddress(request.context);
    return { redirect: request.context };
  }

  /** the identity provider's sign-in address: https (http only for the test fakes) */
  private assertIdpAddress(address: string): void {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new SamlRefusal('saml_config_invalid', 'sso_address');
    }
    const insecure = this.deps.context().allowInsecureIdp && url.protocol === 'http:';
    if (url.protocol !== 'https:' && !insecure) throw new SamlRefusal('saml_config_invalid', 'sso_address');
  }

  /**
   * Verifies a response: DOCTYPE and size before any parse, then samlify (schema, signatures with the
   * metadata's certificates only, wrapping, issuer, audience, recipient, times, replay), then our own checks:
   * exactly one plain assertion and it is signed, the issuer, the audience and the destination are this
   * workspace's.
   */
  private async verify(
    entities: SamlEntities,
    slug: string,
    binding: 'redirect' | 'post',
    message: DataObject,
  ): Promise<Record<string, unknown>> {
    const { sp, idp } = entities;
    let xml: string;
    try {
      xml =
        binding === 'post'
          ? decodePostMessage(message.SAMLResponse)
          : decodeRedirectMessage(message.SAMLResponse);
    } catch (error) {
      throw new SamlRefusal('saml_response_invalid', error instanceof ApiError ? error.code : 'decode');
    }
    let extract: Record<string, unknown>;
    try {
      const request =
        binding === 'post'
          ? {
              body: {
                SAMLResponse: message.SAMLResponse,
                ...(typeof message.RelayState === 'string' ? { RelayState: message.RelayState } : {}),
              },
            }
          : {
              query: {
                SAMLResponse: message.SAMLResponse,
                ...(typeof message.RelayState === 'string' ? { RelayState: message.RelayState } : {}),
                SigAlg: message.SigAlg,
                Signature: message.Signature,
              },
              octetString: typeof message.octetString === 'string' ? message.octetString : undefined,
            };
      const result = await sp.parseLoginResponse(idp, binding, request);
      extract = (result.extract ?? {}) as Record<string, unknown>;
    } catch (error) {
      const code = samlifyCode(error);
      throw new SamlRefusal(
        code === 'ERR_REPLAYED_ASSERTION' ? 'saml_response_replayed' : 'saml_response_invalid',
        code,
      );
    }
    this.assertShape(xml, idp, binding);
    const { entityId, acsUrl } = this.urls(slug);
    const issuers = ([] as unknown[]).concat(extract.issuer ?? []);
    if (!issuers.length || issuers.some((issuer) => issuer !== idp.entityMeta.getEntityID())) {
      throw new SamlRefusal('saml_response_invalid', 'ERR_UNMATCH_ISSUER');
    }
    const audiences = ([] as unknown[]).concat(extract.audience ?? []);
    if (!audiences.includes(entityId))
      throw new SamlRefusal('saml_response_invalid', 'ERR_AUDIENCE_MISMATCH');
    const destination = (extract.response as { destination?: unknown } | undefined)?.destination;
    if (destination !== acsUrl) throw new SamlRefusal('saml_response_invalid', 'ERR_DESTINATION_MISMATCH');
    return extract;
  }

  /** one plain assertion, signed itself (wantAssertionsSigned), on either binding */
  private assertShape(xml: string, idp: IdentityProviderInstance, binding: 'redirect' | 'post'): void {
    const found = samlify.Extractor.extract(xml, [
      { key: 'assertion', localPath: ['Response', 'Assertion'], attributes: [], context: true },
      { key: 'encrypted', localPath: ['Response', 'EncryptedAssertion'], attributes: [], context: true },
      { key: 'signature', localPath: ['Response', 'Assertion', 'Signature'], attributes: [], context: true },
    ]) as Record<string, unknown>;
    if (typeof found.assertion !== 'string' || found.encrypted) {
      throw new SamlRefusal('saml_response_invalid', 'ERR_ASSERTION_COUNT');
    }
    if (typeof found.signature !== 'string')
      throw new SamlRefusal('saml_response_invalid', 'ERR_ASSERTION_UNSIGNED');
    if (binding === 'redirect') {
      // samlify checks the query signature on this binding; the assertion's own signature is checked here
      let verified = false;
      try {
        const [ok, assertion] = samlify.SamlLib.verifySignature(xml, {
          metadata: idp.entityMeta,
          allowedSignatureAlgorithms: SIGNATURE_ALGORITHMS,
        });
        verified = ok && typeof assertion === 'string';
      } catch {
        verified = false;
      }
      if (!verified) throw new SamlRefusal('saml_response_invalid', 'ERR_ASSERTION_SIGNATURE');
    }
  }

  /** the person the response names, by the workspace's mapping; missing attributes are refused by name */
  private profile(extract: Record<string, unknown>, section: Pick<SamlSection, 'mapping'>): SsoProfile {
    const attributes = (
      extract.attributes && typeof extract.attributes === 'object' ? extract.attributes : {}
    ) as Record<string, unknown>;
    const { mapping } = section;
    const email = firstValue(attributes[mapping.email]);
    const userPrincipalName = firstValue(attributes[mapping.userPrincipalName]);
    const missing = [
      ...(email ? [] : [mapping.email]),
      ...(userPrincipalName ? [] : [mapping.userPrincipalName]),
    ];
    if (missing.length) {
      throw new SamlRefusal(
        'saml_attributes_missing',
        'missing_attributes',
        `The identity provider's SAML response is missing these attributes: ${missing.join(', ')}.`,
        missing,
        attributes,
      );
    }
    const firstName = firstValue(attributes[mapping.firstName]);
    const lastName = firstValue(attributes[mapping.lastName]);
    const emailVerified = boolAttribute(attributes.email_verified ?? attributes.emailVerified);
    return {
      providerType: 'saml',
      providerId: userPrincipalName,
      email,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(emailVerified === undefined ? {} : { emailVerified }),
      claims: {
        ...attributes,
        nameID: typeof extract.nameID === 'string' ? extract.nameID : null,
      } as DataObject,
    };
  }

  /** the ACS of a test: verify and map with the test's settings, render the result, no session */
  private async testAcs(
    tenant: TenantRow,
    token: string,
    binding: 'redirect' | 'post',
    message: DataObject,
  ): Promise<string> {
    const record = token ? await this.readTest(token) : undefined;
    if (!record || record.tenantId !== tenant.id) {
      return samlTestResultPage({ ok: false, message: 'The SAML test has expired. Start it again.' });
    }
    let outcome: SamlTestOutcome;
    try {
      const idp = await this.identityProvider(record.metadata);
      const extract = await this.verify(
        { sp: this.serviceProvider(tenant.slug), idp },
        tenant.slug,
        binding,
        message,
      );
      const profile = this.profile(extract, record);
      const attributes = (extract.attributes ?? {}) as Record<string, unknown>;
      outcome = {
        ok: true,
        mapped: {
          email: profile.email,
          firstName: profile.firstName ?? '',
          lastName: profile.lastName ?? '',
          userPrincipalName: profile.providerId,
        },
        attributes,
      };
    } catch (error) {
      outcome = {
        ok: false,
        message:
          error instanceof ApiError
            ? error.message
            : "The identity provider's SAML response couldn't be verified.",
        ...(error instanceof SamlRefusal && error.missing ? { missing: error.missing } : {}),
        ...(error instanceof SamlRefusal && error.attributes ? { attributes: error.attributes } : {}),
      };
    }
    return samlTestResultPage(outcome);
  }

  // -------------------------------------------------------------------------------------------
  // short-lived store: Redis, or memory without it (the shape of services/form-auth.ts keep and take)

  private storeKey(kind: 'assertion' | 'test', id: string): string {
    return `${this.deps.config.queue.prefix}:saml:${kind}:${sha256(id)}`;
  }

  private testKey(token: string): string {
    return this.storeKey('test', token);
  }

  private pruneMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) if (entry.expires <= now) this.memory.delete(key);
  }

  private async keep(key: string, value: string, ttlMs: number): Promise<void> {
    const { redis } = this.deps.context();
    if (redis) {
      await redis.set(key, value, 'PX', ttlMs);
      return;
    }
    this.pruneMemory();
    this.memory.set(key, { value, expires: Date.now() + ttlMs });
  }

  private async readTest(token: string): Promise<SamlTestRecord | undefined> {
    const key = this.testKey(token);
    const { redis } = this.deps.context();
    let raw: string | null | undefined;
    if (redis) raw = await redis.get(key);
    else {
      const entry = this.memory.get(key);
      raw = entry && entry.expires > Date.now() ? entry.value : undefined;
    }
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SamlTestRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * the replay guard (decisions Q-A6): one `SET NX` of the assertion (issuer and id, as samlify keys it) until
   * its NotOnOrAfter; true when it was not seen before. Redis down fails closed (the error refuses the sign-in).
   */
  private async saveIfAbsent(id: string, expiresAt: Date): Promise<boolean> {
    const key = this.storeKey('assertion', id);
    const ttl = Math.max(1000, expiresAt.getTime() - Date.now());
    const { redis } = this.deps.context();
    if (redis) return (await redis.set(key, '1', 'PX', ttl, 'NX')) === 'OK';
    this.pruneMemory();
    const seen = this.memory.get(key);
    if (seen && seen.expires > Date.now()) return false;
    this.memory.set(key, { value: '1', expires: Date.now() + ttl });
    return true;
  }
}
