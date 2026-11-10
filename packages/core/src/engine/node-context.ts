/**
 * Builds the context objects passed to node implementations (execute / trigger / poll /
 * webhook / supplyData / loadOptions). All parameter access goes through the sandboxed
 * expression evaluator.
 */
import {
  assertCredentialUrlAllowed,
  type BaseContext,
  type BinaryData,
  CHAT_TRIGGER_TYPE,
  type ChatTriggerRef,
  type ConnectedNode,
  type ConnectionType,
  CredentialDomainError,
  type DataObject,
  type ExecuteContext,
  type ExecuteData,
  type ExecutionState,
  type ExpressionDataContext,
  type ExpressionEvaluator,
  fromAiVariables,
  type GetNodeParameterOptions,
  getByPath,
  getCredentialAllowedDomains,
  type HttpFullResponse,
  type HttpRequestOptions,
  type HttpResponseStream,
  type InstanceLimits,
  type Item,
  isResourceLocatorValue,
  type Logger,
  NodeApiError,
  type NodeCredentialRef,
  type NodeExecutionHint,
  type NodeHelpers,
  NodeOperationError,
  type NodeParameters,
  type NodeType,
  type PollContext,
  resolveNodeParameters,
  type ScheduleSlotStore,
  type ToolResumeData,
  type ToolSuspension,
  type TriggerContext,
  toItems,
  type WebhookContext,
  type WebhookRequest,
  type Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { Cron } from 'croner';
import {
  applyAuthentication,
  createCredentialHelpers,
  type OAuth2Data,
  oauth2Request,
} from '../credentials/authentication';
import { HttpError, SsrfBlockedError } from '../http/http-client';
import type { ExecutionServices } from './services';

const MIME_BY_EXT: Record<string, string> = {
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
};

const MB = 1024 * 1024;

/** instance size caps used when the host sets none (server env overrides them) */
export const DEFAULT_INSTANCE_LIMITS: Readonly<InstanceLimits> = Object.freeze({
  maxDecompressedBytes: 100 * MB,
  maxArchiveEntries: 1000,
  maxImagePixels: 50_000_000,
  maxImageInputBytes: 25 * MB,
  maxSpreadsheetCells: 1_000_000,
  maxRemoteFileBytes: 100 * MB,
  maxPassthroughBinaryBytes: 52_428_800,
});

/** the defaults overlaid by the host's values; a missing, non-finite or non-positive value keeps the default */
export function getInstanceLimits(overrides?: Partial<InstanceLimits>): InstanceLimits {
  const limits: InstanceLimits = { ...DEFAULT_INSTANCE_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof InstanceLimits>) {
    const value = overrides?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

export function guessMimeType(fileName?: string): string {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream';
}

function apiErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 500) : undefined;
  const b = body as Record<string, any>;
  return (
    b.error?.message ??
    b.message ??
    b.error_description ??
    (typeof b.error === 'string' ? b.error : undefined)
  );
}

export function toNodeApiError(node: WorkflowNode, error: unknown): Error {
  if (error instanceof NodeOperationError) return error;
  if (error instanceof HttpError) {
    return new NodeApiError(node, apiErrorMessage(error.body) ?? error.message, {
      httpCode: error.statusCode,
      description: `HTTP ${error.statusCode} ${error.statusMessage}`.trim(),
      responseBody: error.body,
      request: error.request,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  }
  if (error instanceof SsrfBlockedError) return new NodeApiError(node, error.message, { cause: error });
  if (error instanceof CredentialDomainError) {
    return new NodeApiError(node, error.message, { description: error.description, cause: error });
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new NodeApiError(node, 'The request timed out', { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A streamed body is read after the request returned, outside its error mapping: errors while it is
 * read (a timeout before the first byte, the size limit) are mapped the same way.
 */
function mapStreamErrors<T>(node: WorkflowNode, options: HttpRequestOptions, response: T): T {
  if (options.responseType !== 'stream') return response;
  const wrap = (body: unknown): unknown => {
    if (typeof (body as Partial<HttpResponseStream> | null)?.[Symbol.asyncIterator] !== 'function')
      return body;
    const stream = body as HttpResponseStream;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield* stream;
        } catch (error) {
          throw toNodeApiError(node, error);
        }
      },
    };
  };
  if (options.returnFullResponse) {
    const full = response as HttpFullResponse;
    return { ...full, body: wrap(full.body) } as T;
  }
  return wrap(response) as T;
}

export interface ContextDeps {
  workflow: Workflow;
  node: WorkflowNode;
  services: ExecutionServices;
  evaluator: ExpressionEvaluator;
  signal: AbortSignal;
  /** execution state, absent for activation-time contexts (triggers, webhooks) */
  state?: ExecutionState;
  runIndex?: number;
  executeData?: ExecuteData;
  /** additional `$`-variables (e.g. $fromAI) */
  extraVariables?: Record<string, unknown>;
}

function nodeTypeOf(deps: ContextDeps): NodeType {
  return deps.workflow.getNodeType(deps.node);
}

const resolvedParamsCache = new WeakMap<WorkflowNode, NodeParameters>();

export function getResolvedParameters(workflow: Workflow, node: WorkflowNode): NodeParameters {
  let cached = resolvedParamsCache.get(node);
  if (!cached) {
    const type = workflow.nodeTypes.get(node.type);
    cached = type
      ? resolveNodeParameters(type.description.properties, node.parameters, { nodeVersion: node.typeVersion })
      : node.parameters;
    resolvedParamsCache.set(node, cached);
  }
  return cached;
}

function inputItems(deps: ContextDeps, inputIndex = 0, type: ConnectionType = 'main'): Item[] {
  return (deps.executeData?.data?.[type]?.[inputIndex] ?? []) as Item[];
}

export function buildExpressionContext(deps: ContextDeps, itemIndex: number): ExpressionDataContext {
  const state = deps.state;
  return {
    workflow: {
      id: deps.workflow.id,
      name: deps.workflow.name,
      active: deps.workflow.active,
      nodes: deps.workflow.nodes,
    },
    runData: state?.resultData.runData ?? {},
    activeNodeName: deps.node.name,
    connectionInputData: inputItems(deps),
    itemIndex,
    runIndex: deps.runIndex ?? 0,
    mode: deps.services.mode,
    executionId: deps.services.executionId,
    timezone: deps.workflow.settings.timezone ?? deps.services.timezone,
    variables: deps.services.variables,
    executeData: deps.executeData,
    resumeUrl: deps.services.resumeUrl,
    resumeFormUrl: deps.services.resumeFormUrl,
    nodeParameters: getResolvedParameters(deps.workflow, deps.node),
    customData: state
      ? {
          get: (k) => state.resultData.customData?.[k],
          set: (k, v) => setCustomData(state, k, v),
          getAll: () => ({ ...(state.resultData.customData ?? {}) }),
        }
      : undefined,
    extra: deps.extraVariables,
  };
}

/** sets one custom execution data value: at most 10 keys, keys cut to 50 characters, values to 255; throws past the tenth key */
export function setCustomData(state: ExecutionState, key: string, value: string) {
  const data = (state.resultData.customData ??= {});
  if (!(key in data) && Object.keys(data).length >= 10) {
    throw new Error('Custom execution data is limited to 10 keys');
  }
  data[key.slice(0, 50)] = String(value).slice(0, 255);
}

function extractResourceLocator(value: unknown, deps: ContextDeps, name: string): unknown {
  if (!isResourceLocatorValue(value)) return value;
  const description = nodeTypeOf(deps).description.properties.find((p) => p.name === name);
  const mode = description?.modes?.find((m) => m.name === value.mode);
  if (mode?.extractValue?.type === 'regex') {
    const match = new RegExp(mode.extractValue.regex).exec(String(value.value));
    if (!match) {
      throw new NodeOperationError(
        deps.node,
        `The value "${value.value}" is not a valid ${mode.displayName}`,
      );
    }
    return match[1] ?? match[0];
  }
  return value.value;
}

/**
 * The credential a node uses for `type`. A reference whose id is an expression
 * (`={{ $json.customer.credentialId }}`) is a credential slot resolved per item; the
 * credentials provider still enforces tenant ownership of the resolved id.
 */
export function resolveCredentialRef(deps: ContextDeps, type: string, itemIndex = 0): NodeCredentialRef {
  const { node, evaluator } = deps;
  const ref = node.credentials?.[type];
  if (!ref) throw new NodeOperationError(node, `Node does not have credentials of type "${type}" set`);
  if (typeof ref.id === 'string' && ref.id.startsWith('=')) {
    let id: unknown;
    try {
      id = evaluator.evaluate(ref.id, buildExpressionContext(deps, itemIndex));
    } catch (error) {
      throw new NodeOperationError(node, `Credential expression failed: ${(error as Error).message}`, {
        itemIndex,
        cause: error,
      });
    }
    if (typeof id !== 'string' || !id.trim()) {
      throw new NodeOperationError(
        node,
        `Credential expression for "${type}" did not resolve to a credential id`,
        {
          itemIndex,
        },
      );
    }
    return { id: id.trim(), name: ref.name };
  }
  return ref;
}

function createHelpers(deps: ContextDeps, getCredentials: BaseContext['getCredentials']): NodeHelpers {
  const { services, node } = deps;
  const assertBinaryData = (itemIndex: number, propertyName: string, inputIndex = 0): BinaryData => {
    const item = inputItems(deps, inputIndex)[itemIndex];
    const binary = item?.binary?.[propertyName];
    if (!binary) {
      throw new NodeOperationError(node, `No binary data property "${propertyName}" on item ${itemIndex}`, {
        itemIndex,
        description: item?.binary
          ? `Available binary properties: ${Object.keys(item.binary).join(', ')}`
          : 'The input item has no binary data.',
      });
    }
    return binary;
  };
  const httpRequest = async (options: HttpRequestOptions) => {
    try {
      return mapStreamErrors(node, options, await services.http.request(options, deps.signal));
    } catch (error) {
      throw toNodeApiError(node, error);
    }
  };
  const httpRequestWithAuthentication = async (
    credentialType: string,
    options: HttpRequestOptions,
    itemIndex = 0,
  ) => {
    const ref = resolveCredentialRef(deps, credentialType, itemIndex);
    const data = await getCredentials(credentialType, itemIndex);
    try {
      // the credential's allowed domains are checked before anything signs the request, and the list
      // goes with it so HttpClient checks every redirect hop too
      const allowedDomains = getCredentialAllowedDomains(data, {
        userUrl: options.credentialScope === 'userUrl',
      });
      assertCredentialUrlAllowed(options.url, allowedDomains);
      const request: HttpRequestOptions =
        allowedDomains === undefined ? options : { ...options, allowedDomains };
      const type = services.credentialTypes.getResolved(credentialType);
      // a client-credentials type with its own `authenticate` gets its token there, not from oauth2Request
      const ownTokenFlow =
        typeof type?.authenticate === 'function' && (data as OAuth2Data).grantType === 'clientCredentials';
      if (services.credentialTypes.isA(credentialType, 'oAuth2Api') && !ownTokenFlow) {
        const response = await oauth2Request(
          services.http,
          data as OAuth2Data,
          request,
          (updated) => services.credentials.update(ref, credentialType, updated),
          deps.signal,
          services.oauthTokenDecrypt,
        );
        return mapStreamErrors(node, options, response);
      }
      if (!type) throw new NodeOperationError(node, `Unknown credential type "${credentialType}"`);
      const authHelpers = createCredentialHelpers(services.http, allowedDomains, deps.signal);
      const authenticated = await applyAuthentication(type, data, request, authHelpers);
      return mapStreamErrors(node, options, await services.http.request(authenticated, deps.signal));
    } catch (error) {
      throw toNodeApiError(node, error);
    }
  };
  return {
    httpRequest,
    httpRequestWithAuthentication,
    async prepareBinaryData(data: Uint8Array, fileName?: string, mimeType?: string): Promise<BinaryData> {
      return services.binaryData.store(data, {
        fileName,
        mimeType: mimeType ?? guessMimeType(fileName),
        executionId: services.executionId || 'activation',
      });
    },
    async getBinaryDataBuffer(itemIndex: number, propertyName: string, inputIndex = 0) {
      return services.binaryData.getBuffer(assertBinaryData(itemIndex, propertyName, inputIndex));
    },
    assertBinaryData,
    returnJsonArray: (data) => toItems(data),
    constructExecutionMetaData: (items, { itemData }) => items.map((i) => ({ ...i, pairedItem: itemData })),
    async assertHostAllowed(host: string) {
      try {
        await services.http.assertHostAllowed(host);
      } catch (error) {
        throw toNodeApiError(node, error);
      }
    },
    async resolveAllowedHost(host: string) {
      try {
        return await services.http.resolveAllowedHost(host);
      } catch (error) {
        throw toNodeApiError(node, error);
      }
    },
    getInstanceLimits: () => getInstanceLimits(services.nodeLimits),
    dataTables: services.dataTables,
  } as NodeHelpers;
}

function nodeLogger(logger: Logger, deps: ContextDeps): Logger {
  const meta = {
    node: deps.node.name,
    executionId: deps.services.executionId,
    tenantId: deps.services.tenantId,
  };
  return {
    debug: (m, x) => logger.debug(m, { ...meta, ...x }),
    info: (m, x) => logger.info(m, { ...meta, ...x }),
    warn: (m, x) => logger.warn(m, { ...meta, ...x }),
    error: (m, x) => logger.error(m, { ...meta, ...x }),
  };
}

export function createBaseContext(deps: ContextDeps): BaseContext {
  const { workflow, node, services, evaluator } = deps;
  const getCredentials = async <T extends DataObject = DataObject>(
    type: string,
    itemIndex = 0,
  ): Promise<T> => {
    return (await services.credentials.get(resolveCredentialRef(deps, type, itemIndex), type)) as T;
  };

  const getNodeParameter = (
    name: string,
    itemIndex: number,
    fallback?: unknown,
    options: GetNodeParameterOptions = {},
  ): unknown => {
    const params = getResolvedParameters(workflow, node);
    let value = getByPath(params, name);
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      throw new NodeOperationError(node, `Could not get parameter "${name}"`);
    }
    if (options.rawExpressions) return value;
    try {
      value = evaluator.resolve(value, buildExpressionContext(deps, itemIndex));
    } catch (error) {
      throw new NodeOperationError(node, (error as Error).message, {
        itemIndex,
        description: `Error in parameter "${name}"`,
        cause: error,
      });
    }
    if (options.extractValue) value = extractResourceLocator(value, deps, name);
    return value;
  };

  return {
    getNode: () => node,
    getWorkflow: () => ({ id: workflow.id, name: workflow.name, active: workflow.active }),
    getMode: () => services.mode,
    getExecutionId: () => services.executionId,
    getTenantId: () => services.tenantId,
    getProjectId: () => services.projectId,
    getTimezone: () => workflow.settings.timezone ?? services.timezone,
    getCredentials,
    getNodeParameter,
    evaluateExpression: (expression, itemIndex) =>
      evaluator.evaluate(expression, buildExpressionContext(deps, itemIndex)),
    getWorkflowStaticData(type) {
      // n8n's layout: the workflow scope under `global`, each node's scope under `node:<name>`
      const key = type === 'global' ? 'global' : `node:${node.name}`;
      return ((workflow.staticData[key] as DataObject | undefined) ??= {});
    },
    getInstanceBaseUrl: () => services.instanceBaseUrl,
    logger: nodeLogger(services.logger, deps),
    helpers: createHelpers(deps, getCredentials),
    signal: deps.signal,
  };
}

export interface ExecuteContextCallbacks {
  getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown>;
  putExecutionToWait(waitTill: Date): void;
  continueOnFail(): boolean;
  /** receives the hints the node adds during this run */
  addExecutionHints(hints: NodeExecutionHint[]): void;
  /** receives what the node passes to setMetadata during this run */
  setMetadata?(data: DataObject): void;
  /** receives a tool's wait and the agent's checkpoint */
  suspendForTool?(suspension: ToolSuspension, checkpoint: DataObject): void;
  /** the checkpoint and the answer when the run resumes after a tool's wait */
  getResumeData?(): ToolResumeData | undefined;
}

/**
 * Reads a tool node's parameter with `$fromAI` bound to the model's arguments. The arguments are data:
 * a value that looks like an expression stays text.
 */
export function createToolParameterReader(
  deps: ContextDeps,
): (name: string, itemIndex: number, args: DataObject) => unknown {
  return (name, itemIndex, args) =>
    createBaseContext({ ...deps, extraVariables: fromAiVariables(args) }).getNodeParameter(name, itemIndex);
}

/** `executeWorkflow` shared by execute and supply-data contexts */
export function createSubWorkflowCaller(deps: ContextDeps): ExecuteContext['executeWorkflow'] {
  const { services, node } = deps;
  return async (source, items, options) => {
    if (!services.executeSubWorkflow) {
      throw new NodeOperationError(node, 'Sub-workflow execution is not available in this environment');
    }
    return services.executeSubWorkflow({
      source,
      items,
      options,
      parent: {
        executionId: services.executionId,
        workflowId: deps.workflow.id,
        nodeName: node.name,
        tenantId: services.tenantId,
      },
    });
  };
}

/** what a Python run says when the instance has no Python runner */
export const PYTHON_DISABLED_MESSAGE =
  'This instance disallows Python execution because it has the environment variable `PYTHON_ENABLED` set to `false`. To restore this functionality, remove this environment variable or set it to `true`.';

/** `runCode` shared by execute and supply-data contexts */
export function createCodeRunnerCall(deps: ContextDeps, base: BaseContext): ExecuteContext['runCode'] {
  const { services, node, state } = deps;
  const staticData = deps.workflow.staticData;
  const nodeKey = `node:${node.name}`;
  return async (options) => {
    // a workflow stores n8n's `python` on ai.toolCode, whatever the option's type says
    const python = options.language === 'pythonNative' || (options.language as string) === 'python';
    const runner = python ? services.pythonRunner : services.codeRunner;
    if (!runner) throw new NodeOperationError(node, PYTHON_DISABLED_MESSAGE);
    const nodeOutputs: Record<string, Item[]> = {};
    for (const [name, runs] of Object.entries(state?.resultData.runData ?? {})) {
      const last = runs[runs.length - 1];
      const main = last?.data?.main?.[0];
      if (main) nodeOutputs[name] = main;
    }
    return runner.run({
      code: options.code,
      mode: options.mode,
      language: python ? 'pythonNative' : options.language,
      query: options.query,
      items: inputItems(deps).map((item, index) => ({ ...item, pairedItem: { item: index } })),
      nodeOutputs,
      variables: services.variables,
      workflow: base.getWorkflow(),
      execution: { id: services.executionId, mode: services.mode === 'manual' ? 'test' : 'production' },
      nodeName: node.name,
      timezone: base.getTimezone(),
      onConsole: (_level, args) => {
        if (services.mode === 'manual') services.hooks?.sendMessageToUI?.(node.name, args);
      },
      signal: deps.signal,
      staticData: { global: copyScope(staticData, 'global'), node: copyScope(staticData, nodeKey) },
      onStaticData: (data) => {
        replaceScope(staticData, 'global', data.global);
        replaceScope(staticData, nodeKey, data.node);
      },
    });
  };
}

/** a copy of one static data scope; a missing scope is an empty object and is not created */
function copyScope(staticData: DataObject, key: string): DataObject {
  const scope = staticData[key];
  return scope && typeof scope === 'object' && !Array.isArray(scope)
    ? structuredClone(scope as DataObject)
    : {};
}

/** replace the contents of one static data scope, keeping the object other holders already have */
function replaceScope(staticData: DataObject, key: string, contents: DataObject): void {
  const current = staticData[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const scope = current as DataObject;
    if (JSON.stringify(scope) === JSON.stringify(contents)) return;
    for (const k of Object.keys(scope)) delete scope[k];
    Object.assign(scope, structuredClone(contents));
  } else if (Object.keys(contents).length) {
    staticData[key] = structuredClone(contents);
  }
}

/** the nodes `names` lists, with their types */
export function connectedNodes(workflow: Workflow, names: string[]): ConnectedNode[] {
  return names.flatMap((name) => {
    const found = workflow.getNode(name);
    return found ? [{ name: found.name, type: found.type }] : [];
  });
}

export function createExecuteContext(deps: ContextDeps, callbacks: ExecuteContextCallbacks): ExecuteContext {
  const base = createBaseContext(deps);
  const { services, node, state } = deps;
  return {
    ...base,
    getInputData: (inputIndex = 0, type: ConnectionType = 'main') => inputItems(deps, inputIndex, type),
    getInputSourceData: (inputIndex = 0) => deps.executeData?.source?.main?.[inputIndex] ?? null,
    getInputConnectionData: (type, itemIndex) => callbacks.getInputConnectionData(type, itemIndex),
    continueOnFail: () => callbacks.continueOnFail(),
    getRunIndex: () => deps.runIndex ?? 0,
    executeWorkflow: createSubWorkflowCaller(deps),
    async putExecutionToWait(waitTill: Date) {
      callbacks.putExecutionToWait(waitTill);
    },
    sendResponse: (response) => services.hooks?.sendResponse?.(response),
    sendChunk: (chunk, options) =>
      services.hooks?.sendChunk?.(chunk, {
        nodeId: node.id,
        nodeName: node.name,
        runIndex: deps.runIndex ?? 0,
        itemIndex: options?.itemIndex ?? 0,
      }),
    sendMessageToUI: (...args) => {
      if (services.mode === 'manual') services.hooks?.sendMessageToUI?.(node.name, args);
    },
    addExecutionHints: (...hints) => callbacks.addExecutionHints(hints),
    getContext(scope) {
      if (!state) return {};
      const key = scope === 'node' ? `node:${node.name}` : 'flow';
      return (state.executionData.contextData[key] ??= {});
    },
    setCustomData: (key, value) => {
      if (state) setCustomData(state, key, value);
    },
    runCode: createCodeRunnerCall(deps, base),
    setMetadata: (data) => callbacks.setMetadata?.(data),
    getParentNodes: () => connectedNodes(deps.workflow, deps.workflow.getParentNodes(node.name)),
    getChildNodes: () => connectedNodes(deps.workflow, deps.workflow.getChildNodes(node.name)),
    suspendForTool(suspension, checkpoint) {
      if (!callbacks.suspendForTool) {
        throw new NodeOperationError(node, 'This run cannot wait for a tool');
      }
      callbacks.suspendForTool(suspension, checkpoint);
    },
    getResumeData: () => callbacks.getResumeData?.(),
    getToolParameter: createToolParameterReader(deps),
    getChatTrigger: () => findChatTrigger(deps.workflow),
  };
}

/**
 * The workflow's Chat Trigger, wherever the asking node sits (a main child, a tool under an Agent, a webhook):
 * the first enabled `ai.chatTrigger` node, with its parameters resolved to their defaults (expressions stay as
 * written). A copy, so the caller cannot change the cached parameters.
 */
function findChatTrigger(workflow: Workflow): ChatTriggerRef | null {
  const trigger = Object.values(workflow.nodes).find(
    (candidate) => candidate.type === CHAT_TRIGGER_TYPE && !candidate.disabled,
  );
  if (!trigger) return null;
  return {
    name: trigger.name,
    type: trigger.type,
    parameters: structuredClone(getResolvedParameters(workflow, trigger)),
  };
}

export interface TriggerCallbacks {
  /** our 2nd = n8n's donePromise (run result, as today), our 3rd = n8n's responsePromise / sendResponse hook */
  emit: TriggerContext['emit'];
  emitError(error: Error): void;
  activationMode: 'init' | 'create' | 'update' | 'activate' | 'manual';
  /** the slot store for missed schedules; the host gives one only for a saved workflow */
  scheduleSlots?: ScheduleSlotStore;
}

/** the most slots getCronSlots returns */
const MAX_CRON_SLOTS = 100;

/**
 * The scheduled time a tick of `expression` belongs to: the latest run at or before `fired`. A
 * timer fires a little after its slot (later under load), and two leaders must claim the same slot.
 */
export function scheduledSlot(expression: string, fired: Date, timezone: string): Date {
  // croner's previousRuns excludes the reference second, so start one second after `fired`
  const reference = new Date(Math.floor(fired.getTime() / 1000) * 1000 + 1000);
  return new Cron(expression, { timezone }).previousRuns(1, reference)[0] ?? fired;
}

export function createTriggerContext(deps: ContextDeps, callbacks: TriggerCallbacks): TriggerContext {
  const base = createBaseContext(deps);
  return {
    ...base,
    emit: callbacks.emit,
    emitError: callbacks.emitError,
    getActivationMode: () => callbacks.activationMode,
    registerCron(expression: string, onTick: (slot: Date) => void) {
      const timezone = base.getTimezone();
      const job = new Cron(expression, { timezone, protect: true }, (self) => {
        try {
          onTick(scheduledSlot(expression, self.currentRun() ?? new Date(), timezone));
        } catch (error) {
          callbacks.emitError(error as Error);
        }
      });
      return () => job.stop();
    },
    getCronSlots(expression: string, after: Date, before: Date, max = MAX_CRON_SLOTS) {
      const limit = Math.min(Math.floor(max), MAX_CRON_SLOTS);
      if (!(limit > 0) || before.getTime() <= after.getTime()) return [];
      return new Cron(expression, { timezone: base.getTimezone() })
        .nextRuns(limit, after)
        .filter((slot) => slot.getTime() > after.getTime() && slot.getTime() < before.getTime());
    },
    scheduleSlots: callbacks.scheduleSlots,
  };
}

export function createPollContext(
  deps: ContextDeps,
  activationMode: TriggerCallbacks['activationMode'],
): PollContext {
  return { ...createBaseContext(deps), getActivationMode: () => activationMode };
}

/** what a webhook context can reach beyond the request; `createWebhookSubNodes` builds it */
export interface WebhookContextCallbacks {
  /** the sub-nodes attached to the webhook node (a memory under the Chat Trigger) */
  getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown>;
}

export function createWebhookContext(
  deps: ContextDeps,
  request: WebhookRequest,
  webhookName: string,
  callbacks?: WebhookContextCallbacks,
): WebhookContext {
  const base = createBaseContext(deps);
  const { services, workflow, node } = deps;
  return {
    ...base,
    getRequestObject: () => request,
    getBodyData: () => (request.body && typeof request.body === 'object' ? (request.body as DataObject) : {}),
    getHeaderData: () => request.headers,
    getQueryData: () => request.query,
    getParamsData: () => request.params,
    getWebhookName: () => webhookName,
    getParentNodes: () => connectedNodes(workflow, workflow.getParentNodes(node.name)),
    getChildNodes: () => connectedNodes(workflow, workflow.getChildNodes(node.name)),
    getResumeFormUrl: () => services.resumeFormUrl,
    getBinaryBuffer: (binary) => services.binaryData.getBuffer(binary),
    signFormToken(payload, ttlSeconds) {
      if (!services.formTokens) {
        throw new NodeOperationError(node, 'Form tokens are not available in this environment');
      }
      return services.formTokens.sign(payload, ttlSeconds);
    },
    verifyFormToken: (token) => services.formTokens?.verify(token) ?? null,
    getFormAuth: () => services.formAuth,
    getMcpAuth: () => services.mcpAuth,
    getCredentialGate: () => services.credentialGate,
    async getInputConnectionData(type, itemIndex) {
      if (!callbacks) throw new NodeOperationError(node, 'Sub-nodes are not available here');
      return callbacks.getInputConnectionData(type, itemIndex);
    },
    getChatTrigger: () => findChatTrigger(workflow),
    isPublicChatDisabled: () => services.disablePublicChatTrigger === true,
  };
}

/** check whether an `Item[][]` returned by a node is well-formed */
export function assertValidOutput(node: WorkflowNode, output: unknown): asserts output is Item[][] | null {
  if (output === null || output === undefined) return;
  if (!Array.isArray(output)) {
    throw new NodeOperationError(node, 'Node returned invalid data: expected an array of outputs');
  }
  output.forEach((items, outputIndex) => {
    if (items === null) return;
    if (!Array.isArray(items)) {
      throw new NodeOperationError(node, `Node returned invalid data for output ${outputIndex}`);
    }
    items.forEach((item, i) => {
      if (
        !item ||
        typeof item !== 'object' ||
        !item.json ||
        typeof item.json !== 'object' ||
        Array.isArray(item.json)
      ) {
        throw new NodeOperationError(
          node,
          `Node returned an invalid item at output ${outputIndex}, index ${i}`,
          {
            description: 'Every item must be an object with a "json" object property.',
          },
        );
      }
    });
  });
}

export type { HttpFullResponse };
