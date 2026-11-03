/**
 * Compress and decompress files (zip, gzip, tar)
 *
 * STUB from the Phase 2 contract step (C0a): a valid description that runs into a clear error.
 * Lane L2 writes the node.
 */
import { NodeOperationError, type NodeType } from '@workflow/workflow';

export const CompressionNode: NodeType = {
  description: {
    name: 'core.compression',
    displayName: 'Compression',
    description: 'Compress and decompress files (zip, gzip, tar)',
    icon: 'lucide:file-archive',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Compression' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: ['zip', 'unzip', 'gzip', 'tar', 'compress', 'decompress', 'archive'],
    properties: [],
  },

  async execute(ctx) {
    throw new NodeOperationError(ctx.getNode(), 'The Compression node is not built yet');
  },
};
