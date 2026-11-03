/**
 * Core data model shared by the engine (server), node implementations and the editor (browser).
 * Everything in here must stay isomorphic: no Node.js-only types (use Uint8Array, not Buffer).
 *
 * The workflow JSON shape (nodes keyed by name in `connections`) is intentionally close to the
 * de-facto format used by node-graph automation tools so that imported workflows map cleanly.
 */

// ---------------------------------------------------------------------------------------------
// Generic data
// ---------------------------------------------------------------------------------------------

export type DataObject = Record<string, unknown>;

export type GenericValue = string | number | boolean | null | undefined | object;

// ---------------------------------------------------------------------------------------------
// Items: the unit of data flowing between nodes
// ---------------------------------------------------------------------------------------------

export interface BinaryData {
  /** base64 payload when stored inline; empty when `id` references the binary data store */
  data: string;
  /** reference into the binary data store, e.g. `fs:<tenant>/<execution>/<uuid>` or `s3:...` */
  id?: string;
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  fileType?: 'text' | 'json' | 'image' | 'audio' | 'video' | 'pdf' | 'html';
  fileSize?: number;
  directory?: string;
}

export interface PairedItem {
  /** index of the input item this output item was derived from */
  item: number;
  /** input index (for nodes with several inputs), default 0 */
  input?: number;
  /** the source the item refers to when it is not the current run's input (items a loop carries over from an earlier run) */
  sourceOverwrite?: SourceData;
}

export interface ItemError {
  message: string;
  description?: string;
  name?: string;
  httpCode?: string;
  [key: string]: unknown;
}

export interface Item {
  json: DataObject;
  binary?: Record<string, BinaryData>;
  pairedItem?: PairedItem | PairedItem[] | number;
  error?: ItemError;
}

/** Output of a node: one array of items per output index. `null` means "stop this branch". */
export type NodeOutput = Item[][] | null;

// ---------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------

export const ConnectionTypes = {
  Main: 'main',
  AiLanguageModel: 'ai_languageModel',
  AiTool: 'ai_tool',
  AiMemory: 'ai_memory',
  AiOutputParser: 'ai_outputParser',
  AiEmbedding: 'ai_embedding',
  AiVectorStore: 'ai_vectorStore',
  AiDocument: 'ai_document',
  AiTextSplitter: 'ai_textSplitter',
  AiRetriever: 'ai_retriever',
} as const;

export type ConnectionType = (typeof ConnectionTypes)[keyof typeof ConnectionTypes];

export interface Connection {
  /** destination node name */
  node: string;
  type: ConnectionType;
  /** destination input index */
  index: number;
}

/** connections[type][outputIndex] = list of destinations */
export type NodeConnections = Partial<Record<ConnectionType, Array<Connection[] | null>>>;

/** keyed by SOURCE node name */
export type Connections = Record<string, NodeConnections>;

// ---------------------------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------------------------

export type NodeParameters = Record<string, unknown>;

export type OnErrorBehavior = 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';

export interface NodeCredentialRef {
  id: string | null;
  name: string;
}

export interface WorkflowNode {
  /** stable id (uuid) */
  id: string;
  /** unique per workflow, user visible, used by expressions: $('Name') */
  name: string;
  /** node type id, e.g. `core.httpRequest` */
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: NodeParameters;
  credentials?: Record<string, NodeCredentialRef>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  /** milliseconds */
  waitBetweenTries?: number;
  /** `exponential` doubles the wait each attempt (with jitter) and honours `Retry-After` */
  retryBackoff?: 'fixed' | 'exponential';
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  onError?: OnErrorBehavior;
  /** stable id used to build default webhook paths */
  webhookId?: string;
  color?: string;
}

export interface StickyNote {
  id: string;
  content: string;
  position: [number, number];
  width: number;
  height: number;
  color?: string;
}

export type CallerPolicy = 'any' | 'none' | 'sameProject' | 'allowList';

export interface WorkflowSettings {
  executionOrder?: 'v1';
  /** IANA timezone, falls back to tenant default */
  timezone?: string;
  /** workflow id to run when this workflow fails */
  errorWorkflow?: string;
  saveDataErrorExecution?: 'all' | 'none';
  saveDataSuccessExecution?: 'all' | 'none';
  saveManualExecutions?: boolean;
  /** persist run data after every node so crashed executions can be resumed */
  saveExecutionProgress?: boolean;
  /** seconds; 0 / undefined = tenant default */
  executionTimeout?: number;
  callerPolicy?: CallerPolicy;
  callerIds?: string[];
}

export interface WorkflowDefinition {
  id?: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  /** pinned output per node name (used instead of executing the node in manual runs) */
  pinData?: Record<string, Item[]>;
  staticData?: DataObject;
  stickyNotes?: StickyNote[];
  active?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Node type descriptions (serializable; shipped to the editor)
// ---------------------------------------------------------------------------------------------

export type NodeGroup = 'trigger' | 'transform' | 'input' | 'output' | 'organization' | 'schedule';

export type NodePropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'multiOptions'
  | 'collection'
  | 'fixedCollection'
  | 'json'
  | 'color'
  | 'dateTime'
  | 'notice'
  | 'hidden'
  | 'credentialsSelect'
  | 'resourceLocator'
  | 'filter'
  | 'assignmentCollection'
  | 'code'
  | 'button';

export interface DisplayOptions {
  /** parameter name -> allowed values. `@version` matches node typeVersion. `/name` = root-level param */
  show?: Record<string, unknown[]>;
  hide?: Record<string, unknown[]>;
}

export interface NodePropertyOption {
  name: string;
  value: string | number | boolean;
  description?: string;
  /** short verb phrase used in the node creator, e.g. "Send a message" */
  action?: string;
}

export interface NodePropertyCollection {
  displayName: string;
  name: string;
  values: NodeProperty[];
}

export interface ResourceLocatorMode {
  displayName: string;
  name: 'list' | 'id' | 'url' | string;
  type: 'list' | 'string';
  placeholder?: string;
  typeOptions?: { searchListMethod?: string; searchable?: boolean };
  /** regex used to extract the id from a URL in `url` mode */
  extractValue?: { type: 'regex'; regex: string };
}

export interface ResourceLocatorValue {
  __rl: true;
  mode: string;
  value: string;
  cachedResultName?: string;
  cachedResultUrl?: string;
}

export interface NodePropertyTypeOptions {
  rows?: number;
  password?: boolean;
  minValue?: number;
  maxValue?: number;
  numberPrecision?: number;
  multipleValues?: boolean;
  multipleValueButtonText?: string;
  sortable?: boolean;
  editor?: 'codeNodeEditor' | 'jsEditor' | 'sqlEditor' | 'htmlEditor' | 'jsonEditor';
  editorLanguage?: 'javaScript' | 'python' | 'sql' | 'json' | 'html';
  /** name of a `methods.loadOptions` entry */
  loadOptionsMethod?: string;
  loadOptionsDependsOn?: string[];
  alwaysOpenEditWindow?: boolean;
}

export interface NodeProperty {
  displayName: string;
  name: string;
  type: NodePropertyType;
  default: unknown;
  description?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  /** expressions not allowed for this parameter */
  noDataExpression?: boolean;
  options?: Array<NodePropertyOption | NodeProperty | NodePropertyCollection>;
  displayOptions?: DisplayOptions;
  typeOptions?: NodePropertyTypeOptions;
  /** for `resourceLocator` */
  modes?: ResourceLocatorMode[];
  /** shown in the node settings tab rather than the parameters tab */
  isNodeSetting?: boolean;
}

export interface NodeInputConfig {
  type: ConnectionType;
  displayName?: string;
  required?: boolean;
  maxConnections?: number;
}

export interface NodeOutputConfig {
  type: ConnectionType;
  displayName?: string;
  /** visual category, e.g. error output */
  category?: 'error';
}

export interface NodeCredentialDescription {
  /** credential type name */
  name: string;
  required?: boolean;
  displayOptions?: DisplayOptions;
}

export interface WebhookDescription {
  name: 'default' | 'setup' | string;
  /** fixed method or expression, e.g. `={{$parameter["httpMethod"]}}` */
  httpMethod: string;
  /** fixed path or expression; relative paths are prefixed with the node's webhookId */
  path: string;
  /** `onReceived` | `lastNode` | `responseNode` | `streaming` or expression */
  responseMode?: string;
  /** `allEntries` | `firstEntryJson` | `firstEntryBinary` | `noData` or expression */
  responseData?: string;
  /** Wait-node style resume webhook: `/webhook-waiting/<executionId>` */
  restartWebhook?: boolean;
  /** path is used verbatim, not prefixed with webhookId */
  isFullPath?: boolean;
  /** hide URL panel in the editor */
  ndvHideUrl?: boolean;
}

/** value of a `filter` parameter (IF / Filter / Switch conditions) */
export type FilterOperatorType = 'string' | 'number' | 'boolean' | 'dateTime' | 'array' | 'object' | 'any';

export type FilterOperation =
  | 'exists'
  | 'notExists'
  | 'empty'
  | 'notEmpty'
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'notStartsWith'
  | 'endsWith'
  | 'notEndsWith'
  | 'regex'
  | 'notRegex'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'after'
  | 'afterOrEquals'
  | 'before'
  | 'beforeOrEquals'
  | 'true'
  | 'false'
  | 'lengthEquals'
  | 'lengthNotEquals'
  | 'lengthGt'
  | 'lengthGte'
  | 'lengthLt'
  | 'lengthLte';

export interface FilterCondition {
  id: string;
  leftValue: unknown;
  rightValue?: unknown;
  operator: {
    type: FilterOperatorType;
    operation: FilterOperation;
    /** operation takes no right value (exists, empty, true, ...) */
    singleValue?: boolean;
  };
}

export interface FilterValue {
  conditions: FilterCondition[];
  combinator: 'and' | 'or';
  options?: { caseSensitive?: boolean; typeValidation?: 'strict' | 'loose' };
}

/** value of an `assignmentCollection` parameter (Edit Fields) */
export interface AssignmentValue {
  id: string;
  name: string;
  value: unknown;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
}

export interface AssignmentCollectionValue {
  assignments: AssignmentValue[];
}

export interface NodeTypeDescription {
  /** globally unique type id, e.g. `core.httpRequest`, `slack.slack` */
  name: string;
  displayName: string;
  description: string;
  /** `lucide:<icon-name>`, `simple:<simple-icons-slug>`, or a data: URI */
  icon?: string;
  iconColor?: string;
  group: NodeGroup[];
  /** supported type versions; latest is the max */
  version: number | number[];
  defaults: { name: string; color?: string };
  /** static list or an expression evaluated against `$parameter` (for dynamic ports) */
  inputs: Array<ConnectionType | NodeInputConfig> | string;
  outputs: Array<ConnectionType | NodeOutputConfig> | string;
  outputNames?: string[];
  credentials?: NodeCredentialDescription[];
  properties: NodeProperty[];
  webhooks?: WebhookDescription[];
  /** node implements `poll()` — engine adds a "Poll times" setting */
  polling?: boolean;
  /** canvas subtitle expression */
  subtitle?: string;
  /** node creator categories, e.g. ['Core'], ['AI', 'Agents'], ['Communication'] */
  categories?: string[];
  /** extra search keywords */
  alias?: string[];
  /** hide from node creator (internal / deprecated) */
  hidden?: boolean;
  /** max instances per workflow */
  maxNodes?: number;
  /** may be attached to an AI agent as a tool */
  usableAsTool?: boolean;
  documentationUrl?: string;
  /** shown on the trigger panel while waiting for a test event */
  eventTriggerDescription?: string;
  activationMessage?: string;
}

// ---------------------------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------------------------

export interface GenericAuthentication {
  type: 'generic';
  properties: {
    headers?: Record<string, string>;
    qs?: Record<string, string>;
    body?: Record<string, string>;
    auth?: { username: string; password: string };
  };
}

export interface CredentialTestRequest {
  request: HttpRequestOptions;
  /** optional checks on the response */
  rules?: Array<{ type: 'responseCode'; value: number; message: string }>;
}

export interface CredentialType {
  name: string;
  displayName: string;
  icon?: string;
  documentationUrl?: string;
  /** inherit properties/behaviour, e.g. ['oAuth2Api'] */
  extends?: string[];
  properties: NodeProperty[];
  /** values in headers/qs may use `={{$credentials.apiKey}}` */
  authenticate?:
    | GenericAuthentication
    | ((credentials: DataObject, request: HttpRequestOptions) => Promise<HttpRequestOptions>);
  test?: CredentialTestRequest;
  /** e.g. exchange a key for a short-lived session token before requests */
  preAuthentication?: (credentials: DataObject) => Promise<DataObject>;
  /** true: the "Allowed HTTP Request Domains" fields are not added to this type */
  hideDomainRestrictionFields?: boolean;
}

/** what the editor receives (functions stripped) */
export type CredentialTypeDescription = Omit<CredentialType, 'authenticate' | 'preAuthentication'> & {
  hasAuthenticate: boolean;
  isOAuth2: boolean;
  /** the type is or extends oAuth1Api (the editor shows Connect) */
  isOAuth1?: boolean;
};

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface HttpRequestOptions {
  url: string;
  method?: HttpMethod;
  /** a list sends the header once per value */
  headers?: Record<string, string | string[]>;
  qs?: Record<string, unknown>;
  body?: unknown;
  /** how to encode `body`: default `json` when body is an object */
  bodyType?: 'json' | 'form-urlencoded' | 'multipart' | 'raw';
  /**
   * response parsing: `json` (default when content-type is json), `text`, `arraybuffer`, or `stream`
   * for an `HttpResponseStream` that is read while it arrives (non-2xx responses still throw)
   */
  responseType?: 'json' | 'text' | 'arraybuffer' | 'auto' | 'stream';
  /** return { body, headers, statusCode, statusMessage } instead of only the body */
  returnFullResponse?: boolean;
  /** milliseconds */
  timeout?: number;
  /** do not throw on non-2xx */
  ignoreHttpStatusErrors?: boolean;
  /** `scheme` defaults to `basic`; `digest` answers a 401 Digest challenge with one retry */
  auth?: { username: string; password: string; scheme?: 'basic' | 'digest' };
  /**
   * hosts the credential may be sent to (first URL and every redirect hop are checked);
   * undefined = unrestricted
   */
  allowedDomains?: string[];
  /**
   * `userUrl`: the URL was typed by the user (HTTP Request, GraphQL, HTTP Request Tool, MCP Client Tool),
   * so the credential's `none` domain mode applies
   */
  credentialScope?: 'userUrl';
  skipSslCertificateValidation?: boolean;
  followRedirects?: boolean;
  maxRedirects?: number;
}

/**
 * The body of a `responseType: 'stream'` response, chunk by chunk as it arrives. The size limit,
 * timeout and abort signal of the request apply while it is read; stopping early closes the connection.
 */
export type HttpResponseStream = AsyncIterable<Uint8Array>;

export interface HttpFullResponse<T = unknown> {
  body: T;
  headers: Record<string, string>;
  statusCode: number;
  statusMessage: string;
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

export type ExecutionMode =
  | 'manual'
  | 'trigger'
  | 'webhook'
  | 'internal'
  | 'retry'
  | 'integrated'
  | 'cli'
  | 'evaluation'
  | 'chat'
  | 'error';

export type ExecutionStatus = 'new' | 'running' | 'success' | 'error' | 'canceled' | 'waiting' | 'crashed';

export interface SourceData {
  previousNode: string;
  previousNodeOutput?: number;
  previousNodeRun?: number;
}

export type TaskDataConnections = Partial<Record<ConnectionType, Array<Item[] | null>>>;

export interface ExecutionErrorShape {
  name: string;
  message: string;
  description?: string;
  /** stable machine-readable code from the error catalogue, e.g. `HTTP_401`, `EXPRESSION_REFERENCE` */
  code?: string;
  /** plain-language suggestion for fixing the error */
  hint?: string;
  node?: string;
  itemIndex?: number;
  parameter?: string;
  /** summary of the failing HTTP call (no query string, no secrets) */
  request?: { method: string; url: string };
  response?: { statusCode?: number; body?: string };
  httpCode?: string;
  stack?: string;
  timestamp?: number;
  context?: DataObject;
}

/** a note about a node run, shown in the output pane */
export interface NodeExecutionHint {
  message: string;
  level?: 'info' | 'warning';
}

export interface TaskData {
  startTime: number;
  executionTime: number;
  executionStatus: ExecutionStatus;
  /** node outputs */
  data?: TaskDataConnections;
  /** inputs, recorded for sub-nodes (AI) whose inputs are not visible from graph */
  inputOverride?: TaskDataConnections;
  error?: ExecutionErrorShape;
  source: Array<SourceData | null>;
  hints?: NodeExecutionHint[];
  metadata?: {
    subExecution?: { executionId: string; workflowId?: string };
    /** retry attempt that produced this result (1-based) */
    attempt?: number;
    [key: string]: unknown;
  };
}

export type RunData = Record<string, TaskData[]>;

export interface ExecuteData {
  /** node name */
  node: string;
  /** inputs per connection type */
  data: TaskDataConnections;
  source: { main: Array<SourceData | null> } | null;
}

/** waiting[nodeName][runIndex] = inputs collected so far (multi-input nodes) */
export type WaitingExecution = Record<string, Record<number, TaskDataConnections>>;
export type WaitingExecutionSource = Record<string, Record<number, { main: Array<SourceData | null> }>>;

/** Fully serializable execution state: persisted for wait/resume and for queue workers. */
export interface ExecutionState {
  startData: {
    /** run only up to (and including) this node (manual partial execution) */
    destinationNode?: string;
    /** restrict execution to these nodes */
    runNodeFilter?: string[];
  };
  resultData: {
    runData: RunData;
    pinData?: Record<string, Item[]>;
    lastNodeExecuted?: string;
    error?: ExecutionErrorShape;
    /** user-set custom data, searchable in the executions list */
    customData?: Record<string, string>;
  };
  executionData: {
    nodeExecutionStack: ExecuteData[];
    waitingExecution: WaitingExecution;
    waitingExecutionSource: WaitingExecutionSource;
    /** per-node context data (e.g. Loop Over Items progress) */
    contextData: Record<string, DataObject>;
    /** inputs of the node that stopped the execution; enables "retry from failed node" */
    failedExecuteData?: ExecuteData;
  };
  /** ISO date when a waiting execution should resume */
  waitTill?: string;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  state: ExecutionState;
  startedAt: number;
  stoppedAt: number;
  /** output of the last executed node (used by sub-workflows and webhook "lastNode" responses) */
  lastNodeOutput?: Item[][] | null;
}
