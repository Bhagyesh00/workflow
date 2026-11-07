/**
 * Google Gemini: message, image, audio, video and document operations, files and file search stores on
 * the Gemini API. Own REST calls on the guarded client; the Tools input shows for Text > Message a Model.
 */
import { type ExecuteContext, type Item, NodeOperationError, type NodeType } from '@workflow/workflow';
import { eachVendorItem } from '../shared/messages';
import { vendorToolsInput } from '../shared/tool-loop';
import { createStore, deleteStore, fileSearchProperties, listStores, uploadToStore } from './file-search';
import { fileProperties, fileUpload } from './files';
import {
  audioAnalyze,
  audioTranscribe,
  documentAnalyze,
  imageAnalyze,
  imageEdit,
  imageGenerate,
  mediaProperties,
  videoAnalyze,
  videoDownload,
  videoGenerate,
} from './media';
import { messageProperties, textMessage } from './message';
import { geminiListSearch, modelProperty } from './operations';

type Handler = (ctx: ExecuteContext, itemIndex: number) => Promise<Item | Item[]>;

const HANDLERS: Record<string, Handler> = {
  'text.message': textMessage,
  'image.analyze': imageAnalyze,
  'image.generate': imageGenerate,
  'image.edit': imageEdit,
  'audio.transcribe': audioTranscribe,
  'audio.analyze': audioAnalyze,
  'video.analyze': videoAnalyze,
  'video.generate': videoGenerate,
  'video.download': videoDownload,
  'document.analyze': documentAnalyze,
  'file.upload': fileUpload,
  'fileSearch.createStore': createStore,
  'fileSearch.deleteStore': deleteStore,
  'fileSearch.listStores': listStores,
  'fileSearch.uploadToStore': uploadToStore,
};

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
    inputs: vendorToolsInput(`$parameter.resource === 'text' && $parameter.operation === 'message'`),
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
      modelProperty({
        resource: 'image',
        operations: ['analyze'],
        searchMethod: 'textModels',
        defaultModel: 'gemini-2.5-flash',
      }),
      modelProperty({
        resource: 'image',
        operations: ['generate'],
        searchMethod: 'imageModels',
        defaultModel: 'imagen-4.0-generate-001',
      }),
      modelProperty({
        resource: 'image',
        operations: ['edit'],
        searchMethod: 'imageEditModels',
        defaultModel: 'gemini-2.5-flash-image',
      }),
      modelProperty({
        resource: 'audio',
        searchMethod: 'textModels',
        defaultModel: 'gemini-2.5-flash',
      }),
      modelProperty({
        resource: 'video',
        operations: ['analyze'],
        searchMethod: 'textModels',
        defaultModel: 'gemini-2.5-flash',
      }),
      modelProperty({
        resource: 'video',
        operations: ['generate'],
        searchMethod: 'videoModels',
        defaultModel: 'veo-3.0-generate-001',
      }),
      modelProperty({
        resource: 'document',
        searchMethod: 'textModels',
        defaultModel: 'gemini-2.5-flash',
      }),
      ...messageProperties,
      ...mediaProperties,
      ...fileProperties,
      ...fileSearchProperties,
    ],
  },

  async execute(ctx) {
    return eachVendorItem(ctx, async (itemIndex): Promise<Item | Item[]> => {
      const resource = String(ctx.getNodeParameter('resource', itemIndex, 'text'));
      const operation = String(ctx.getNodeParameter('operation', itemIndex, ''));
      const handler = HANDLERS[`${resource}.${operation}`];
      if (!handler) {
        throw new NodeOperationError(
          ctx.getNode(),
          `The operation "${operation}" is not known for "${resource}"`,
          {
            itemIndex,
          },
        );
      }
      return handler(ctx, itemIndex);
    });
  },

  methods: { listSearch: geminiListSearch },
};
