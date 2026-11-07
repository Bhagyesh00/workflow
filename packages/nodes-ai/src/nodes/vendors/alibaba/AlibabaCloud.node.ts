/**
 * Qwen Cloud (Alibaba Cloud DashScope): message a Qwen model, analyze and generate images, generate
 * videos. Stub with the final name, credential and resource and operation shell; L6 fills it (inputs gain
 * the Tools port through `vendorToolsInput`).
 */
import type { NodeType } from '@workflow/workflow';

export const AlibabaCloudNode: NodeType = {
  description: {
    name: 'ai.alibabaCloud',
    displayName: 'Qwen Cloud',
    description: 'Message a Qwen model, analyze and generate images, and generate videos on Alibaba Cloud',
    icon: 'simple:alibabacloud',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Qwen Cloud' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'alibabaCloudApi', required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['qwen', 'dashscope', 'alibaba', 'wan'],
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
          { name: 'Video', value: 'video' },
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
        options: [
          { name: 'Analyze Image', value: 'analyze', action: 'Analyze an image' },
          { name: 'Generate an Image', value: 'generate', action: 'Generate an image' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['video'] } },
        default: 'textToVideo',
        options: [
          { name: 'Text to Video', value: 'textToVideo', action: 'Generate a video from text' },
          { name: 'Image to Video', value: 'imageToVideo', action: 'Generate a video from an image' },
        ],
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L6)');
  },
};
