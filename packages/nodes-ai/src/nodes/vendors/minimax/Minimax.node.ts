/**
 * MiniMax: message a model, generate images, speech and videos. Stub with the final name, credential and
 * resource and operation shell; L7 fills it (inputs gain the Tools port through `vendorToolsInput`).
 */
import type { NodeType } from '@workflow/workflow';

export const MinimaxNode: NodeType = {
  description: {
    name: 'ai.minimax',
    displayName: 'MiniMax',
    description: 'Message a MiniMax model and generate images, speech and videos',
    icon: 'simple:minimax',
    group: ['transform'],
    version: 1,
    defaults: { name: 'MiniMax' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'minimaxApi', required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['hailuo', 'text to speech'],
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
          { name: 'Audio', value: 'audio' },
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
        default: 'generate',
        options: [{ name: 'Generate an Image', value: 'generate', action: 'Generate an image' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['audio'] } },
        default: 'textToSpeech',
        options: [{ name: 'Text to Speech', value: 'textToSpeech', action: 'Convert text to speech' }],
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
    throw new Error('not implemented (L7)');
  },
};
