/**
 * Anthropic: message, image and document analysis, files and prompt tools on the Anthropic API. Stub with
 * the final name, credential and resource and operation shell; L3 fills it (inputs gain the Tools port
 * through `vendorToolsInput`).
 */
import type { NodeType } from '@workflow/workflow';

export const AnthropicNode: NodeType = {
  description: {
    name: 'ai.anthropic',
    displayName: 'Anthropic',
    description: 'Message Claude, analyze images and documents, manage files and generate prompts',
    icon: 'simple:anthropic',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Anthropic' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'anthropicApi', required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['claude'],
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
          { name: 'Document', value: 'document' },
          { name: 'File', value: 'file' },
          { name: 'Prompt', value: 'prompt' },
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
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['document'] } },
        default: 'analyze',
        options: [{ name: 'Analyze Document', value: 'analyze', action: 'Analyze a document' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['file'] } },
        default: 'upload',
        options: [
          { name: 'Upload File', value: 'upload', action: 'Upload a file' },
          { name: 'Get File Metadata', value: 'get', action: 'Get file metadata' },
          { name: 'List Files', value: 'list', action: 'List files' },
          { name: 'Delete File', value: 'deleteFile', action: 'Delete a file' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['prompt'] } },
        default: 'generate',
        options: [
          { name: 'Generate Prompt', value: 'generate', action: 'Generate a prompt' },
          { name: 'Improve Prompt', value: 'improve', action: 'Improve a prompt' },
          { name: 'Templatize Prompt', value: 'templatize', action: 'Templatize a prompt' },
        ],
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L3)');
  },
};
