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
  NodeExecutionHint,
  NodeOutput,
  NodePropertyOption,
  NodeTypeDescription,
  PairedItem,
  SourceData,
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
    /** item whose data resolves an expression-based credential slot (default 0) */
    itemIndex?: number,
  ): Promise<T | HttpFullResponse<T>>;
  prepareBinaryData(data: Uint8Array, fileName?: string, mimeType?: string): Promise<BinaryData>;
  getBinaryDataBuffer(itemIndex: number, propertyName: string, inputIndex?: number): Promise<Uint8Array>;
  assertBinaryData(itemIndex: number, propertyName: string, inputIndex?: number): BinaryData;
  /** wraps plain objects as items */
  returnJsonArray(data: DataObject | DataObject[]): Item[];
  /** sets pairedItem on every item */
  constructExecutionMetaData(items: Item[], options: { itemData: PairedItem | PairedItem[] }): Item[];
  /**
   * Resolve `host` and throw if any address is blocked by the SSRF policy. Nodes that open
   * non-HTTP connections (databases, SMTP, MCP over TCP) must call this before connecting.
   */
  assertHostAllowed(host: string): Promise<void>;
  /**
   * Resolve `host` once and check every address against the SSRF policy. Connect with the returned
   * `lookup` (keeping `host` as the name, so TLS verifies it), never with a fresh resolution: a
   * driver that resolves the name again can be sent elsewhere by a DNS rebind.
   */
  resolveAllowedHost(host: string): Promise<AllowedHost>;
  /** the instance's size caps for file, archive, image and spreadsheet nodes (defaults overlaid by config) */
  getInstanceLimits(): InstanceLimits;
}

/**
 * Size caps set by the instance (env), not by node options. Nodes check them before they decode,
 * inflate or download data, so one item cannot exhaust the worker's memory.
 */
export interface InstanceLimits {
  /** total bytes one archive or compressed file may inflate to */
  maxDecompressedBytes: number;
  /** entries one archive may hold */
  maxArchiveEntries: number;
  /** width x height of one decoded or created image */
  maxImagePixels: number;
  /** bytes of one image input */
  maxImageInputBytes: number;
  /** cells one sheet may span (from its range) */
  maxSpreadsheetCells: number;
  /** bytes one remote file (FTP, SFTP, SSH) may have */
  maxRemoteFileBytes: number;
}

/**
 * Last fired cron slot per schedule rule, kept by the server so missed slots can be found after a
 * restart. `ruleKey` identifies one rule of one trigger node.
 */
export interface ScheduleSlotStore {
  /** the last slot stored for the rule, undefined when none */
  last(ruleKey: string): Promise<Date | undefined>;
  /** store `slot` when it is newer than the stored one; false when another run already claimed it */
  claim(ruleKey: string, slot: Date): Promise<boolean>;
  /** overwrite the stored slot (e.g. with now on a fresh activation) */
  reset(ruleKey: string, slot: Date): Promise<void>;
  /** the instance's misfire grace in seconds (SCHEDULE_MISFIRE_GRACE_S) */
  defaultGraceSeconds: number;
}

/** An address as `dns.lookup` reports it. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** A host resolved once, with every address checked against the SSRF policy. */
export interface AllowedHost {
  /** every address the name resolved to, in resolver order; all of them passed the policy */
  addresses: ResolvedAddress[];
  /**
   * A `lookup` for `net.connect` / `tls.connect` that answers only from `addresses`. The name is
   * never resolved again, and Node's dual-stack and multi-address fallback still works.
   */
  lookup(
    hostname: string,
    options: { all?: boolean; family?: number | string },
    callback: (error: Error | null, address: string | ResolvedAddress[], family?: number) => void,
  ): void;
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
  /** node, output and run the main input `inputIndex` came from; null when this node started the execution */
  getInputSourceData(inputIndex?: number): SourceData | null;
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
  /** notes about this run, stored on the node's task and shown in the output pane */
  addExecutionHints(...hints: NodeExecutionHint[]): void;
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
  /** register a cron job; `slot` is the scheduled time of the tick; returned function unregisters it */
  registerCron(expression: string, onTick: (slot: Date) => void): () => void;
  /**
   * scheduled times of `expression` (workflow timezone) after `after` and before `before`, oldest
   * first, at most `max` (default and ceiling 100)
   */
  getCronSlots(expression: string, after: Date, before: Date, max?: number): Date[];
  /** the slot store for missed schedules; undefined when the workflow is not saved (no id) */
  scheduleSlots?: ScheduleSlotStore;
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
  /** run user JS in the isolated sandbox (Code tool) */
  runCode(options: RunCodeOptions): Promise<unknown>;
  /** call another workflow (Call Workflow tool) */
  executeWorkflow(
    source: ExecuteWorkflowSource,
    items: Item[],
    options?: ExecuteWorkflowOptions,
  ): Promise<{ executionId: string; data: Item[][] | null }>;
  /** record what the sub-node received/returned so the editor can show AI logs */
  logSubNodeRun(input: DataObject, output: DataObject, error?: Error): void;
}

export interface SupplyData {
  response: unknown;
  closeFunction?: () => Promise<void>;
}

export interface WorkflowListQuery {
  /** case-insensitive name filter */
  filter?: string;
  /** `paginationToken` of the previous page */
  paginationToken?: string;
  /** leave this workflow out (the one being edited) */
  excludeId?: string;
}

export interface WorkflowListPage {
  workflows: Array<{ id: string; name: string }>;
  /** set when more workflows follow */
  paginationToken?: string;
}

export interface LoadOptionsContext extends Omit<BaseContext, 'getNodeParameter'> {
  /** current (unsaved) parameter value from the editor */
  getCurrentNodeParameter(name: string): unknown;
  /** the current tenant's workflows, newest first (only where the host stores workflows) */
  listWorkflows?(query: WorkflowListQuery): Promise<WorkflowListPage>;
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
