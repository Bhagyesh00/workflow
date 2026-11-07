/** Every retriever node, for the package registry (src/index.ts). */
import type { NodeType } from '@workflow/workflow';
import { RetrieverContextualCompressionNode } from './RetrieverContextualCompression.node';
import { RetrieverMultiQueryNode } from './RetrieverMultiQuery.node';
import { RetrieverVectorStoreNode } from './RetrieverVectorStore.node';
import { RetrieverWorkflowNode } from './RetrieverWorkflow.node';

export const retrieverNodes: NodeType[] = [
  RetrieverVectorStoreNode,
  RetrieverContextualCompressionNode,
  RetrieverMultiQueryNode,
  RetrieverWorkflowNode,
];
