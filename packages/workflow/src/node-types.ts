/**
 * Contracts between the execution engine and node implementations.
 * Implementations of these contexts live in `@workflow/core`.
 */
import type { DataTableAccess } from './data-tables';
import type {
  BinaryData,
  ConnectionType,
  CredentialAuthHelpers,
  CredentialType,
  DataObject,
  ExecutionMode,
  ExecutionStatus,
  HttpFullResponse,
  HttpRequestOptions,
  Item,
  NodeExecutionHint,
  NodeOutput,
  NodePropertyOption,
  NodeTypeDescription,
  PairedItem,
  ResourceMapperFields,
  SourceData,
  WorkflowDefinition,
  WorkflowNode,
} from './interfaces';
import type { ToolResumeData, ToolSuspension } from './tool-suspension';

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
  /** the tenant's data tables; undefined where the host stores none */
  dataTables?: DataTableAccess;
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
  /** total bytes of input binary an Agent may pass to the model */
  maxPassthroughBinaryBytes: number;
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
  /** run user code in the isolated sandbox */
  runCode(options: RunCodeOptions): Promise<unknown>;
  /** merged into the metadata of this node's task (TaskData.metadata) */
  setMetadata(data: DataObject): void;
  /** every node upstream of this one over main connections, nearest first */
  getParentNodes(): ConnectedNode[];
  /** every node downstream of this one over main connections, nearest first */
  getChildNodes(): ConnectedNode[];
  /** stop the run until a waiting tool answers; `checkpoint` comes back through `getResumeData` */
  suspendForTool(suspension: ToolSuspension, checkpoint: DataObject): void;
  /** set on the run after `suspendForTool`, undefined otherwise */
  getResumeData(): ToolResumeData | undefined;
  /** a parameter of this node, with `$fromAI` bound to `args` */
  getToolParameter(name: string, itemIndex: number, args: DataObject): unknown;
}

/** a node reached through the workflow graph */
export interface ConnectedNode {
  name: string;
  type: string;
}

export interface RunCodeOptions {
  code: string;
  mode: 'runOnceForAllItems' | 'runOnceForEachItem';
  itemIndex?: number;
  /**
   * The Code node maps its alias `python` to `pythonNative`. ai.toolCode stores n8n's value `python`
   * and maps it to `pythonNative` in this call; the engine also accepts a stored `python` at run time.
   */
  language?: 'javaScript' | 'pythonNative';
  /** the Code tool's input, `_query` in Python */
  query?: unknown;
}

/** how the run a trigger started ended */
export interface TriggerRunResult {
  executionId: string;
  status: ExecutionStatus;
  error?: string;
}

export interface TriggerContext extends BaseContext {
  /**
   * Start a run with `data`. Our 2nd = n8n's donePromise (run result, as today), our 3rd = n8n's
   * responsePromise / sendResponse hook.
   */
  emit(
    data: Item[][],
    responsePromise?: { resolve(r: TriggerRunResult): void; reject(e: Error): void },
    responseHook?: (r: WebhookResponse) => void,
  ): void;
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
  /** the path and query the caller asked for */
  url?: string;
  /** the caller came over https; a proxy's word counts only when the server trusts proxies */
  secure?: boolean;
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
  /** every node upstream of this one over main connections, nearest first */
  getParentNodes(): ConnectedNode[];
  /** every node downstream of this one over main connections, nearest first */
  getChildNodes(): ConnectedNode[];
  /** `$execution.resumeFormUrl` of the execution this webhook belongs to; undefined when none */
  getResumeFormUrl(): string | undefined;
  /** the bytes of stored binary data; webhook requests have no input items to read them from */
  getBinaryBuffer(binary: BinaryData): Promise<Uint8Array>;
  /** a signed token that holds `payload` for `ttlSeconds`; throws where the host has no signer */
  signFormToken(payload: DataObject, ttlSeconds: number): string;
  /** the payload of a valid token; null when it is forged, expired, or the host has no signer */
  verifyFormToken(token: string): DataObject | null;
  /** n8n user auth for forms; undefined where the host has none */
  getFormAuth(): FormAuthHelper | undefined;
}

/** the signed-in user a form hands to the workflow (n8n's four output fields) */
export interface FormUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface FormAuthHelper {
  /** where to send a visitor with no session; `returnTo` comes back after sign-in */
  signInUrl(returnTo: string): string;
  /** trade a one-time code for a form-auth token; null when the code is not valid */
  exchangeCode(code: string): Promise<string | null>;
  verifyToken(token: string): Promise<FormUser | null>;
  /** whether the user may run this workflow */
  canExecute(userId: string, workflowId: string): Promise<boolean>;
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
  /** a parameter of this node, with `$fromAI` bound to `args` */
  getToolParameter(name: string, itemIndex: number, args: DataObject): unknown;
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
  /** one of the current tenant's workflows, undefined when it has no such workflow */
  readWorkflow?(id: string): Promise<WorkflowDefinition | undefined>;
}

export interface ListSearchResult {
  results: Array<{ name: string; value: string; url?: string }>;
  paginationToken?: string;
}

/** what a credential test may do: check hosts and connect through them, nothing that needs an execution */
export interface CredentialTestContext {
  helpers: Pick<NodeHelpers, 'resolveAllowedHost' | 'assertHostAllowed'> & {
    /** the guarded client and token helpers, with the credential's allowed domains and this test's signal */
    auth?: CredentialAuthHelpers;
  };
  logger: Logger;
  signal: AbortSignal;
  getTenantId(): string;
}

export interface NodeCredentialTestResult {
  status: 'OK' | 'Error';
  message: string;
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
    /** named by `typeOptions.resourceMapper.resourceMapperMethod` */
    resourceMapping?: Record<string, (ctx: LoadOptionsContext) => Promise<ResourceMapperFields>>;
    /** named by `testedBy` on the node's credential description; `credential.data` is decrypted */
    credentialTest?: Record<
      string,
      (
        ctx: CredentialTestContext,
        credential: { type: string; data: DataObject },
      ) => Promise<NodeCredentialTestResult>
    >;
  };
}

/** a package of nodes + credentials (built-in or community) */
export interface NodePackage {
  name: string;
  nodes: NodeType[];
  credentials: CredentialType[];
}
