/**
 * Ollama: message a local model and analyze images. Stub with the final name, credential and resource and
 * operation shell; L5 fills it (inputs gain the Tools port through `vendorToolsInput`).
 */
import type { NodeType } from '@workflow/workflow';

export const OllamaNode: NodeType = {
  description: {
    name: 'ai.ollama',
    displayName: 'Ollama',
    description: 'Message a model on an Ollama server and analyze images',
    icon: 'simple:ollama',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Ollama' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'ollamaApi', required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['llama', 'local model'],
    usableAsTool: true,
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'text',
        options: [
          { name: 'Text', value: 'text' },
          { name: 'Image', value: 'image' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['text'] } },
        default: 'message',
        options: [{ name: 'Message a Model', value: 'message', action: 'Message a model' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['image'] } },
        default: 'analyze',
        options: [{ name: 'Analyze Image', value: 'analyze', action: 'Analyze an image' }],
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L5)');
  },
};
