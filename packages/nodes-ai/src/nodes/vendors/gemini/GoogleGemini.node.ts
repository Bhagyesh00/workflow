/**
 * Google Gemini: message, image, audio, video and document operations, files and file search stores on
 * the Gemini API. Stub with the final name, credential and resource and operation shell; L4 fills it
 * (inputs gain the Tools port through `vendorToolsInput`).
 */
import type { NodeType } from '@workflow/workflow';

export const GoogleGeminiNode: NodeType = {
  description: {
    name: 'ai.googleGemini',
    displayName: 'Google Gemini',
    description:
      'Message Gemini, analyze and generate images, audio and video, and manage files and file search stores',
    icon: 'simple:googlegemini',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Google Gemini' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'googleGeminiApi', required: true }],
    categories: ['AI', 'Vendors'],
    alias: ['gemini', 'imagen', 'veo'],
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
          { name: 'Document', value: 'document' },
          { name: 'File', value: 'file' },
          { name: 'File Search', value: 'fileSearch' },
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
          { name: 'Edit Image', value: 'edit', action: 'Edit an image' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['audio'] } },
        default: 'transcribe',
        options: [
          { name: 'Transcribe a Recording', value: 'transcribe', action: 'Transcribe a recording' },
          { name: 'Analyze Audio', value: 'analyze', action: 'Analyze audio' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['video'] } },
        default: 'analyze',
        options: [
          { name: 'Analyze Video', value: 'analyze', action: 'Analyze a video' },
          { name: 'Generate a Video', value: 'generate', action: 'Generate a video' },
          { name: 'Download Video', value: 'download', action: 'Download a video' },
        ],
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
        options: [{ name: 'Upload File', value: 'upload', action: 'Upload a file' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['fileSearch'] } },
        default: 'createStore',
        options: [
          { name: 'Create File Search Store', value: 'createStore', action: 'Create a file search store' },
          { name: 'Delete File Search Store', value: 'deleteStore', action: 'Delete a file search store' },
          { name: 'List File Search Stores', value: 'listStores', action: 'List file search stores' },
          {
            name: 'Upload to File Search Store',
            value: 'uploadToStore',
            action: 'Upload a file to a file search store',
          },
        ],
      },
    ],
  },

  async execute() {
    throw new Error('not implemented (L4)');
  },
};
