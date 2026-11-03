/**
 * Sign, decode or verify JSON Web Tokens
 *
 * STUB from the Phase 2 contract step (C0a): a valid description that runs into a clear error.
 * Lane L1 writes the node.
 */
import { NodeOperationError, type NodeType } from '@workflow/workflow';

export const JwtNode: NodeType = {
  description: {
    name: 'core.jwt',
    displayName: 'JWT',
    description: 'Sign, decode or verify JSON Web Tokens',
    icon: 'lucide:key-square',
    group: ['transform'],
    version: 1,
    defaults: { name: 'JWT' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['jwt', 'json web token', 'token', 'sign', 'verify'],
    credentials: [{ name: 'jwtAuth', required: true }],
    properties: [],
  },

  async execute(ctx) {
    throw new NodeOperationError(ctx.getNode(), 'The JWT node is not built yet');
  },
};
