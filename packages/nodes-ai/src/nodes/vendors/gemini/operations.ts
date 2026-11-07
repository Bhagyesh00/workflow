/**
 * Google Gemini node, shared pieces: the host and the calls on it, model pickers, long-running operations
 * (Veo video, file search imports) and the plain helpers every Gemini operation file uses.
 */
import {
  type DataObject,
  type ExecuteContext,
  type HttpRequestOptions,
  isResourceLocatorValue,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { GEMINI_DEFAULT_HOST } from '../../../providers/gemini';
import { trimSlash } from '../../../shared/chat-model';
import { redactSecrets } from '../../../shared/utils';
import { vendorRequest } from '../shared/api';
import { modelListSearch } from '../shared/model-lists';
import { pollUntil } from '../shared/poll';

export const GEMINI_CREDENTIAL = 'googleGeminiApi';

/** how long and how often the node polls a Gemini job; tests make the interval short */
export const pollTiming = {
  videoIntervalMs: 5000,
  videoTimeoutMs: 10 * 60 * 1000,
  importIntervalMs: 3000,
  importTimeoutMs: 10 * 60 * 1000,
  fileIntervalMs: 2000,
  fileTimeoutMs: 5 * 60 * 1000,
};

/** the credential's host without a trailing slash */
export async function geminiHost(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  const creds = await ctx.getCredentials(GEMINI_CREDENTIAL, itemIndex);
  return trimSlash(String(creds.host || GEMINI_DEFAULT_HOST));
}

/** the host name the key may be sent to */
export async function geminiAuthHost(ctx: ExecuteContext, itemIndex: number): Promise<string> {
  return new URL(await geminiHost(ctx, itemIndex)).hostname;
}

/** one call on the credential's host (`path` starts with a slash), with the key */
export async function geminiCall<T = DataObject>(
  ctx: ExecuteContext,
  itemIndex: number,
  path: string,
  request: Omit<HttpRequestOptions, 'url'> = {},
): Promise<T> {
  const host = await geminiHost(ctx, itemIndex);
  return vendorRequest<T>(ctx, GEMINI_CREDENTIAL, itemIndex, { ...request, url: `${host}${path}` });
}

/** the plain text of a resource locator value or a string */
export function locatorValue(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** the model chosen in the `modelId` parameter, `models/` cut off; `fallback` when empty */
export function readModelId(ctx: ExecuteContext, itemIndex: number, fallback: string): string {
  const chosen = locatorValue(ctx.getNodeParameter('modelId', itemIndex, fallback));
  return (chosen || fallback).replace(/^models\//, '');
}

/** a model id goes into a URL path: only the characters a model id has */
export function modelPath(model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    throw new Error('The model name is not valid');
  }
  return `/v1beta/models/${model}`;
}

/** a model picker: a list from the API (by `searchMethod`) or an id typed in */
export function modelProperty(options: {
  resource: string;
  operations?: string[];
  searchMethod: string;
  defaultModel: string;
}): NodeProperty {
  return {
    displayName: 'Model',
    name: 'modelId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: options.defaultModel },
    required: true,
    displayOptions: {
      show: {
        resource: [options.resource],
        ...(options.operations ? { operation: options.operations } : {}),
      },
    },
    modes: [
      {
        displayName: 'From List',
        name: 'list',
        type: 'list',
        placeholder: 'Select a model...',
        typeOptions: { searchListMethod: options.searchMethod, searchable: true },
      },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: options.defaultModel },
    ],
  };
}

interface ApiModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

async function listApiModels(ctx: LoadOptionsContext): Promise<ApiModel[]> {
  const creds = await ctx.getCredentials(GEMINI_CREDENTIAL);
  const host = trimSlash(String(creds.host || GEMINI_DEFAULT_HOST));
  const response = (await ctx.helpers.httpRequestWithAuthentication(GEMINI_CREDENTIAL, {
    url: `${host}/v1beta/models`,
    qs: { pageSize: 1000 },
  })) as { models?: ApiModel[] };
  return response.models ?? [];
}

/** a `listSearch` over the models that support `method`, ids filtered by `keep` */
function modelsFor(method: string, keep: (id: string) => boolean) {
  return modelListSearch(async (ctx) => {
    const models = await listApiModels(ctx);
    return models
      .filter((m) => m.name && m.supportedGenerationMethods?.includes(method))
      .map((m) => ({ id: m.name!.replace(/^models\//, ''), name: m.displayName }));
  }, keep);
}

const NOT_CHAT = /(image|tts|embedding|aqa|imagen|veo|live|audio)/i;

/** the pickers of the node: text models, image edit, image and video generation */
export const geminiListSearch: Record<
  string,
  (ctx: LoadOptionsContext, filter?: string) => Promise<ListSearchResult>
> = {
  textModels: modelsFor('generateContent', (id) => !NOT_CHAT.test(id)),
  imageEditModels: modelsFor('generateContent', (id) => /image/i.test(id)),
  imageModels: modelsFor('predict', (id) => /imagen/i.test(id)),
  videoModels: modelsFor('predictLongRunning', (id) => /veo/i.test(id)),
};

const OPERATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;

/** a name the server returned, checked before it goes into a URL path */
export function safeResourceName(name: unknown, what: string): string {
  if (typeof name !== 'string' || !OPERATION_NAME.test(name) || name.split('/').includes('..')) {
    throw new Error(`The ${what} name in the reply is not valid`);
  }
  return name;
}

export interface OperationState extends DataObject {
  name?: string;
  done?: boolean;
  error?: { message?: string; code?: number };
  response?: DataObject;
}

/** poll a long-running operation until it is done; a failure inside it throws its message */
export async function waitForOperation(
  ctx: ExecuteContext,
  itemIndex: number,
  started: OperationState,
  timing: { intervalMs: number; timeoutMs: number; timeoutText: string },
): Promise<OperationState> {
  const name = safeResourceName(started.name, 'operation');
  const finished =
    started.done === true
      ? started
      : await pollUntil(
          () => geminiCall<OperationState>(ctx, itemIndex, `/v1beta/${name}`),
          (state) => state.done === true,
          { ...timing, signal: ctx.signal },
        );
  if (finished.error) {
    throw new NodeOperationError(
      ctx.getNode(),
      redactSecrets(finished.error.message || 'The Gemini job failed'),
      {
        itemIndex,
      },
    );
  }
  return finished;
}
