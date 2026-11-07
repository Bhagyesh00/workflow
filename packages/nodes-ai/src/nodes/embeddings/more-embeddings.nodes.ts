/** More embedding sub-nodes. Stubs: L20 fills them. */
import type { NodeType } from '@workflow/workflow';

export const EmbeddingsNvidiaNode: NodeType = {
  description: {
    name: 'ai.embeddingsNvidia',
    displayName: 'Embeddings NVIDIA',
    description: 'Turns text into vectors with embedding models hosted by NVIDIA',
    icon: 'simple:nvidia',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings NVIDIA' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'nvidiaApi', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'nvidia'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L20)');
  },
};

export const EmbeddingsDatabricksNode: NodeType = {
  description: {
    name: 'ai.embeddingsDatabricks',
    displayName: 'Embeddings Databricks',
    description: 'Turns text into vectors with embedding models on a Databricks AI Gateway',
    icon: 'simple:databricks',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Databricks' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'databricksOAuth2Api', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'databricks'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L20)');
  },
};

export const EmbeddingsLemonadeNode: NodeType = {
  description: {
    name: 'ai.embeddingsLemonade',
    displayName: 'Embeddings Lemonade',
    description: 'Turns text into vectors with models served by Lemonade',
    icon: 'lucide:citrus',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Lemonade' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'lemonadeApi', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'lemonade', 'local'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L20)');
  },
};

export const EmbeddingsHuggingFaceInferenceNode: NodeType = {
  description: {
    name: 'ai.embeddingsHuggingFaceInference',
    displayName: 'Embeddings Hugging Face Inference',
    description: 'Turns text into vectors through Hugging Face Inference',
    icon: 'simple:huggingface',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Hugging Face Inference' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'huggingFaceApi', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'hugging face'],
    properties: [],
  },
  async supplyData() {
    throw new Error('not implemented (L20)');
  },
};

export const moreEmbeddingsNodes: NodeType[] = [
  EmbeddingsNvidiaNode,
  EmbeddingsDatabricksNode,
  EmbeddingsLemonadeNode,
  EmbeddingsHuggingFaceInferenceNode,
];
