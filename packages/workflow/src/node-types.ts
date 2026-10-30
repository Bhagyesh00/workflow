/**
 * Contracts between the execution engine and node implementations.
 * Implementations of these contexts live in `@workflow/core`.
 */
import type {
  BinaryData,
  ConnectionType,
  CredentialType,
  DataObject,
  ExecutionMode,
  HttpFullResponse,
  HttpRequestOptions,
  Item,
  NodeOutput,
  NodePropertyOption,
  NodeTypeDescription,
  PairedItem,
  WorkflowDefinition,
  WorkflowNode,
} from './interfaces';

export interface Logger {
  debug(message: string, meta?: DataObject): void;
  info(message: string, meta?: DataObject): void;
  warn(message: string, meta?: DataObject): void;
  error(message: string, meta?: DataObject): void;
}

export interface GetNodeParameterOptions {
  /** for resourceLocator params return the plain value instead of the { __rl } object */
  extractValue?: boolean;
  /** return expression strings unresolved */
  rawExpressions?: boolean;
}

export interface NodeHelpers {
  /** SSRF-guarded HTTP. Throws NodeApiError on non-2xx unless `ignoreHttpStatusErrors`. */
  httpRequest<T = any>(options: HttpRequestOptions): Promise<T | HttpFullResponse<T>>;
  /** HTTP with credentials of `credentialType` applied (API key, basic, OAuth2 incl. refresh). */
  httpRequestWithAuthentication<T = any>(
    credentialType: string,
    options: HttpRequestOptions,
  ): Promise<T | HttpFullResponse<T>>;
  prepareBinaryData(data: Uint8Array, fileName?: string, mimeType?: string): Promise<BinaryData>;
  getBinaryDataBuffer(itemIndex: number, propertyName: string, inputIndex?: number): Promise<Uint8Array>;
  assertBinaryData(itemIndex: number, propertyName: string, inputIndex?: number): BinaryData;
  /** wraps plain objects as items */
  returnJsonArray(data: DataObject | DataObject[]): Item[];
  /** sets pairedItem on every item */
  constructExecutionMetaData(items: Item[], options: { itemData: PairedItem | PairedItem[] }): Item[];
}

export interface BaseContext {
  getNode(): WorkflowNode;
  getWorkflow(): { id?: string; name: string; active: boolean };
  getMode(): ExecutionMode;
  getExecutionId(): string;
  getTenantId(): string;
  getTimezone(): string;
  /** decrypted credential data for the credential of `type` attached to this node */
  getCredentials<T extends DataObject = DataObject>(type: string, itemIndex?: number): Promise<T>;
  getNodeParameter(
    name: string,
    itemIndex: number,
    fallback?: unknown,
    options?: GetNodeParameterOptions,
  ): unknown;
  evaluateExpression(expression: string, itemIndex: number): unknown;
  /** persistent per-workflow state (e.g. polling cursors). `node` = scoped to this node. */
  getWorkflowStaticData(type: 'global' | 'node'): DataObject;
  getInstanceBaseUrl(): string;
  logger: Logger;
  helpers: NodeHelpers;
  /** aborted when the execution is cancelled or times out */
  signal: AbortSignal;
}

export interface ExecuteWorkflowSource {
  source: 'database' | 'parameter';
  workflowId?: string;
  /** inline definition when source = parameter */
  workflow?: WorkflowDefinition;
}

export interface ExecuteWorkflowOptions {
  /** do not wait for the sub-workflow to finish */
  doNotWaitToFinish?: boolean;
}

export interface WebhookResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** binary payload response */
  binary?: { data: Uint8Array; mimeType: string; fileName?: string };
}

export interface ExecuteContext extends BaseContext {
  getInputData(inputIndex?: number, connectionType?: ConnectionType): Item[];
  /** resolves sub-nodes (AI model, memory, tools...) attached via `type` */
  getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown>;
  /** true when node.onError is a "continue" mode */
  continueOnFail(): boolean;
  getRunIndex(): number;
  executeWorkflow(
    source: ExecuteWorkflowSource,
    items: Item[],
    options?: ExecuteWorkflowOptions,
  ): Promise<{ executionId: string; data: Item[][] | null }>;
  /** pause execution until `waitTill` (or resume webhook call); node returns its input afterwards */
  putExecutionToWait(waitTill: Date): Promise<void>;
  /** send the HTTP response for the triggering webhook (Respond to Webhook node) */
  sendResponse(response: WebhookResponse): void;
  /** stream a chunk to the caller (chat / streaming webhooks) */
  sendChunk(chunk: unknown): void;
  /** forward console output to the editor during manual runs */
  sendMessageToUI(...args: unknown[]): void;
  /** per-node scratch state that survives across runs of the same execution (loops) */
  getContext(scope: 'node' | 'flow'): DataObject;
  setCustomData(key: string, value: string): void;
  /** run user JS in the isolated sandbox */
  runCode(options: RunCodeOptions): Promise<unknown>;
}

export interface RunCodeOptions {
  code: string;
  mode: 'runOnceForAllItems' | 'runOnceForEachItem';
  itemIndex?: number;
  language?: 'javaScript';
}

export interface TriggerContext extends BaseContext {
  emit(data: Item[][], responsePromise?: { resolve(value: unknown): void; reject(err: Error): void }): void;
  emitError(error: Error): void;
  /** register a cron job; returned function unregisters it */
  registerCron(expression: string, onTick: () => void): () => void;
  getActivationMode(): 'init' | 'create' | 'update' | 'activate' | 'manual';
}

export interface TriggerResponse {
  closeFunction?: () => Promise<void>;
  /** invoked when the user clicks "Test workflow" on a non-webhook trigger */
  manualTriggerFunction?: () => Promise<void>;
}

export interface PollContext extends BaseContext {
  getActivationMode(): 'init' | 'create' | 'update' | 'activate' | 'manual';
}

export interface WebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  params: Record<string, string>;
  body: unknown;
  rawBody?: Uint8Array;
  ip?: string;
  /** uploaded files (multipart) */
  files?: Array<{ fieldName: string; fileName: string; mimeType: string; data: Uint8Array }>;
}

export interface WebhookContext extends BaseContext {
  getRequestObject(): WebhookRequest;
  getBodyData(): DataObject;
  getHeaderData(): Record<string, string | string[] | undefined>;
  getQueryData(): DataObject;
  getParamsData(): Record<string, string>;
  getWebhookName(): string;
}

export interface WebhookResponseData {
  /** items to start the workflow with; omit to not start an execution */
  workflowData?: Item[][];
  /** immediate response (when responseMode = onReceived or the workflow is not started) */
  webhookResponse?: WebhookResponse;
  /** node handles the response itself later (Respond to Webhook) */
  noWebhookResponse?: boolean;
}

/** registration of webhooks with third-party services (e.g. Telegram setWebhook) */
export interface WebhookLifecycleContext extends BaseContext {
  getNodeWebhookUrl(name: string): string;
  getWebhookName(): string;
}

export interface WebhookLifecycleMethods {
  checkExists(ctx: WebhookLifecycleContext): Promise<boolean>;
  create(ctx: WebhookLifecycleContext): Promise<boolean>;
  delete(ctx: WebhookLifecycleContext): Promise<boolean>;
}

export interface SupplyDataContext extends BaseContext {
  getInputData(inputIndex?: number): Item[];
  getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown>;
  /** record what the sub-node received/returned so the editor can show AI logs */
  logSubNodeRun(input: DataObject, output: DataObject, error?: Error): void;
}

export interface SupplyData {
  response: unknown;
  closeFunction?: () => Promise<void>;
}

export interface LoadOptionsContext extends Omit<BaseContext, 'getNodeParameter'> {
  /** current (unsaved) parameter value from the editor */
  getCurrentNodeParameter(name: string): unknown;
}

export interface ListSearchResult {
  results: Array<{ name: string; value: string; url?: string }>;
  paginationToken?: string;
}

export interface NodeType {
  description: NodeTypeDescription;
  execute?(ctx: ExecuteContext): Promise<NodeOutput>;
  trigger?(ctx: TriggerContext): Promise<TriggerResponse | undefined>;
  poll?(ctx: PollContext): Promise<Item[][] | null>;
  webhook?(ctx: WebhookContext): Promise<WebhookResponseData>;
  webhookMethods?: Record<string, WebhookLifecycleMethods>;
  supplyData?(ctx: SupplyDataContext, itemIndex: number): Promise<SupplyData>;
  methods?: {
    loadOptions?: Record<string, (ctx: LoadOptionsContext) => Promise<NodePropertyOption[]>>;
    listSearch?: Record<
      string,
      (ctx: LoadOptionsContext, filter?: string, paginationToken?: string) => Promise<ListSearchResult>
    >;
  };
}

/** a package of nodes + credentials (built-in or community) */
export interface NodePackage {
  name: string;
  nodes: NodeType[];
  credentials: CredentialType[];
}
