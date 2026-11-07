/**
 * OpenAI: text, image, audio, file, conversation and video operations on the OpenAI API. Stub with the
 * final name, credential and resource and operation shell; L2 fills it (inputs gain the Tools port for
 * text.response through `vendorToolsInput`). Not usable as a tool, as n8n's OpenAI node.
 */
import type { NodeType } from '@workflow/workflow';

export const OpenAiNode: NodeType = {
  description: {
    name: 'ai.openAi',
    displayName: 'OpenAI',
    description:
      'Message a model, analyze and create images, audio and video, and manage files and conversations',
    icon: 'simple:openai',
    group: ['transform'],
    version: 1,
    defaults: { name: 'OpenAI' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'openAiApi', required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['chatgpt', 'gpt', 'dall-e', 'whisper', 'sora'],
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
          { name: 'File', value: 'file' },
          { name: 'Conversation', value: 'conversation' },
          { name: 'Video', value: 'video' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['text'] } },
        default: 'response',
        options: [
          { name: 'Message a Model', value: 'response', action: 'Message a model' },
          { name: 'Classify Text for Violations', value: 'classify', action: 'Classify text for violations' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['image'] } },
        default: 'generate',
        options: [
          { name: 'Generate an Image', value: 'generate', action: 'Generate an image' },
          { name: 'Analyze Image', value: 'analyze', action: 'Analyze an image' },
          { name: 'Edit Image', value: 'edit', action: 'Edit an image' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['audio'] } },
        default: 'generate',
        options: [
          { name: 'Generate Audio', value: 'generate', action: 'Generate audio' },
          { name: 'Transcribe a Recording', value: 'transcribe', action: 'Transcribe a recording' },
          { name: 'Translate a Recording', value: 'translate', action: 'Translate a recording' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['file'] } },
        default: 'upload',
        options: [
          { name: 'Upload a File', value: 'upload', action: 'Upload a file' },
          { name: 'List Files', value: 'list', action: 'List files' },
          { name: 'Delete a File', value: 'deleteFile', action: 'Delete a file' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['conversation'] } },
        default: 'create',
        options: [
          { name: 'Create a Conversation', value: 'create', action: 'Create a conversation' },
          { name: 'Get a Conversation', value: 'get', action: 'Get a conversation' },
          { name: 'Update a Conversation', value: 'update', action: 'Update a conversation' },
          { name: 'Remove a Conversation', value: 'remove', action: 'Remove a conversation' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['video'] } },
        default: 'generate',
        options: [{ name: 'Generate Video', value: 'generate', action: 'Generate a video' }],
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L2)');
  },
};
