/**
 * Google Gemini files: the resumable upload (start, then upload and finalize) and the File resource.
 * The upload address is supplied by the server, so every hop never follows a redirect (a 3xx is an
 * error) and the key goes only to the credential's own host.
 */
import {
  type DataObject,
  type ExecuteContext,
  type HttpFullResponse,
  type HttpRequestOptions,
  type Item,
  NodeApiError,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { redactSecrets } from '../../../shared/utils';
import { vendorError } from '../shared/api';
import { readInputFile, type VendorFile } from '../shared/binary';
import { pollUntil } from '../shared/poll';
import {
  GEMINI_CREDENTIAL,
  geminiAuthHost,
  geminiCall,
  geminiHost,
  pollTiming,
  safeResourceName,
} from './operations';

/** a file stored by the Files API */
export interface GeminiFileInfo extends DataObject {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
}

/** the message of a Gemini error body, secrets cut out */
function failureText(response: HttpFullResponse<unknown>): string {
  const body = response.body;
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
  } else if (body instanceof Uint8Array) {
    parsed = undefined;
  }
  const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
  return redactSecrets(
    typeof message === 'string' && message ? message : `The upload failed with status ${response.statusCode}`,
  );
}

function checkStatus(ctx: ExecuteContext, itemIndex: number, response: HttpFullResponse<unknown>): void {
  const status = response.statusCode;
  if (status >= 300 && status < 400) {
    // a redirect would send the upload (and a key) to a host the server picked
    throw new NodeOperationError(ctx.getNode(), 'The upload address redirected, which is not allowed', {
      itemIndex,
    });
  }
  if (status < 200 || status >= 300) {
    throw new NodeApiError(ctx.getNode(), failureText(response), { httpCode: status, itemIndex });
  }
}

function parseJsonBody(body: unknown): DataObject {
  if (body && typeof body === 'object' && !(body instanceof Uint8Array)) return body as DataObject;
  const text =
    typeof body === 'string' ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : '';
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as DataObject) : {};
  } catch {
    throw new Error('The upload reply is not JSON');
  }
}

/**
 * Upload `file` to `path` (for example `/upload/v1beta/files`) in two calls: start the session with the
 * metadata, then send the bytes and finalize on the address the server gave. Returns the reply of the
 * second call.
 */
export async function resumableUpload(
  ctx: ExecuteContext,
  itemIndex: number,
  path: string,
  metadata: DataObject,
  file: VendorFile,
): Promise<DataObject> {
  const host = await geminiHost(ctx, itemIndex);
  let started: HttpFullResponse<unknown>;
  try {
    started = (await ctx.helpers.httpRequestWithAuthentication<unknown>(
      GEMINI_CREDENTIAL,
      {
        url: `${host}${path}`,
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(file.bytes.byteLength),
          'X-Goog-Upload-Header-Content-Type': file.mimeType,
          'Content-Type': 'application/json',
        },
        body: metadata,
        returnFullResponse: true,
        followRedirects: false,
        ignoreHttpStatusErrors: true,
      } satisfies HttpRequestOptions,
      itemIndex,
    )) as HttpFullResponse<unknown>;
    checkStatus(ctx, itemIndex, started);
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }

  const location = started.headers?.['x-goog-upload-url'];
  if (!location) {
    throw new NodeOperationError(ctx.getNode(), 'Gemini did not return an upload address', { itemIndex });
  }
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    throw new NodeOperationError(ctx.getNode(), 'The upload address is not a valid URL', { itemIndex });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new NodeOperationError(ctx.getNode(), 'The upload address must start with http:// or https://', {
      itemIndex,
    });
  }

  const finalize: HttpRequestOptions = {
    url: target.toString(),
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Type': file.mimeType,
    },
    body: file.bytes,
    bodyType: 'raw',
    returnFullResponse: true,
    followRedirects: false,
    ignoreHttpStatusErrors: true,
  };
  let done: HttpFullResponse<unknown>;
  try {
    // the key goes only to the credential's own host; the session address carries its own upload id
    done =
      target.hostname === (await geminiAuthHost(ctx, itemIndex))
        ? ((await ctx.helpers.httpRequestWithAuthentication<unknown>(
            GEMINI_CREDENTIAL,
            finalize,
            itemIndex,
          )) as HttpFullResponse<unknown>)
        : ((await ctx.helpers.httpRequest<unknown>(finalize)) as HttpFullResponse<unknown>);
    checkStatus(ctx, itemIndex, done);
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }
  try {
    return parseJsonBody(done.body);
  } catch (error) {
    throw vendorError(ctx, error, itemIndex);
  }
}

/** upload a file to the Files API and return its record */
export async function uploadFile(
  ctx: ExecuteContext,
  itemIndex: number,
  file: VendorFile,
  displayName?: string,
): Promise<GeminiFileInfo> {
  const reply = await resumableUpload(
    ctx,
    itemIndex,
    '/upload/v1beta/files',
    { file: { display_name: displayName || file.fileName || 'file' } },
    file,
  );
  const info = (reply.file ?? reply) as GeminiFileInfo;
  if (!info.uri) {
    throw new NodeOperationError(ctx.getNode(), 'Gemini did not return the uploaded file', { itemIndex });
  }
  return info;
}

/** wait until an uploaded file is usable (video files are processed first) */
export async function waitForFile(
  ctx: ExecuteContext,
  itemIndex: number,
  info: GeminiFileInfo,
): Promise<GeminiFileInfo> {
  if (!info.state || info.state === 'ACTIVE') return info;
  const name = safeResourceName(info.name, 'file');
  const ready = await pollUntil(
    () => geminiCall<GeminiFileInfo>(ctx, itemIndex, `/v1beta/${name}`),
    (value) => value.state !== 'PROCESSING',
    {
      intervalMs: pollTiming.fileIntervalMs,
      timeoutMs: pollTiming.fileTimeoutMs,
      signal: ctx.signal,
      timeoutText: 'The uploaded file took too long to process',
    },
  );
  if (ready.state === 'FAILED') {
    throw new NodeOperationError(ctx.getNode(), 'Gemini could not process the uploaded file', { itemIndex });
  }
  return ready;
}

const fileDisplay = { show: { resource: ['file'], operation: ['upload'] } };

/** the parameters of the File resource */
export const fileProperties: NodeProperty[] = [
  {
    displayName: 'Input Type',
    name: 'inputType',
    type: 'options',
    default: 'binary',
    displayOptions: fileDisplay,
    options: [
      { name: 'Binary File', value: 'binary' },
      { name: 'URL', value: 'url' },
    ],
  },
  {
    displayName: 'URL',
    name: 'url',
    type: 'string',
    default: '',
    placeholder: 'https://example.com/file.pdf',
    displayOptions: { show: { resource: ['file'], operation: ['upload'], inputType: ['url'] } },
  },
  {
    displayName: 'Input Data Field Name',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    placeholder: 'data',
    description: 'The name of the binary field of the input item that holds the file',
    displayOptions: { show: { resource: ['file'], operation: ['upload'], inputType: ['binary'] } },
  },
  {
    displayName: 'Display Name',
    name: 'displayName',
    type: 'string',
    default: '',
    description: 'The name Gemini shows for the file. Empty uses the file name.',
    displayOptions: fileDisplay,
  },
];

/** File > Upload File */
export async function fileUpload(ctx: ExecuteContext, itemIndex: number): Promise<Item> {
  const file = await readInputFile(ctx, itemIndex, {
    inputType: ctx.getNodeParameter('inputType', itemIndex, 'binary') === 'url' ? 'url' : 'binary',
    url: String(ctx.getNodeParameter('url', itemIndex, '')),
    binaryField: String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data')),
  });
  const info = await uploadFile(
    ctx,
    itemIndex,
    file,
    String(ctx.getNodeParameter('displayName', itemIndex, '')).trim() || undefined,
  );
  return { json: info, pairedItem: { item: itemIndex } };
}
