/** Crypto: hashes, HMACs, signatures and random values (node:crypto, no user code). */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, sign } from 'node:crypto';
import { type DataObject, deepCopy, NodeOperationError, type NodeType } from '@workflow/workflow';
import { ItemList, mapItems, setField } from '../../utils/utilities';

const HASH_TYPES: Record<string, string> = {
  MD5: 'md5',
  SHA1: 'sha1',
  SHA256: 'sha256',
  SHA384: 'sha384',
  SHA512: 'sha512',
  'SHA3-256': 'sha3-256',
  'SHA3-384': 'sha3-384',
  'SHA3-512': 'sha3-512',
};

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const hashTypeOptions = Object.keys(HASH_TYPES).map((name) => ({ name, value: name }));

export const CryptoNode: NodeType = {
  description: {
    name: 'core.crypto',
    displayName: 'Crypto',
    description: 'Hash, HMAC or sign values and generate random IDs',
    icon: 'lucide:fingerprint',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Crypto' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['hash', 'md5', 'sha', 'hmac', 'signature', 'uuid', 'random', 'encrypt', 'checksum'],
    subtitle: '={{ $parameter.action }}',
    properties: [
      {
        displayName: 'Action',
        name: 'action',
        type: 'options',
        default: 'hash',
        noDataExpression: true,
        options: [
          { name: 'Hash', value: 'hash', description: 'Hash a text or file', action: 'Hash a text or file' },
          {
            name: 'Hmac',
            value: 'hmac',
            description: 'Keyed hash of a text or file',
            action: 'HMAC a text or file',
          },
          {
            name: 'Sign',
            value: 'sign',
            description: 'Sign a text with a private key',
            action: 'Sign a text',
          },
          {
            name: 'Generate',
            value: 'generate',
            description: 'Generate a random value',
            action: 'Generate a random value',
          },
        ],
      },
      {
        displayName: 'Type',
        name: 'type',
        type: 'options',
        default: 'SHA256',
        options: hashTypeOptions,
        displayOptions: { show: { action: ['hash', 'hmac'] } },
      },
      {
        displayName: 'Binary File',
        name: 'binaryData',
        type: 'boolean',
        default: false,
        description: 'Whether to hash a binary file of the item instead of a text',
        displayOptions: { show: { action: ['hash', 'hmac'] } },
      },
      {
        displayName: 'Binary Property Name',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        displayOptions: { show: { action: ['hash', 'hmac'], binaryData: [true] } },
      },
      {
        displayName: 'Value',
        name: 'value',
        type: 'string',
        default: '',
        description: 'Text to hash or sign',
        displayOptions: { show: { action: ['hash', 'hmac', 'sign'], binaryData: [false] } },
      },
      {
        displayName: 'Secret',
        name: 'secret',
        type: 'string',
        default: '',
        typeOptions: { password: true },
        description: 'Prefer an expression that reads the secret from $vars over pasting it here',
        displayOptions: { show: { action: ['hmac'] } },
      },
      {
        displayName: 'Algorithm',
        name: 'algorithm',
        type: 'options',
        default: 'sha256',
        displayOptions: { show: { action: ['sign'] } },
        options: [
          { name: 'SHA256 (RSA / ECDSA)', value: 'sha256' },
          { name: 'SHA384 (RSA / ECDSA)', value: 'sha384' },
          { name: 'SHA512 (RSA / ECDSA)', value: 'sha512' },
          { name: 'Ed25519', value: 'ed25519' },
        ],
      },
      {
        displayName: 'Private Key',
        name: 'privateKey',
        type: 'string',
        default: '',
        typeOptions: { password: true, rows: 4 },
        placeholder: '-----BEGIN PRIVATE KEY-----',
        description: 'PEM-encoded private key; prefer an expression that reads it from $vars',
        displayOptions: { show: { action: ['sign'] } },
      },
      {
        displayName: 'Encoding',
        name: 'encoding',
        type: 'options',
        default: 'hex',
        displayOptions: { show: { action: ['hash', 'hmac', 'sign'] } },
        options: [
          { name: 'Hex', value: 'hex' },
          { name: 'Base64', value: 'base64' },
          { name: 'Base64 URL', value: 'base64url' },
        ],
      },
      {
        displayName: 'Type',
        name: 'encodingType',
        type: 'options',
        default: 'uuid',
        displayOptions: { show: { action: ['generate'] } },
        options: [
          { name: 'UUID', value: 'uuid' },
          { name: 'Hex', value: 'hex' },
          { name: 'Base64', value: 'base64' },
          { name: 'Alphanumeric', value: 'ascii' },
        ],
      },
      {
        displayName: 'Length',
        name: 'stringLength',
        type: 'number',
        default: 32,
        typeOptions: { minValue: 1, maxValue: 4096 },
        description: 'Number of characters to generate',
        displayOptions: { show: { action: ['generate'], encodingType: ['hex', 'base64', 'ascii'] } },
      },
      {
        displayName: 'Property Name',
        name: 'dataPropertyName',
        type: 'string',
        default: 'data',
        description: 'Field the result is written to (dot notation creates nested fields)',
      },
    ],
  },

  async execute(ctx) {
    return [
      await mapItems(ctx, async (i, item) => {
        const action = ctx.getNodeParameter('action', i) as string;
        const property = String(ctx.getNodeParameter('dataPropertyName', i, 'data') || 'data');
        const json: DataObject = deepCopy(item.json);
        const encoding = ctx.getNodeParameter('encoding', i, 'hex') as 'hex' | 'base64' | 'base64url';
        let result: string;

        const input = async (): Promise<Uint8Array | string> => {
          if (ctx.getNodeParameter('binaryData', i, false)) {
            const prop = ctx.getNodeParameter('binaryPropertyName', i, 'data') as string;
            return ctx.helpers.getBinaryDataBuffer(i, prop);
          }
          return String(ctx.getNodeParameter('value', i, '') ?? '');
        };

        switch (action) {
          case 'hash': {
            const type = HASH_TYPES[ctx.getNodeParameter('type', i, 'SHA256') as string];
            if (!type) throw new NodeOperationError(ctx.getNode(), 'Unknown hash type', { itemIndex: i });
            result = createHash(type)
              .update(await input())
              .digest(encoding);
            break;
          }
          case 'hmac': {
            const type = HASH_TYPES[ctx.getNodeParameter('type', i, 'SHA256') as string];
            if (!type) throw new NodeOperationError(ctx.getNode(), 'Unknown hash type', { itemIndex: i });
            const secret = String(ctx.getNodeParameter('secret', i, '') ?? '');
            result = createHmac(type, secret)
              .update(await input())
              .digest(encoding);
            break;
          }
          case 'sign': {
            const algorithm = ctx.getNodeParameter('algorithm', i, 'sha256') as string;
            const key = String(ctx.getNodeParameter('privateKey', i, '') ?? '');
            if (!key.trim())
              throw new NodeOperationError(ctx.getNode(), 'A private key is required', { itemIndex: i });
            try {
              result = sign(
                algorithm === 'ed25519' ? null : algorithm,
                Buffer.from(String(ctx.getNodeParameter('value', i, ''))),
                key,
              ).toString(encoding);
            } catch (error) {
              // never echo key material back in the error
              throw new NodeOperationError(
                ctx.getNode(),
                'Signing failed: check the private key and algorithm',
                {
                  itemIndex: i,
                  description: (error as { code?: string }).code ?? undefined,
                },
              );
            }
            break;
          }
          case 'generate': {
            const type = ctx.getNodeParameter('encodingType', i, 'uuid') as string;
            const length = Math.min(
              4096,
              Math.max(1, Math.floor(Number(ctx.getNodeParameter('stringLength', i, 32)))),
            );
            if (type === 'uuid') result = randomUUID();
            else if (type === 'hex')
              result = randomBytes(Math.ceil(length / 2))
                .toString('hex')
                .slice(0, length);
            else if (type === 'base64')
              result = randomBytes(Math.ceil((length * 3) / 4))
                .toString('base64')
                .slice(0, length);
            else result = Array.from({ length }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]).join('');
            break;
          }
          default:
            throw new NodeOperationError(ctx.getNode(), `Unknown action "${action}"`, { itemIndex: i });
        }
        setField(json, property, result);
        return new ItemList([{ json, ...(item.binary ? { binary: item.binary } : {}) }]);
      }),
    ];
  },
};
