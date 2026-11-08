import type { CredentialType, NodePackage, NodeType } from '@workflow/workflow';
import { aiCredentials } from './credentials/ai.credentials';
import { AgentNode } from './nodes/agent/Agent.node';
import { AgentToolNode } from './nodes/agent/AgentTool.node';
import { llmChainNodes } from './nodes/chains/llm-chains.nodes';
import { ragChainNodes } from './nodes/chains/rag-chains.nodes';
import { DocumentDefaultDataLoaderNode } from './nodes/document-loaders/DocumentDefaultDataLoader.node';
import { embeddingsNodes } from './nodes/embeddings/embeddings.nodes';
import { GuardrailsNode } from './nodes/guardrails/Guardrails.node';
import { memoryNodes } from './nodes/memory/memory.nodes';
import { chatModelNodes } from './nodes/models/chat-models.nodes';
import { outputParserNodes } from './nodes/output-parsers/output-parsers.nodes';
import { RerankerCohereNode } from './nodes/rerankers/RerankerCohere.node';
import { retrieverNodes } from './nodes/retrievers/retrievers.nodes';
import { textSplitterNodes } from './nodes/text-splitters/text-splitters.nodes';
import { McpClientNode } from './nodes/tools/McpClient.node';
import { McpClientToolNode } from './nodes/tools/McpClientTool.node';
import { toolNodes } from './nodes/tools/tools.nodes';
import { ChatNode } from './nodes/trigger/Chat.node';
import { ChatTriggerNode } from './nodes/trigger/ChatTrigger.node';
import { McpTriggerNode } from './nodes/trigger/McpTrigger.node';
import { vectorStoreNodes } from './nodes/vector-stores/vector-stores.nodes';
import { vendorNodes } from './nodes/vendors';

export const nodes: NodeType[] = [
  AgentNode,
  AgentToolNode,
  GuardrailsNode,
  ...llmChainNodes,
  ...ragChainNodes,
  ...retrieverNodes,
  ChatTriggerNode,
  ChatNode,
  McpTriggerNode,
  ...chatModelNodes,
  ...memoryNodes,
  ...toolNodes,
  McpClientToolNode,
  McpClientNode,
  ...embeddingsNodes,
  ...vectorStoreNodes,
  RerankerCohereNode,
  DocumentDefaultDataLoaderNode,
  ...textSplitterNodes,
  ...outputParserNodes,
  ...vendorNodes,
];

export const credentials: CredentialType[] = aiCredentials;

export const nodesAiPackage: NodePackage = { name: '@workflow/nodes-ai', nodes, credentials };

export { type AgentResult, type AgentRunOptions, runAgent } from './nodes/agent/agent-loop';
export { ANTHROPIC_API_VERSION, ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic';
export { batchingOption, runInBatches } from './shared/batching';
export { type ChatModelCapabilities, capabilitiesOf, HttpChatModel } from './shared/chat-model';
export { databricksGatewayUrl } from './shared/databricks';
export { validateJsonSchema } from './shared/json-schema';
export { McpClient } from './shared/mcp-client';
export { createMcpConnection, type McpConnectionInput } from './shared/mcp-connect';
export { redactSecrets } from './shared/utils';
