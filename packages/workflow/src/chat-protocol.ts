/**
 * The chat wire protocol shared by the Chat Trigger, the server's chat routes and the chat widget.
 * Types and constants only: no Node API, so the browser widget imports it as is.
 */

/** the signed page token of a hosted chat page; lets `Origin: null` (the sandboxed page) reach the webhook */
export const CHAT_PAGE_HEADER = 'x-chat-page';
/** the one-time token the listen route gives a test chat of a non-public trigger */
export const CHAT_TEST_HEADER = 'x-chat-test-token';
/** the Basic auth token of a chat (HMAC signed, as forms) */
export const CHAT_AUTH_HEADER = 'x-auth-token';

export const CHAT_TRIGGER_TYPE = 'ai.chatTrigger';
/** the tool variant of `ai.chat` (Respond to Chat); a node run as a tool of this type keeps its `sendChunk` */
export const CHAT_TOOL_TYPE = 'ai.chatTool';

/** the `kind` claim of each chat token; a token of one kind is never accepted as another */
export const CHAT_TOKEN_KINDS = {
  page: 'chat-page',
  basic: 'chat-basic',
  user: 'chat-user',
  test: 'chat-test',
} as const;

export type ChatTokenKind = (typeof CHAT_TOKEN_KINDS)[keyof typeof CHAT_TOKEN_KINDS];

/** life of a hosted page token, seconds (60 minutes) */
export const CHAT_PAGE_TOKEN_TTL_S = 3600;
/** life of a one-time test token, seconds */
export const CHAT_TEST_TOKEN_TTL_S = 120;

/** where a streamed chunk came from */
export interface ChatChunkMeta {
  nodeId: string;
  nodeName: string;
  runIndex: number;
  itemIndex: number;
}

export interface ChatFrameMetadata extends ChatChunkMeta {
  /** ms since the epoch */
  timestamp: number;
}

/** one line of a streamed chat reply (newline-delimited JSON) */
export type ChatFrame =
  | { type: 'begin'; metadata: ChatFrameMetadata }
  | { type: 'item'; content: string; metadata: ChatFrameMetadata }
  | { type: 'end'; metadata: ChatFrameMetadata }
  | { type: 'error'; content: string; message: string; metadata?: ChatFrameMetadata }
  | { type: 'wait'; resumeUrl: string };

/** what the hosted chat page hands the widget */
export interface ChatPageConfig {
  webhookUrl: string;
  /** signed page token, sent back in `CHAT_PAGE_HEADER` */
  pageToken: string;
  /** Basic auth token, sent back in `CHAT_AUTH_HEADER` */
  authToken?: string;
  title: string;
  subtitle: string;
  inputPlaceholder: string;
  getStarted: string;
  initialMessages: string[];
  showWelcomeScreen: boolean;
  loadPreviousSession: boolean;
  allowFileUploads: boolean;
  /** comma-separated MIME types, `*` for any */
  allowedFilesMimeTypes: string;
  enableStreaming: boolean;
  customCss: string;
}

/** how a chat run answers: the last node's output, a stream, one Respond to Chat node, or every Respond to Chat node */
export type ChatResponseMode = 'lastNode' | 'streaming' | 'responseNode' | 'responseNodes';
