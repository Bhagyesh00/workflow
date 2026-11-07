/**
 * OpenAI: text, image, audio, file, conversation and video operations on the OpenAI API. The Tools port
 * is on for Message a Model once Hide Tools is set to Show. Not usable as a tool, as n8n's OpenAI node.
 */
import type { NodeType } from '@workflow/workflow';
import { eachVendorItem } from '../shared/messages';
import { vendorToolsInput } from '../shared/tool-loop';
import { audioProperties, executeAudio } from './audio';
import { conversationProperties, executeConversation } from './conversation';
import { executeFile, fileProperties, searchFiles } from './file';
import { executeImage, imageProperties } from './image';
import { executeText, searchModels, TEXT_TOOLS_CONDITION, textProperties } from './text';
import { executeVideo, videoProperties } from './video';

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
    inputs: vendorToolsInput(TEXT_TOOLS_CONDITION),
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
      ...textProperties,
      ...imageProperties,
      ...audioProperties,
      ...fileProperties,
      ...conversationProperties,
      ...videoProperties,
    ],
  },
  methods: {
    listSearch: {
      modelSearch: searchModels,
      fileSearch: searchFiles,
    },
  },
  async execute(ctx) {
    return eachVendorItem(ctx, async (itemIndex) => {
      const resource = String(ctx.getNodeParameter('resource', itemIndex, 'text'));
      const operation = String(ctx.getNodeParameter('operation', itemIndex, ''));
      switch (resource) {
        case 'text':
          return executeText(ctx, itemIndex, operation);
        case 'image':
          return executeImage(ctx, itemIndex, operation);
        case 'audio':
          return executeAudio(ctx, itemIndex, operation);
        case 'file':
          return executeFile(ctx, itemIndex, operation);
        case 'conversation':
          return executeConversation(ctx, itemIndex, operation);
        case 'video':
          return executeVideo(ctx, itemIndex, operation);
        default:
          throw new Error(`The resource "${resource}" is not known`);
      }
    });
  },
};
