/**
 * Cohere v2 chat API. Stub from the Phase 5 S1 contracts step; lane L16 fills it and owns this file.
 */
import type { ChatAdapter } from '../shared/chat-model';

export interface CohereChatConfig {
  /** from the credential: a custom URL is honoured */
  baseUrl: string;
  model: string;
  credentialType?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export function cohereAdapter(_config: CohereChatConfig): ChatAdapter {
  throw new Error('not implemented (L16)');
}
