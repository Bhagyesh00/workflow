/**
 * Contracts for AI cluster nodes. Root nodes (AI Agent, chains) receive these objects from
 * sub-nodes through `ctx.getInputConnectionData(<ai_* connection type>, itemIndex)`.
 * Provider-neutral on purpose: no SDK types leak into the contract.
 */
import type { DataObject } from './interfaces';
import type { McpCallResult } from './mcp-protocol';

export type JsonSchema = DataObject;

export interface AiTextPart {
  type: 'text';
  text: string;
}

export interface AiImagePart {
  type: 'image';
  /** base64 without data: prefix */
  data: string;
  mimeType: string;
  /** how closely an OpenAI model looks at the image; 'auto' sends nothing, other providers ignore it */
  detail?: 'auto' | 'low' | 'high';
}

export interface AiFilePart {
  type: 'file';
  /** base64 without data: prefix */
  data: string;
  mimeType: string;
  fileName?: string;
}

export type AiContentPart = AiTextPart | AiImagePart | AiFilePart;

export interface AiToolCall {
  id: string;
  name: string;
  arguments: DataObject;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | AiContentPart[];
  /** assistant messages requesting tool calls */
  toolCalls?: AiToolCall[];
  /** tool result messages */
  toolCallId?: string;
  name?: string;
  /** stored in memory but not shown in the chat UI (Chat Memory Manager insert) */
  hideFromUI?: boolean;
}

export interface AiToolDefinition {
  /** [a-zA-Z0-9_-]{1,64} */
  name: string;
  description: string;
  /** JSON schema of the arguments object */
  parameters: JsonSchema;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  tools?: AiToolDefinition[];
  /** 'any': the model must call one of `tools` */
  toolChoice?: 'any';
  /** force JSON output (structured output parsers) */
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: JsonSchema };
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AiChatResponse {
  message: AiChatMessage;
  usage?: AiUsage;
  stopReason?: 'end' | 'tool_calls' | 'max_tokens' | 'other';
  /** provider-reported model id */
  model?: string;
}

export interface AiChatModel {
  readonly kind: 'chatModel';
  readonly provider: string;
  readonly model: string;
  /** a completion-only model: it takes a prompt and has no chat or tool calls */
  completion?: boolean;
  /** name of the sub-node that supplied this model */
  nodeName?: string;
  chat(request: AiChatRequest): Promise<AiChatResponse>;
  /** optional token streaming; yields text deltas and resolves with the final response */
  stream?(request: AiChatRequest, onDelta: (text: string) => void): Promise<AiChatResponse>;
}

export interface AiTool extends AiToolDefinition {
  readonly kind: 'tool';
  /** the tool can stop the run to wait (it may throw `ToolSuspension`) */
  canWait?: boolean;
  invoke(args: DataObject, options?: { signal?: AbortSignal; toolCallId?: string }): Promise<unknown>;
  /**
   * A tool that keeps a server's content array (an MCP Client tool): the raw MCP result instead of
   * the flattened text `invoke` gives. The MCP Server Trigger prefers it when present.
   */
  invokeRaw?(
    args: DataObject,
    options?: { signal?: AbortSignal; toolCallId?: string },
  ): Promise<McpCallResult>;
}

export interface AiMemory {
  readonly kind: 'memory';
  /** the history the model sees (may be windowed) */
  load(sessionId: string): Promise<AiChatMessage[]>;
  /** the full stored history, oldest first, never windowed */
  loadAll(sessionId: string): Promise<AiChatMessage[]>;
  append(sessionId: string, messages: AiChatMessage[]): Promise<void>;
  /** rewrite the whole stored history; one atomic rewrite where the store allows it */
  replace(sessionId: string, messages: AiChatMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export interface AiDocument {
  pageContent: string;
  metadata: DataObject;
}

export interface AiEmbeddings {
  readonly kind: 'embeddings';
  readonly dimensions?: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface AiVectorStore {
  readonly kind: 'vectorStore';
  addDocuments(documents: AiDocument[]): Promise<void>;
  similaritySearch(
    query: string,
    k: number,
    filter?: DataObject,
  ): Promise<Array<{ document: AiDocument; score: number }>>;
}

export interface AiOutputParser {
  readonly kind: 'outputParser';
  /** appended to the prompt */
  getFormatInstructions(): string;
  /** JSON schema when the parser wants native structured output */
  schema?: JsonSchema;
  parse(text: string): Promise<unknown>;
}

export interface AiTextSplitter {
  readonly kind: 'textSplitter';
  split(text: string): Promise<string[]>;
}

export interface AiDocumentLoader {
  readonly kind: 'documentLoader';
  load(
    items: Array<{ json: DataObject; binary?: Record<string, { data: string; mimeType: string }> }>,
  ): Promise<AiDocument[]>;
}

export interface AiRetriever {
  readonly kind: 'retriever';
  retrieve(query: string): Promise<AiDocument[]>;
}

export interface AiReranker {
  readonly kind: 'reranker';
  /** best first, already cut to the node's Top N */
  rerank(
    query: string,
    documents: AiDocument[],
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ document: AiDocument; score: number }>>;
}
