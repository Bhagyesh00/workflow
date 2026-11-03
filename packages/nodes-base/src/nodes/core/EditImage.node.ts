/**
 * Resize, crop, rotate, draw on and convert images
 *
 * STUB from the Phase 2 contract step (C0a): a valid description that runs into a clear error.
 * Lane L4 writes the node.
 */
import { NodeOperationError, type NodeType } from '@workflow/workflow';

export const EditImageNode: NodeType = {
  description: {
    name: 'core.editImage',
    displayName: 'Edit Image',
    description: 'Resize, crop, rotate, draw on and convert images',
    icon: 'lucide:image',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Edit Image' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: ['image', 'resize', 'crop', 'rotate', 'watermark', 'convert image', 'png', 'jpeg'],
    properties: [],
  },

  async execute(ctx) {
    throw new NodeOperationError(ctx.getNode(), 'The Edit Image node is not built yet');
  },
};
