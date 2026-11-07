/**
 * Anthropic: message Claude, analyze images and documents, manage files and generate prompts on the
 * Anthropic API. The Tools port is on for Message a Model once Hide Tools is set to Show.
 */
import type { NodeType } from '@workflow/workflow';
import { eachVendorItem } from '../shared/messages';
import { vendorToolsInput } from '../shared/tool-loop';
import { analyzeProperties, executeAnalyze } from './analyze';
import { executeFile, fileProperties } from './file';
import {
  executeMessage,
  messageProperties,
  searchFiles,
  searchModels,
  TEXT_TOOLS_CONDITION,
} from './message';
import { executePrompt, promptProperties } from './prompt';

export const AnthropicNode: NodeType = {
  description: {
    name: 'ai.anthropic',
    displayName: 'Anthropic',
    description: 'Message Claude, analyze images and documents, manage files and generate prompts',
    icon: 'simple:anthropic',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Anthropic' },
    inputs: vendorToolsInput(TEXT_TOOLS_CONDITION),
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
      ...messageProperties,
      ...analyzeProperties,
      ...fileProperties,
      ...promptProperties,
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
          return executeMessage(ctx, itemIndex, operation);
        case 'image':
        case 'document':
          return executeAnalyze(ctx, itemIndex, resource, operation);
        case 'file':
          return executeFile(ctx, itemIndex, operation);
        case 'prompt':
          return executePrompt(ctx, itemIndex, operation);
        default:
          throw new Error(`The resource "${resource}" is not known`);
      }
    });
  },
};
