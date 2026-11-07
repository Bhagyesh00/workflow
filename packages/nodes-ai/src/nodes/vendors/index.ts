/** The vendor nodes: one node per AI vendor, each with resources and operations. */
import type { NodeType } from '@workflow/workflow';
import { AlibabaCloudNode } from './alibaba/AlibabaCloud.node';
import { AnthropicNode } from './anthropic/Anthropic.node';
import { DatabricksAiAgentNode } from './databricks/DatabricksAiAgent.node';
import { GoogleGeminiNode } from './gemini/GoogleGemini.node';
import { MinimaxNode } from './minimax/Minimax.node';
import { MoonshotNode } from './moonshot/Moonshot.node';
import { OllamaNode } from './ollama/Ollama.node';
import { OpenAiNode } from './openai/OpenAi.node';

export const vendorNodes: NodeType[] = [
  OpenAiNode,
  AnthropicNode,
  GoogleGeminiNode,
  OllamaNode,
  MoonshotNode,
  AlibabaCloudNode,
  MinimaxNode,
  DatabricksAiAgentNode,
];
