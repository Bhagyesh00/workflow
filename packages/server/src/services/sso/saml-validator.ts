/**
 * P6-09 (L7): the checks a SAML message or an identity provider's metadata passes before anything parses it.
 * Any DOCTYPE (and with it every entity declaration) is refused on the raw text, so no parser ever sees one;
 * a message or metadata over 1 MB is refused, and a deflated redirect-binding message is inflated with the
 * same cap. Then the XML is validated against the public OASIS and W3C schemas in `./xsd` (xmllint-wasm: no
 * network, no file system beyond the schemas we hand it). `installSamlSchemaValidator` gives samlify this
 * check (`setSchemaValidator`), which samlify runs on every message before it reads it.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import type { IdentityProviderInstance } from 'samlify';
import { validateXML, type XMLFileInfo } from 'xmllint-wasm';
import { ApiError } from '../../http/errors';

// samlify is CommonJS and exports `SamlLib` through a getter Node's ESM loader does not see
const samlify: typeof import('samlify') = createRequire(import.meta.url)('samlify');

/** the largest SAML message or metadata document read, decoded (decisions "Security, final") */
export const SAML_MAX_BYTES = 1_048_576;
/** a base64 text of SAML_MAX_BYTES bytes, with room for line breaks */
const MAX_ENCODED_LENGTH = Math.ceil((SAML_MAX_BYTES * 4) / 3) + 4096;

/** the codes of a refused SAML document */
export type SamlXmlErrorCode = 'saml_doctype_refused' | 'saml_too_large' | 'saml_xml_invalid';

const XML_TEXTS: Readonly<Record<SamlXmlErrorCode, string>> = {
  saml_doctype_refused: 'The SAML document holds a DOCTYPE declaration, which is refused.',
  saml_too_large: 'The SAML document is larger than 1 MB.',
  saml_xml_invalid: "The SAML document doesn't match the SAML 2.0 schema.",
};

export function samlXmlError(code: SamlXmlErrorCode): ApiError {
  return new ApiError(400, code, XML_TEXTS[code]);
}

/** `<!DOCTYPE` or `<!ENTITY` in any case, anywhere: refused before a parser sees the text */
const DECLARATION = /<!\s*(?:doctype|entity)/i;

/** refuses a DOCTYPE or entity declaration and a document over 1 MB; runs on the raw text */
export function assertPlainXml(xml: string): void {
  if (Buffer.byteLength(xml, 'utf8') > SAML_MAX_BYTES) throw samlXmlError('saml_too_large');
  if (DECLARATION.test(xml)) throw samlXmlError('saml_doctype_refused');
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value) throw samlXmlError('saml_xml_invalid');
  if (value.length > MAX_ENCODED_LENGTH) throw samlXmlError('saml_too_large');
  return Buffer.from(value, 'base64');
}

/** the XML of a POST-binding message (`SAMLResponse` form field, base64) */
export function decodePostMessage(value: unknown): string {
  const xml = decodeBase64(value).toString('utf8');
  assertPlainXml(xml);
  return xml;
}

/** the XML of a redirect-binding message (`SAMLResponse` query value, base64 of raw DEFLATE) */
export function decodeRedirectMessage(value: unknown): string {
  const raw = decodeBase64(value);
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(raw, { maxOutputLength: SAML_MAX_BYTES });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw samlXmlError('saml_too_large');
    }
    throw samlXmlError('saml_xml_invalid');
  }
  const xml = inflated.toString('utf8');
  assertPlainXml(xml);
  return xml;
}

// ---------------------------------------------------------------------------------------------
// XSD validation

const SCHEMA_DIR = new URL('./xsd/', import.meta.url);
const SCHEMA_FILES = [
  'saml-schema-protocol-2.0.xsd',
  'saml-schema-assertion-2.0.xsd',
  'saml-schema-metadata-2.0.xsd',
  'xmldsig-core-schema.xsd',
  'xenc-schema.xsd',
  'xml.xsd',
] as const;
type SchemaFile = (typeof SCHEMA_FILES)[number];

let schemas: Promise<Map<SchemaFile, XMLFileInfo>> | undefined;

function loadSchemas(): Promise<Map<SchemaFile, XMLFileInfo>> {
  schemas ??= Promise.all(
    SCHEMA_FILES.map(
      async (fileName) =>
        [fileName, { fileName, contents: await readFile(new URL(fileName, SCHEMA_DIR), 'utf8') }] as const,
    ),
  ).then((entries) => new Map(entries));
  return schemas;
}

/** which document a text is: a protocol message (response, request) or an entity's metadata */
export type SamlSchemaKind = 'protocol' | 'metadata';

const ROOT_SCHEMA: Readonly<Record<SamlSchemaKind, SchemaFile>> = {
  protocol: 'saml-schema-protocol-2.0.xsd',
  metadata: 'saml-schema-metadata-2.0.xsd',
};

/** true when `xml` is valid against the SAML 2.0 schema of its kind; never throws for an invalid document */
export async function isSchemaValid(xml: string, kind: SamlSchemaKind): Promise<boolean> {
  assertPlainXml(xml);
  const files = await loadSchemas();
  const root = ROOT_SCHEMA[kind];
  const schema = files.get(root);
  if (!schema) return false;
  try {
    const result = await validateXML({
      xml: [{ fileName: 'document.xml', contents: xml }],
      schema: [schema],
      preload: [...files.values()].filter((file) => file.fileName !== root),
      extension: 'schema',
    });
    return result.valid;
  } catch {
    return false;
  }
}

/** refuses `xml` unless it is valid against the SAML 2.0 schema of its kind */
export async function assertSchemaValid(xml: string, kind: SamlSchemaKind): Promise<void> {
  if (!(await isSchemaValid(xml, kind))) throw samlXmlError('saml_xml_invalid');
}

let installed = false;

/**
 * gives samlify the DOCTYPE, size and schema check; samlify runs it on every message it parses and refuses
 * the message when it rejects (samlify refuses every message while no validator is set)
 */
export function installSamlSchemaValidator(): void {
  if (installed) return;
  installed = true;
  samlify.setSchemaValidator({
    validate: async (xml: string) => {
      await assertSchemaValid(xml, 'protocol');
      return 'SUCCESS_VALIDATE_XML';
    },
  });
}

// ---------------------------------------------------------------------------------------------
// identity provider metadata

/** the binding n8n requires an identity provider to publish (saml-validator.ts:32-37) */
const REDIRECT_BINDING = samlify.Constants.namespace.binding.redirect;

function metadataError(message: string): ApiError {
  return new ApiError(400, 'saml_metadata_invalid', message);
}

function hasLocation(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Checks an identity provider's metadata (pasted, fetched or stored): no DOCTYPE, at most 1 MB, valid against
 * the metadata schema, one entity id, a signing certificate and a single sign-on address with the redirect
 * binding. Answers the identity provider samlify reads from it.
 */
export async function validateIdpMetadata(xml: string): Promise<IdentityProviderInstance> {
  if (typeof xml !== 'string' || !xml.trim())
    throw metadataError("The identity provider's metadata is empty.");
  assertPlainXml(xml);
  if (!(await isSchemaValid(xml, 'metadata'))) {
    throw metadataError("The identity provider's metadata doesn't match the SAML 2.0 metadata schema.");
  }
  let idp: IdentityProviderInstance;
  try {
    idp = samlify.IdentityProvider({ metadata: xml });
  } catch {
    throw metadataError("Couldn't read the identity provider's metadata.");
  }
  const entityId = idp.entityMeta.getEntityID();
  if (typeof entityId !== 'string' || !entityId.trim()) {
    throw metadataError("The identity provider's metadata has no entity ID.");
  }
  const certificate = idp.entityMeta.getX509Certificate('signing');
  const certificates = (Array.isArray(certificate) ? certificate : [certificate]).filter(
    (value) => typeof value === 'string' && value.trim(),
  );
  if (!certificates.length) {
    throw metadataError("The identity provider's metadata has no signing certificate.");
  }
  if (!hasLocation(idp.entityMeta.getSingleSignOnService('redirect'))) {
    throw metadataError(
      `The identity provider's metadata has no single sign-on address with the binding ${REDIRECT_BINDING}.`,
    );
  }
  return idp;
}
