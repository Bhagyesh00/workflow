/**
 * Vendor requests. Every call goes through the guarded client: `vendorRequest` with the node's credential
 * (so the credential's allowed domains apply), `downloadMedia` with the credential only on the vendor's
 * own host. Errors never carry a key or a token.
 */
import {
  type ExecuteContext,
  type HttpFullResponse,
  type HttpRequestOptions,
  NodeApiError,
  NodeOperationError,
} from '@workflow/workflow';
import { errorMessage, redactSecrets } from '../../../shared/utils';

/**
 * One request with the credential of `credentialType` applied (`httpRequestWithAuthentication` at
 * `itemIndex`); a failure becomes a `vendorError` with secrets redacted.
 */
export async function vendorRequest<T>(
  ctx: ExecuteContext,
  credentialType: string,
  itemIndex: number,
  request: HttpRequestOptions,
): Promise<T> {
  try {
    return (await ctx.helpers.httpRequestWithAuthentication<T>(credentialType, request, itemIndex)) as T;
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }
}

/** the vendor's error code in a response body: OpenAI `error.code`, Anthropic `error.type`, or `code` */
function bodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, any>;
  const candidates = [b.error?.code, b.error?.type, b.code, b.error?.status];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return typeof b.error === 'string' ? b.error : undefined;
}

/**
 * A node error for a failed vendor call: the vendor's message with secrets redacted (`redactSecrets`),
 * or a fixed text from `texts` keyed by the vendor's error code (OpenAI's `insufficient_quota`).
 */
export function vendorError(
  ctx: ExecuteContext,
  error: unknown,
  itemIndex: number,
  texts?: Record<string, string>,
): Error {
  // a stop the user asked for stays what it is
  if (error instanceof Error && (error.name === 'AbortError' || ctx.signal?.aborted)) return error;
  const node = ctx.getNode();
  const api = error instanceof NodeApiError ? error : undefined;
  const code = bodyCode(api?.responseBody);
  const fixed = code && texts && Object.hasOwn(texts, code) ? texts[code] : undefined;
  const message = fixed ?? redactSecrets(errorMessage(error));
  const rawDescription = error instanceof NodeOperationError ? error.description : undefined;
  const description = rawDescription ? redactSecrets(rawDescription) : undefined;
  // the cause and the response body are dropped on purpose: either can echo a request header or a key
  if (api) {
    return new NodeApiError(node, message, { httpCode: api.httpCode, description, itemIndex });
  }
  return new NodeOperationError(node, message, { description, itemIndex });
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body === undefined || body === null) return new Uint8Array(0);
  return new TextEncoder().encode(JSON.stringify(body));
}

function mimeOf(headers: Record<string, string> | undefined): string | undefined {
  const type = headers?.['content-type']?.split(';')[0]?.trim().toLowerCase();
  return type || undefined;
}

function parseHttpUrl(ctx: ExecuteContext, itemIndex: number, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NodeOperationError(ctx.getNode(), 'The media link is not a valid URL', { itemIndex });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new NodeOperationError(ctx.getNode(), 'The media link must start with http:// or https://', {
      itemIndex,
    });
  }
  return url;
}

/**
 * Download a generated file. The credential goes only when the link is `https:` and
 * `new URL(url).hostname === authHost`, on a hop that never follows a redirect (a 3xx is fetched again
 * with plain `httpRequest`); any other link gets a plain guarded `httpRequest` with no credential.
 * `maxBytes` is checked after the body has been read: the client's own response cap (100 MB) is what
 * bounds the download.
 */
export async function downloadMedia(
  ctx: ExecuteContext,
  itemIndex: number,
  url: string,
  options?: { credentialType?: string; authHost?: string; maxBytes?: number },
): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const target = parseHttpUrl(ctx, itemIndex, url);
  const plain = (to: URL) =>
    ctx.helpers.httpRequest<unknown>({
      url: to.toString(),
      method: 'GET',
      responseType: 'arraybuffer',
      returnFullResponse: true,
    }) as Promise<HttpFullResponse<unknown>>;

  let response: HttpFullResponse<unknown>;
  try {
    if (
      options?.credentialType &&
      options.authHost &&
      target.protocol === 'https:' &&
      target.hostname === options.authHost.toLowerCase()
    ) {
      // the credential's hop never follows a redirect: the next host must not see the key
      response = (await ctx.helpers.httpRequestWithAuthentication<unknown>(
        options.credentialType,
        {
          url: target.toString(),
          method: 'GET',
          responseType: 'arraybuffer',
          returnFullResponse: true,
          followRedirects: false,
          ignoreHttpStatusErrors: true,
        },
        itemIndex,
      )) as HttpFullResponse<unknown>;
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        const location = response.headers?.location;
        if (!location) {
          throw new NodeOperationError(ctx.getNode(), 'The media link redirected without a location', {
            itemIndex,
          });
        }
        response = await plain(parseHttpUrl(ctx, itemIndex, new URL(location, target).toString()));
      } else if (status < 200 || status >= 300) {
        throw new NodeApiError(ctx.getNode(), `The media download failed with status ${status}`, {
          httpCode: status,
          itemIndex,
        });
      }
    } else {
      response = await plain(target);
    }
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }

  const bytes = toBytes(response.body);
  if (options?.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
    throw new NodeOperationError(
      ctx.getNode(),
      `The downloaded file is ${bytes.byteLength} bytes, which exceeds the limit of ${options.maxBytes} bytes`,
      { itemIndex },
    );
  }
  return { bytes, mimeType: mimeOf(response.headers) };
}
