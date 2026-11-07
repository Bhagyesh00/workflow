/**
 * AWS Bedrock Converse API. Stub from the Phase 5 S1 contracts step; lane L11 fills it and owns this
 * file, including the rest of the config (guardrail, performance, additional request fields).
 */
import type { ChatAdapter } from '../shared/chat-model';

export interface BedrockChatConfig {
  region: string;
  /** a model id, inference profile id or ARN */
  model: string;
  credentialType?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export function bedrockAdapter(_config: BedrockChatConfig): ChatAdapter {
  throw new Error('not implemented (L11)');
}
