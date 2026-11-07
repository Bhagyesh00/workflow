/**
 * Every chat model sub-node. Each supplies an `AiChatModel` (provider-neutral) to agents and chains.
 * All HTTP goes through `ctx.helpers.httpRequestWithAuthentication`, so credentials are applied
 * by their credential type and the SSRF guard covers every call.
 */
import type { NodeType } from '@workflow/workflow';
import { LmChatAnthropicNode } from './LmChatAnthropic.node';
import { LmChatAwsBedrockNode } from './LmChatAwsBedrock.node';
import { LmChatAzureOpenAiNode } from './LmChatAzureOpenAi.node';
import { LmChatCohereNode } from './LmChatCohere.node';
import { LmChatGoogleGeminiNode } from './LmChatGoogleGemini.node';
import { LmChatGoogleVertexNode } from './LmChatGoogleVertex.node';
import { LmChatMistralCloudNode } from './LmChatMistralCloud.node';
import { LmChatOllamaNode } from './LmChatOllama.node';
import { LmChatOpenAiNode } from './LmChatOpenAi.node';
import { LmChatOpenAiCompatibleNode } from './LmChatOpenAiCompatible.node';
import { ModelSelectorNode } from './ModelSelector.node';
import { openAiPresetNodes } from './openai-presets.nodes';
import { textCompletionNodes } from './text-completion.nodes';

export const chatModelNodes: NodeType[] = [
  LmChatOpenAiNode,
  LmChatAnthropicNode,
  LmChatGoogleGeminiNode,
  LmChatOllamaNode,
  LmChatOpenAiCompatibleNode,
  LmChatAwsBedrockNode,
  LmChatAzureOpenAiNode,
  LmChatGoogleVertexNode,
  LmChatMistralCloudNode,
  LmChatCohereNode,
  ...openAiPresetNodes,
  ...textCompletionNodes,
  ModelSelectorNode,
];
