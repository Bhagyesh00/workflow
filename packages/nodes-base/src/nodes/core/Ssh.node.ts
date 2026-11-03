/**
 * Run commands and move files on a remote host over SSH
 *
 * STUB from the Phase 2 contract step (C0a): a valid description that runs into a clear error.
 * Lane L5 writes the node.
 */
import { NodeOperationError, type NodeType } from '@workflow/workflow';

export const SshNode: NodeType = {
  description: {
    name: 'core.ssh',
    displayName: 'SSH',
    description: 'Run commands and move files on a remote host over SSH',
    icon: 'lucide:terminal',
    group: ['transform'],
    version: 1,
    defaults: { name: 'SSH' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['ssh', 'remote command', 'shell', 'sftp'],
    credentials: [
      { name: 'sshPassword', required: true, displayOptions: { show: { authentication: ['password'] } } },
      { name: 'sshPrivateKey', required: true, displayOptions: { show: { authentication: ['privateKey'] } } },
    ],
    properties: [
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'password',
        noDataExpression: true,
        options: [
          { name: 'Password', value: 'password' },
          { name: 'Private Key', value: 'privateKey' },
        ],
      },
    ],
  },

  async execute(ctx) {
    throw new NodeOperationError(ctx.getNode(), 'The SSH node is not built yet');
  },
};
