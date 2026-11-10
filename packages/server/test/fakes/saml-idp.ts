/**
 * P6-09 (L7): a SAML identity provider for tests, in-process. samlify in its IdP role writes the metadata and
 * signs with the local key and certificate in test/fixtures; the responses are built here so a test can bend
 * each part (issuer, audience, destination, times, attributes, which parts are signed, the key, a DOCTYPE, a
 * wrapped assertion). A `node:http` server on 127.0.0.1 serves the metadata (for the metadata URL tests) and
 * a redirect. No network beyond 127.0.0.1, no real identity provider.
 */

import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { IdentityProviderInstance } from 'samlify';

// samlify is CommonJS and exports `SamlLib` through a getter Node's ESM loader does not see
const samlify: typeof import('samlify') = createRequire(import.meta.url)('samlify');

export const SAML_IDP_KEY = readFileSync(new URL('../fixtures/saml-idp.key', import.meta.url), 'utf8');
export const SAML_IDP_CERT = readFileSync(new URL('../fixtures/saml-idp.crt', import.meta.url), 'utf8');
/** the certificate as metadata and KeyInfo carry it: base64 without the PEM lines */
const CERT_BODY = SAML_IDP_CERT.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

/** n8n's default claim URIs (the SAML attribute names a workspace maps by default) */
export const SAML_CLAIMS = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/firstname',
  lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/lastname',
  userPrincipalName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
} as const;

const RSA_SHA256 = samlify.Constants.algorithms.signature.RSA_SHA256;
const BINDING = samlify.Constants.namespace.binding;
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

/** a key that is not the one the metadata names (the wrong certificate test) */
export function strangerKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
}

export interface SamlTestUser {
  email?: string;
  firstName?: string;
  lastName?: string;
  /** the user principal name attribute; defaults to the email */
  upn?: string;
  /** the NameID; defaults to the email */
  nameId?: string;
  /** more attributes, by name */
  attributes?: Record<string, string | string[]>;
  /** leave out these mapped attributes (`email`, `firstName`, `lastName`, `userPrincipalName`) */
  omit?: Array<keyof typeof SAML_CLAIMS>;
}

/** the service provider a response is for (our metadata URL and ACS of one workspace) */
export interface SamlTarget {
  entityId: string;
  acsUrl: string;
}

export interface SamlResponseOptions {
  sp: SamlTarget;
  user: SamlTestUser;
  inResponseTo?: string;
  issuer?: string;
  audience?: string;
  destination?: string;
  recipient?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  assertionId?: string;
  /** default true */
  signAssertion?: boolean;
  /** default true (POST binding); the redirect binding signs the query instead */
  signMessage?: boolean;
  /** sign with this key instead of the fixture key */
  privateKey?: string;
  /** sign only the assertion with this key (the message keeps `privateKey`); the metadata certificate stays in KeyInfo */
  assertionKey?: string;
  /** changes the signed XML (a tampered response) */
  tamper?: (xml: string) => string;
  /** text put before the root element (a DOCTYPE) */
  prolog?: string;
  /** moves the signed response inside an unsigned one with another email (signature wrapping) */
  wrapWithEmail?: string;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function newId(): string {
  return `_${randomBytes(16).toString('hex')}`;
}

function attributeXml(name: string, values: string | string[]): string {
  const list = (Array.isArray(values) ? values : [values])
    .map((value) => `<saml:AttributeValue xsi:type="xs:string">${esc(value)}</saml:AttributeValue>`)
    .join('');
  return `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri">${list}</saml:Attribute>`;
}

function mappedAttributes(user: SamlTestUser): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const omit = new Set(user.omit ?? []);
  const values: Record<keyof typeof SAML_CLAIMS, string | undefined> = {
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    userPrincipalName: user.upn ?? user.email,
  };
  for (const key of Object.keys(SAML_CLAIMS) as Array<keyof typeof SAML_CLAIMS>) {
    const value = values[key];
    if (value !== undefined && !omit.has(key)) out[SAML_CLAIMS[key]] = value;
  }
  return { ...out, ...(user.attributes ?? {}) };
}

export class FakeSamlIdp {
  readonly entityId: string;
  readonly ssoUrl: string;
  /** what GET /metadata answers (a test may replace it) */
  metadataXml: string;
  /** awaited once before the next GET /metadata answers (a test makes a save land during the read) */
  beforeMetadata?: () => Promise<unknown>;
  /** where GET /moved sends the caller (302) */
  movedTo = '';
  /** requests the server saw, by path */
  readonly hits: string[] = [];
  private readonly idp: IdentityProviderInstance;

  private constructor(
    private readonly server: Server,
    readonly baseUrl: string,
  ) {
    this.entityId = `${baseUrl}/entity`;
    this.ssoUrl = `${baseUrl}/sso`;
    this.idp = samlify.IdentityProvider({
      entityID: this.entityId,
      privateKey: SAML_IDP_KEY,
      signingCert: SAML_IDP_CERT,
      nameIDFormat: [EMAIL_FORMAT],
      singleSignOnService: [
        { Binding: BINDING.redirect, Location: this.ssoUrl },
        { Binding: BINDING.post, Location: this.ssoUrl },
      ],
    });
    this.metadataXml = this.metadata();
  }

  /** a fake on 127.0.0.1 (ephemeral port); `host` names the base URL (default 127.0.0.1) */
  static async start(host = '127.0.0.1'): Promise<FakeSamlIdp> {
    let fake: FakeSamlIdp | undefined;
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      fake?.hits.push(path);
      if (path === '/metadata') {
        const before = fake?.beforeMetadata;
        if (fake) fake.beforeMetadata = undefined;
        void (before ? before().catch(() => undefined) : Promise.resolve()).then(() => {
          res.writeHead(200, { 'content-type': 'application/samlmetadata+xml' });
          res.end(fake?.metadataXml ?? '');
        });
        return;
      }
      if (path === '/moved') {
        res.writeHead(302, { location: fake?.movedTo ?? '/' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    fake = new FakeSamlIdp(server, `http://${host}:${port}`);
    return fake;
  }

  /** the identity provider's metadata, as samlify writes it (redirect and POST single sign-on) */
  metadata(): string {
    return this.idp.getMetadata();
  }

  /** the metadata of an identity provider with only a POST single sign-on address */
  metadataWithoutRedirect(): string {
    return samlify
      .IdentityProvider({
        entityID: this.entityId,
        signingCert: SAML_IDP_CERT,
        singleSignOnService: [{ Binding: BINDING.post, Location: this.ssoUrl }],
      })
      .getMetadata();
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** the AuthnRequest a redirect-binding sign-in URL carries */
  readRedirectRequest(url: string): {
    id: string;
    acsUrl?: string;
    relayState?: string;
    destination: string;
  } {
    const target = new URL(url);
    const encoded = target.searchParams.get('SAMLRequest') ?? '';
    const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
    return {
      ...this.requestFields(xml),
      relayState: target.searchParams.get('RelayState') ?? undefined,
      destination: `${target.origin}${target.pathname}`,
    };
  }

  /** the AuthnRequest a POST-binding page carries (the page's hidden fields) */
  readPostRequest(html: string): { id: string; acsUrl?: string; relayState?: string; action: string } {
    const field = (name: string) =>
      new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, '&');
    const action = /action="([^"]*)"/.exec(html)?.[1] ?? '';
    const xml = Buffer.from(field('SAMLRequest') ?? '', 'base64').toString('utf8');
    return { ...this.requestFields(xml), relayState: field('RelayState'), action };
  }

  private requestFields(xml: string): { id: string; acsUrl?: string } {
    const id = / ID="([^"]+)"/.exec(xml)?.[1];
    if (!id) throw new Error('No AuthnRequest ID');
    return { id, acsUrl: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] };
  }

  /** a signed Response as XML */
  responseXml(options: SamlResponseOptions): string {
    const now = new Date();
    const notBefore = (options.notBefore ?? new Date(now.getTime() - 1000)).toISOString();
    const notOnOrAfter = (options.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString();
    const issuer = esc(options.issuer ?? this.entityId);
    const inResponseTo = options.inResponseTo ? ` InResponseTo="${esc(options.inResponseTo)}"` : '';
    const nameId = options.user.nameId ?? options.user.email ?? 'unknown';
    const attributes = Object.entries(mappedAttributes(options.user))
      .map(([name, values]) => attributeXml(name, values))
      .join('');
    const assertion = [
      `<saml:Assertion xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
      ` ID="${options.assertionId ?? newId()}" Version="2.0" IssueInstant="${now.toISOString()}">`,
      `<saml:Issuer>${issuer}</saml:Issuer>`,
      `<saml:Subject><saml:NameID Format="${EMAIL_FORMAT}">${esc(nameId)}</saml:NameID>`,
      '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">',
      `<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${esc(options.recipient ?? options.sp.acsUrl)}"${inResponseTo}/>`,
      '</saml:SubjectConfirmation></saml:Subject>',
      `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">`,
      `<saml:AudienceRestriction><saml:Audience>${esc(options.audience ?? options.sp.entityId)}</saml:Audience></saml:AudienceRestriction>`,
      '</saml:Conditions>',
      `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${newId()}"><saml:AuthnContext>`,
      '<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>',
      '</saml:AuthnContext></saml:AuthnStatement>',
      attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : '',
      '</saml:Assertion>',
    ].join('');
    let xml = [
      '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"',
      ` ID="${newId()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${esc(options.destination ?? options.sp.acsUrl)}"${inResponseTo}>`,
      `<saml:Issuer>${issuer}</saml:Issuer>`,
      '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>',
      assertion,
      '</samlp:Response>',
    ].join('');
    const key = options.privateKey ?? SAML_IDP_KEY;
    const sign = {
      privateKey: key,
      signatureAlgorithm: RSA_SHA256,
      signingCert: CERT_BODY,
      isBase64Output: false,
    };
    if (options.signAssertion !== false) {
      xml = samlify.SamlLib.constructSAMLSignature({
        ...sign,
        privateKey: options.assertionKey ?? key,
        rawSamlMessage: xml,
        referenceTagXPath: "/*[local-name(.)='Response']/*[local-name(.)='Assertion']",
        signatureConfig: {
          prefix: 'ds',
          location: {
            reference: "/*[local-name(.)='Response']/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
            action: 'after',
          },
        },
      });
    }
    if (options.signMessage !== false) {
      xml = samlify.SamlLib.constructSAMLSignature({
        ...sign,
        rawSamlMessage: xml,
        isMessageSigned: true,
        signatureConfig: {
          prefix: 'ds',
          location: { reference: "/*[local-name(.)='Response']/*[local-name(.)='Issuer']", action: 'after' },
        },
      });
    }
    if (options.wrapWithEmail) xml = this.wrap(xml, options);
    if (options.tamper) xml = options.tamper(xml);
    return `${options.prolog ?? ''}${xml}`;
  }

  /**
   * XML signature wrapping: an unsigned Response with another person's assertion becomes the root, the
   * signed message's signature moves to it, and the signed Response hides inside the new assertion
   */
  private wrap(signed: string, options: SamlResponseOptions): string {
    const start = signed.indexOf('<ds:Signature');
    const end = signed.indexOf('</ds:Signature>', start) + '</ds:Signature>'.length;
    const signature = signed.slice(start, end);
    const original = signed.slice(0, start) + signed.slice(end);
    const evil = this.responseXml({
      ...options,
      wrapWithEmail: undefined,
      signAssertion: false,
      signMessage: false,
      user: {
        ...options.user,
        email: options.wrapWithEmail,
        upn: options.wrapWithEmail,
        nameId: options.wrapWithEmail,
      },
    });
    const withSignature = evil.replace('</saml:Issuer>', `</saml:Issuer>${signature}`);
    return withSignature.replace(
      /(<saml:SubjectConfirmationData [^>]*?)\/>/,
      `$1>${original}</saml:SubjectConfirmationData>`,
    );
  }

  /** the POST-binding form fields */
  postResponse(options: SamlResponseOptions & { relayState?: string }): Record<string, string> {
    const fields: Record<string, string> = {
      SAMLResponse: Buffer.from(this.responseXml(options), 'utf8').toString('base64'),
    };
    if (options.relayState !== undefined) fields.RelayState = options.relayState;
    return fields;
  }

  /**
   * the redirect-binding query (deflated message, the query signed with the key), as the IdP would send the
   * browser to the ACS; the XML message itself is not signed (only the assertion, unless told otherwise)
   */
  redirectResponse(options: SamlResponseOptions & { relayState?: string; signQuery?: boolean }): string {
    const xml = this.responseXml({ ...options, signMessage: options.signMessage ?? false });
    const deflated = deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
    let octet = `SAMLResponse=${encodeURIComponent(deflated)}`;
    if (options.relayState !== undefined) octet += `&RelayState=${encodeURIComponent(options.relayState)}`;
    if (options.signQuery === false) return octet;
    octet += `&SigAlg=${encodeURIComponent(RSA_SHA256)}`;
    const signature = createSign('RSA-SHA256')
      .update(octet)
      .sign(options.privateKey ?? SAML_IDP_KEY, 'base64');
    return `${octet}&Signature=${encodeURIComponent(signature)}`;
  }
}

/** a form body as the browser posts it */
export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
