/**
 * Qwen Cloud (Alibaba Cloud DashScope): message a Qwen model, analyze and generate images, generate
 * videos, on the native DashScope API. Own REST calls on the guarded client; the Tools input shows for
 * Text > Message a Model.
 */
import { type ExecuteContext, type Item, NodeOperationError, type NodeType } from '@workflow/workflow';
import { eachVendorItem } from '../shared/messages';
import { vendorToolsInput } from '../shared/tool-loop';
import { imageAnalyze, imageGenerate, imageProperties } from './image';
import { qwenListSearch, textMessage, textProperties } from './text';
import { videoImageToVideo, videoProperties, videoTextToVideo } from './video';

type Handler = (ctx: ExecuteContext, itemIndex: number) => Promise<Item | Item[]>;

const HANDLERS: Record<string, Handler> = {
  'text.message': textMessage,
  'image.analyze': imageAnalyze,
  'image.generate': imageGenerate,
  'video.textToVideo': videoTextToVideo,
  'video.imageToVideo': videoImageToVideo,
};

export const AlibabaCloudNode: NodeType = {
  description: {
    name: 'ai.alibabaCloud',
    displayName: 'Qwen Cloud',
    description: 'Message a Qwen model, analyze and generate images, and generate videos on Alibaba Cloud',
    icon: 'simple:alibabacloud',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Qwen Cloud' },
    inputs: vendorToolsInput(`$parameter.resource === 'text' && $parameter.operation === 'message'`),
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
      ...textProperties,
      ...imageProperties,
      ...videoProperties,
    ],
  },

  methods: { listSearch: qwenListSearch },

  async execute(ctx) {
    return eachVendorItem(ctx, async (itemIndex) => {
      const resource = String(ctx.getNodeParameter('resource', itemIndex));
      const operation = String(ctx.getNodeParameter('operation', itemIndex));
      const handler = HANDLERS[`${resource}.${operation}`];
      if (!handler) {
        throw new NodeOperationError(
          ctx.getNode(),
          `The operation "${resource} > ${operation}" is not supported`,
          {
            itemIndex,
          },
        );
      }
      return handler(ctx, itemIndex);
    });
  },
};
