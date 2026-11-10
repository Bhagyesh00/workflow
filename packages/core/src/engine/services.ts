/**
 * Services the host (server / worker / tests) provides to an execution.
 * The engine itself is storage-agnostic: persistence, credentials and sub-workflow loading
 * are injected here.
 */
import type {
  BinaryData,
  ChatChunkMeta,
  CredentialGateHelper,
  CredentialType,
  DataObject,
  DataTableAccess,
  ExecuteWorkflowOptions,
  ExecuteWorkflowSource,
  ExecutionMode,
  ExecutionResult,
  ExecutionState,
  FormAuthHelper,
  InstanceLimits,
  Item,
  Logger,
  McpAuthHelper,
  NodeCredentialRef,
  NodeType,
  RunCodeOptions,
  SubWorkflowReport,
  TaskData,
  WebhookResponse,
} from '@workflow/workflow';

export interface NodeTypeRegistry {
  get(type: string): NodeType | undefined;
  list(): NodeType[];
}

export interface CredentialTypeRegistry {
  get(name: string): CredentialType | undefined;
  list(): CredentialType[];
  /** properties of `name` merged with every type it extends (child wins) */
  getResolved(name: string): CredentialType | undefined;
  /** true when `name` is or extends `parent` */
  isA(name: string, parent: string): boolean;
}

export interface CredentialsProvider {
  /** decrypted credential data; must enforce tenant ownership */
  get(ref: NodeCredentialRef, type: string): Promise<DataObject>;
  /** persist refreshed tokens (OAuth2) */
  update(ref: NodeCredentialRef, type: string, data: DataObject): Promise<void>;
}

export interface BinaryDataStore {
  store(
    data: Uint8Array,
    meta: { fileName?: string; mimeType: string; executionId: string },
  ): Promise<BinaryData>;
  getBuffer(binary: BinaryData): Promise<Uint8Array>;
}

export interface CodeRunnerInput {
  code: string;
  mode: 'runOnceForAllItems' | 'runOnceForEachItem';
  items: Item[];
  /** last output (main[0]) of each executed node, for `$('Node')` inside code */
  nodeOutputs: Record<string, Item[]>;
  variables: Record<string, string>;
  workflow: { id?: string; name: string; active: boolean };
  execution: { id: string; mode: string };
  nodeName: string;
  timezone: string;
  onConsole?: (level: string, args: unknown[]) => void;
  signal?: AbortSignal;
  /**
   * copies of the workflow static data for `$getWorkflowStaticData`: `global` is the workflow scope,
   * `node` this node's scope
   */
  staticData?: { global: DataObject; node: DataObject };
  /** called once after a finished run when the code changed the static data, with the new contents */
  onStaticData?(data: { global: DataObject; node: DataObject }): void;
  /** the alias `python` arrives here as `pythonNative` */
  language?: RunCodeOptions['language'];
  /** the Code tool's input (`_query`) */
  query?: unknown;
}

export interface CodeRunner {
  run(input: CodeRunnerInput): Promise<Item[]>;
}

export interface ExecutionHooks {
  workflowExecuteBefore?(state: ExecutionState): Promise<void> | void;
  nodeExecuteBefore?(nodeName: string, runIndex: number): Promise<void> | void;
  nodeExecuteAfter?(
    nodeName: string,
    runIndex: number,
    taskData: TaskData,
    state: ExecutionState,
  ): Promise<void> | void;
  workflowExecuteAfter?(result: ExecutionResult): Promise<void> | void;
  sendResponse?(response: WebhookResponse): void;
  /** a streamed chunk; `meta` names the node run and item that sent it (chat frames read it) */
  sendChunk?(chunk: unknown, meta?: ChatChunkMeta): void;
  sendMessageToUI?(nodeName: string, args: unknown[]): void;
}

export interface SubWorkflowRequest {
  source: ExecuteWorkflowSource;
  items: Item[];
  options?: ExecuteWorkflowOptions;
  parent: { executionId: string; workflowId?: string; nodeName: string; tenantId: string };
}

/** P6 S3 (C0): the property a failed sub-workflow's error carries its report on (n8n: attachSubWorkflowRedaction) */
const SUB_WORKFLOW_REPORT = 'subWorkflowReport';

/**
 * P6 S3 (C0): attaches what a failed child reports (its credentials, its redaction) to the error the caller
 * throws. `createSubWorkflowCaller` takes it off again, so it never lands in the caller's `taskData.error`.
 */
export function attachSubWorkflowReport<E extends Error>(error: E, report: SubWorkflowReport): E {
  Object.defineProperty(error, SUB_WORKFLOW_REPORT, {
    value: report,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** P6 S3 (C0): the report a failed sub-workflow's error carries, removed from the error; undefined when none */
export function takeSubWorkflowReport(error: unknown): SubWorkflowReport | undefined {
  if (!error || typeof error !== 'object' || !Object.hasOwn(error, SUB_WORKFLOW_REPORT)) return undefined;
  const report = (error as Record<string, unknown>)[SUB_WORKFLOW_REPORT] as SubWorkflowReport | undefined;
  delete (error as Record<string, unknown>)[SUB_WORKFLOW_REPORT];
  return report;
}

export interface ExecutionLimits {
  expressionTimeoutMs: number;
  expressionMaxSteps: number;
  /** max retries the engine allows for a node */
  maxTries: number;
  /** items a single node output may contain */
  maxItemsPerOutput: number;
  /** node runs per execution (loop circuit breaker) */
  maxNodeRuns: number;
  /** size of the JSON an agent keeps while its run waits for a tool */
  maxCheckpointBytes?: number;
}

export interface ExecutionServices {
  tenantId: string;
  /** the project the running workflow belongs to (its home project); the run's credentials, variables and data tables come from it */
  projectId: string;
  executionId: string;
  mode: ExecutionMode;
  timezone: string;
  /** tenant variables ($vars) */
  variables: Record<string, string>;
  instanceBaseUrl: string;
  /** used for the Wait node "on webhook call" resume */
  resumeUrl?: string;
  /** used for the Wait node "on form submitted" resume and the Form node */
  resumeFormUrl?: string;
  /** signs the key of a human review's links, so one review's link cannot be edited into another's */
  signReviewKey?(key: string): string;
  nodeTypes: NodeTypeRegistry;
  credentialTypes: CredentialTypeRegistry;
  credentials: CredentialsProvider;
  binaryData: BinaryDataStore;
  codeRunner: CodeRunner;
  /** runs Python code; unset means Python is disabled on this instance */
  pythonRunner?: CodeRunner;
  http: import('../http/http-client').HttpClient;
  logger: Logger;
  hooks?: ExecutionHooks;
  limits?: Partial<ExecutionLimits>;
  /** instance size caps for nodes (`helpers.getInstanceLimits()`); unset fields use the defaults */
  nodeLimits?: Partial<InstanceLimits>;
  /**
   * P6 S3 (C0): a child that ran to its end also returns its `report` (credentials it used, its redaction);
   * a detached call returns none. A failed child throws with the report attached (`attachSubWorkflowReport`).
   */
  executeSubWorkflow?(
    request: SubWorkflowRequest,
  ): Promise<{ executionId: string; data: Item[][] | null; report?: SubWorkflowReport }>;
  /** the data tables of `tenantId` (`helpers.dataTables`) */
  dataTables?: DataTableAccess;
  /** user auth for forms (`getFormAuth()` on the webhook context) */
  formAuth?: FormAuthHelper;
  /** OAuth token checks and execute access for the MCP Server Trigger (`getMcpAuth()` on the webhook context) */
  mcpAuth?: McpAuthHelper;
  /** the credential readiness gate of identity triggers (`getCredentialGate()` on the webhook context, P6-87) */
  credentialGate?: CredentialGateHelper;
  /** runs on every OAuth2 token answer before its `access_token` is read (P6-16 JWE); unset leaves it unchanged */
  oauthTokenDecrypt?: (token: DataObject, data: DataObject) => Promise<DataObject>;
  /** signs and checks the tokens forms hand out (`signFormToken`, `verifyFormToken`) */
  formTokens?: {
    sign(payload: DataObject, ttlSeconds: number): string;
    verify(token: string): DataObject | null;
  };
  /** `DISABLE_PUBLIC_CHAT_TRIGGER`: the Chat Trigger answers no public (production) chat */
  disablePublicChatTrigger?: boolean;
}
