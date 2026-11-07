/**
 * OpenAI Responses API, used by the OpenAI node and Azure Foundry. Stub from the Phase 5 S1 contracts
 * step; lane L12 fills it and owns this file, including the rest of the config (built-in tools and
 * the node's options).
 */
import type { DataObject } from '@workflow/workflow';
import type { ChatAdapter } from '../shared/chat-model';

export interface OpenAiResponsesConfig {
  baseUrl: string;
  model: string;
  credentialType: string;
  provider?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
  /** query string of the call; never put a secret here */
  query?: Record<string, string>;
  /** extra body fields, merged last: they win on a collision */
  extraBody?: DataObject;
}

export function openAiResponsesAdapter(_config: OpenAiResponsesConfig): ChatAdapter {
  throw new Error('not implemented (L12)');
}
