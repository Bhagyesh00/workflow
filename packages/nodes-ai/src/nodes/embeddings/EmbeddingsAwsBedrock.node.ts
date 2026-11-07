/** Embeddings AWS Bedrock sub-node. Stub: L11 fills it. */
import type { NodeType } from '@workflow/workflow';

export const EmbeddingsAwsBedrockNode: NodeType = {
  description: {
    name: 'ai.embeddingsAwsBedrock',
    displayName: 'Embeddings AWS Bedrock',
    description: 'Turns text into vectors with embedding models on AWS Bedrock',
    icon: 'simple:amazonaws',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings AWS Bedrock' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [
      { name: 'aws', required: true, displayOptions: { show: { authentication: ['iam'] } } },
      { name: 'awsAssumeRole', required: true, displayOptions: { show: { authentication: ['assumeRole'] } } },
    ],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'bedrock', 'aws'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L11)');
  },
};
