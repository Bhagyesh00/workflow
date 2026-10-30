import type { CredentialType, NodePackage, NodeType } from '@workflow/workflow';
import { aiCredentials } from './credentials/ai.credentials';
import { AgentNode } from './nodes/agent/Agent.node';
import { llmChainNodes } from './nodes/chains/llm-chains.nodes';
import { ragChainNodes } from './nodes/chains/rag-chains.nodes';
import { DocumentDefaultDataLoaderNode } from './nodes/document-loaders/DocumentDefaultDataLoader.node';
import { embeddingsNodes } from './nodes/embeddings/embeddings.nodes';
import { memoryNodes } from './nodes/memory/memory.nodes';
import { chatModelNodes } from './nodes/models/chat-models.nodes';
import { outputParserNodes } from './nodes/output-parsers/output-parsers.nodes';
import { textSplitterNodes } from './nodes/text-splitters/text-splitters.nodes';
import { McpClientToolNode } from './nodes/tools/McpClientTool.node';
import { toolNodes } from './nodes/tools/tools.nodes';
import { ChatTriggerNode } from './nodes/trigger/ChatTrigger.node';
import { vectorStoreNodes } from './nodes/vector-stores/vector-stores.nodes';

export const nodes: NodeType[] = [
  AgentNode,
  ...llmChainNodes,
  ...ragChainNodes,
  ChatTriggerNode,
  ...chatModelNodes,
  ...memoryNodes,
  ...toolNodes,
  McpClientToolNode,
  ...embeddingsNodes,
  ...vectorStoreNodes,
  DocumentDefaultDataLoaderNode,
  ...textSplitterNodes,
  ...outputParserNodes,
];

export const credentials: CredentialType[] = aiCredentials;

export const nodesAiPackage: NodePackage = { name: '@workflow/nodes-ai', nodes, credentials };

export { type AgentResult, type AgentRunOptions, runAgent } from './nodes/agent/agent-loop';
export { ANTHROPIC_API_VERSION, ANTHROPIC_DEFAULT_MODEL } from './providers/anthropic';
export { type ChatModelCapabilities, capabilitiesOf, HttpChatModel } from './shared/chat-model';
export { validateJsonSchema } from './shared/json-schema';
export { McpClient } from './shared/mcp-client';
