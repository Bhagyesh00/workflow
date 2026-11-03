/**
 * Transfer files over FTP or SFTP
 *
 * STUB from the Phase 2 contract step (C0a): a valid description that runs into a clear error.
 * Lane L5 writes the node.
 */
import { NodeOperationError, type NodeType } from '@workflow/workflow';

export const FtpNode: NodeType = {
  description: {
    name: 'core.ftp',
    displayName: 'FTP',
    description: 'Transfer files over FTP or SFTP',
    icon: 'lucide:server',
    group: ['transform'],
    version: 1,
    defaults: { name: 'FTP' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: ['ftp', 'sftp', 'upload', 'download', 'file transfer'],
    credentials: [
      { name: 'ftp', required: true, displayOptions: { show: { protocol: ['ftp'] } } },
      { name: 'sftp', required: true, displayOptions: { show: { protocol: ['sftp'] } } },
    ],
    properties: [
      {
        displayName: 'Protocol',
        name: 'protocol',
        type: 'options',
        default: 'ftp',
        noDataExpression: true,
        options: [
          { name: 'FTP', value: 'ftp' },
          { name: 'SFTP', value: 'sftp' },
        ],
      },
    ],
  },

  async execute(ctx) {
    throw new NodeOperationError(ctx.getNode(), 'The FTP node is not built yet');
  },
};
