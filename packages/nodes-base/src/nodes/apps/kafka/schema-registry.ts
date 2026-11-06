/**
 * Confluent Schema Registry on a guarded agent: the host passes the SSRF guard before the client exists
 * (an address literal never reaches a lookup) and on every connection after that. The client follows
 * no redirects.
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { type DataObject, type NodeHelpers, NodeOperationError, type WorkflowNode } from '@workflow/workflow';

const MAX_ERROR_LENGTH = 500;
const REGISTRY_RETRIES = 2;

interface SchemaRegistryCredentials extends DataObject {
  url?: string;
  authentication?: string;
  username?: string;
  password?: string;
}

export interface KafkaSchemaRegistry {
  decode(value: Buffer): Promise<unknown>;
  /** the wire format of the latest schema registered for `subject` */
  encode(subject: string, payload: unknown): Promise<Buffer>;
  close(): void;
}

interface RegistryContext {
  getNode(): WorkflowNode;
  getCredentials<T extends DataObject = DataObject>(type: string): Promise<T>;
  helpers: Pick<NodeHelpers, 'resolveAllowedHost'>;
}

/** an error of the registry client can name its URL and repeat the answer: safe for a log */
export function scrubRegistryError(error: unknown): string {
  // greedy up to the last @, so a password that holds an @ goes as a whole
  const message = String((error as Error)?.message ?? error).replace(/\/\/[^/\s]+@/g, '//***@');
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}

async function registrySettings(ctx: RegistryContext, fallbackUrl: string) {
  const emptyConfig = () =>
    new NodeOperationError(
      ctx.getNode(),
      'Select a Schema Registry credential or enter a Schema Registry URL',
    );
  if (!ctx.getNode().credentials?.schemaRegistryApi) {
    const url = fallbackUrl.trim();
    if (!url) throw emptyConfig();
    return { url };
  }
  const credentials = await ctx.getCredentials<SchemaRegistryCredentials>('schemaRegistryApi');
  const url = credentials.url?.trim();
  if (!url) throw emptyConfig();
  if (credentials.authentication !== 'basicAuth') return { url };
  const { username, password } = credentials;
  if (!(username && password)) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Username and password are required for Schema Registry Basic Auth',
    );
  }
  return { url, auth: { username, password } };
}

export async function openSchemaRegistry(
  ctx: RegistryContext,
  fallbackUrl: string,
): Promise<KafkaSchemaRegistry> {
  const settings = await registrySettings(ctx, fallbackUrl);
  const badConfig = (description: string) =>
    new NodeOperationError(ctx.getNode(), 'Verify your Schema Registry configuration', { description });

  let parsed: URL;
  try {
    parsed = new URL(settings.url);
  } catch {
    throw badConfig('The Schema Registry URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badConfig('The Schema Registry URL must use http or https');
  }

  // sign-in details never stay in the URL, where an error of the client would repeat them
  const auth =
    settings.auth ??
    (parsed.username
      ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
      : undefined);
  parsed.username = '';
  parsed.password = '';

  await ctx.helpers.resolveAllowedHost(parsed.hostname.replace(/^\[|\]$/g, ''));

  const lookup = ((hostname, options, callback) => {
    ctx.helpers.resolveAllowedHost(hostname).then(
      (allowed) => allowed.lookup(hostname, options as { all?: boolean }, callback as never),
      (error: NodeJS.ErrnoException) => callback(error, '', 0),
    );
  }) as LookupFunction;
  const agent = parsed.protocol === 'https:' ? new https.Agent({ lookup }) : new http.Agent({ lookup });

  const { SchemaRegistry } = await import('@kafkajs/confluent-schema-registry');
  const registry = new SchemaRegistry({
    host: parsed.href,
    auth,
    agent,
    retry: { retries: REGISTRY_RETRIES },
  });
  return {
    decode: (value) => registry.decode(value),
    encode: async (subject, payload) => registry.encode(await registry.getLatestSchemaId(subject), payload),
    close: () => agent.destroy(),
  };
}
