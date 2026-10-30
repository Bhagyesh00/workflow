/**
 * Services the host (server / worker / tests) provides to an execution.
 * The engine itself is storage-agnostic: persistence, credentials and sub-workflow loading
 * are injected here.
 */
import type {
  BinaryData,
  CredentialType,
  DataObject,
  ExecuteWorkflowOptions,
  ExecuteWorkflowSource,
  ExecutionMode,
  ExecutionResult,
  ExecutionState,
  Item,
  Logger,
  NodeCredentialRef,
  NodeType,
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
  sendChunk?(chunk: unknown): void;
  sendMessageToUI?(nodeName: string, args: unknown[]): void;
}

export interface SubWorkflowRequest {
  source: ExecuteWorkflowSource;
  items: Item[];
  options?: ExecuteWorkflowOptions;
  parent: { executionId: string; workflowId?: string; nodeName: string; tenantId: string };
}

export interface ExecutionLimits {
  expressionTimeoutMs: number;
  expressionMaxSteps: number;
  /** max retries the engine allows for a node */
  maxTries: number;
}

export interface ExecutionServices {
  tenantId: string;
  executionId: string;
  mode: ExecutionMode;
  timezone: string;
  /** tenant variables ($vars) */
  variables: Record<string, string>;
  instanceBaseUrl: string;
  /** used for the Wait node "on webhook call" resume */
  resumeUrl?: string;
  nodeTypes: NodeTypeRegistry;
  credentialTypes: CredentialTypeRegistry;
  credentials: CredentialsProvider;
  binaryData: BinaryDataStore;
  codeRunner: CodeRunner;
  http: import('../http/http-client').HttpClient;
  logger: Logger;
  hooks?: ExecutionHooks;
  limits?: Partial<ExecutionLimits>;
  executeSubWorkflow?(request: SubWorkflowRequest): Promise<{ executionId: string; data: Item[][] | null }>;
}
