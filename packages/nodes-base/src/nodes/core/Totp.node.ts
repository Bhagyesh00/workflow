/**
 * Generate time-based one-time passwords (TOTP)
 *
 * STUB from the Phase 2 contract step (C0a): a valid description that runs into a clear error.
 * Lane L1 writes the node.
 */
import { NodeOperationError, type NodeType } from '@workflow/workflow';

export const TotpNode: NodeType = {
  description: {
    name: 'core.totp',
    displayName: 'TOTP',
    description: 'Generate time-based one-time passwords (TOTP)',
    icon: 'lucide:timer',
    group: ['transform'],
    version: 1,
    defaults: { name: 'TOTP' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['totp', 'otp', '2fa', 'mfa', 'one-time password', 'authenticator'],
    credentials: [{ name: 'totpApi', required: true }],
    properties: [],
  },

  async execute(ctx) {
    throw new NodeOperationError(ctx.getNode(), 'The TOTP node is not built yet');
  },
};
