/**
 * Moonshot Kimi: message a Kimi model and analyze images. Stub with the final name, credential and resource
 * and operation shell; L5 fills it (inputs gain the Tools port through `vendorToolsInput`).
 */
import type { NodeType } from '@workflow/workflow';

export const MoonshotNode: NodeType = {
  description: {
    name: 'ai.moonshot',
    displayName: 'Moonshot Kimi',
    description: 'Message a Kimi model and analyze images',
    icon: 'simple:moonshot',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Moonshot Kimi' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'moonshotApi', required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['kimi'],
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
