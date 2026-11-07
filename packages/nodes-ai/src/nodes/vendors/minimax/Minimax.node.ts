/**
 * MiniMax: message a model, generate images, speech and videos. Own REST calls on the guarded client; the
 * Tools input shows for Text > Message a Model.
 */
import { type ExecuteContext, type Item, NodeOperationError, type NodeType } from '@workflow/workflow';
import { eachVendorItem } from '../shared/messages';
import { vendorToolsInput } from '../shared/tool-loop';
import { imageGenerate, imageProperties } from './image';
import { speechProperties, speechTextToSpeech } from './speech';
import { textMessage, textProperties } from './text';
import { videoImageToVideo, videoProperties, videoTextToVideo } from './video';

type Handler = (ctx: ExecuteContext, itemIndex: number) => Promise<Item | Item[]>;

const HANDLERS: Record<string, Handler> = {
  'text.message': textMessage,
  'image.generate': imageGenerate,
  'audio.textToSpeech': speechTextToSpeech,
  'video.textToVideo': videoTextToVideo,
  'video.imageToVideo': videoImageToVideo,
};

export const MinimaxNode: NodeType = {
  description: {
    name: 'ai.minimax',
    displayName: 'MiniMax',
    description: 'Message a MiniMax model and generate images, speech and videos',
    icon: 'simple:minimax',
    group: ['transform'],
    version: 1,
    defaults: { name: 'MiniMax' },
    inputs: vendorToolsInput(`$parameter.resource === 'text' && $parameter.operation === 'message'`),
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
      ...textProperties,
      ...imageProperties,
      ...speechProperties,
      ...videoProperties,
    ],
  },

  async execute(ctx) {
    return eachVendorItem(ctx, async (itemIndex) => {
      const resource = String(ctx.getNodeParameter('resource', itemIndex));
      const operation = String(ctx.getNodeParameter('operation', itemIndex));
      const handler = HANDLERS[`${resource}.${operation}`];
      if (!handler) {
        throw new NodeOperationError(ctx.getNode(), `The operation "${resource} > ${operation}" is not supported`, {
          itemIndex,
        });
      }
      return handler(ctx, itemIndex);
    });
  },
};
