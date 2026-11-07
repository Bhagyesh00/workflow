/** TOTP: generate the current time-based one-time password from a stored secret (RFC 6238). */
import { type DataObject, NodeOperationError, type NodeType } from '@workflow/workflow';
import { TOTP_ALGORITHMS, totp } from '../../utils/totp';
import { mapItems } from '../../utils/utilities';

export const TotpNode: NodeType = {
  description: {
    name: 'core.totp',
    displayName: 'TOTP',
    description: 'Generate time-based one-time passwords (TOTP)',
    icon: 'lucide:timer',
    group: ['transform'],
    version: 1,
    usableAsTool: true,
    defaults: { name: 'TOTP' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['totp', 'otp', '2fa', 'mfa', 'one-time password', 'authenticator'],
    credentials: [{ name: 'totpApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'generateSecret',
        options: [
          {
            name: 'Generate Secret',
            value: 'generateSecret',
            description: 'Generate the current code from the credential secret',
            action: 'Generate the current code',
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { operation: ['generateSecret'] } },
        options: [
          {
            displayName: 'Algorithm',
            name: 'algorithm',
            type: 'options',
            default: 'SHA1',
            options: TOTP_ALGORITHMS.map((a) => ({ name: a.toUpperCase(), value: a.toUpperCase() })),
          },
          {
            displayName: 'Digits',
            name: 'digits',
            type: 'number',
            default: 6,
            typeOptions: { minValue: 1, maxValue: 10 },
          },
          {
            displayName: 'Period',
            name: 'period',
            type: 'number',
            default: 30,
            description: 'How long a code stays valid, in seconds',
            typeOptions: { minValue: 1 },
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    const credentials = await ctx.getCredentials<{ secret?: string; label?: string }>('totpApi');
    const label = String(credentials.label ?? '').trim();
    if (label && !label.includes(':')) {
      throw new NodeOperationError(ctx.getNode(), 'Malformed label - expected issuer:username');
    }
    const secret = String(credentials.secret ?? '');
    return [
      await mapItems(ctx, async (i) => {
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        try {
          return totp({
            secret,
            algorithm: String(options.algorithm || 'SHA1'),
            digits: Number(options.digits) || 6,
            period: Number(options.period) || 30,
            timestampMs: Date.now(),
          });
        } catch (error) {
          throw new NodeOperationError(ctx.getNode(), (error as Error).message, { itemIndex: i });
        }
      }),
    ];
  },
};
