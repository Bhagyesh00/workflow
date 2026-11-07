/** JWT: sign, decode or verify JSON Web Tokens (HS, RS, PS and ES algorithms on node:crypto). */
import {
  type DataObject,
  type ExecuteContext,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { decodeJwt, JWT_ALGORITHMS, JwtError, type JwtKey, signJwt, verifyJwt } from '../../utils/jwt';
import { mapItems } from '../../utils/utilities';

const algorithmOptions = JWT_ALGORITHMS.map((a) => ({ name: a, value: a }));

const properties: NodeProperty[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    default: 'sign',
    options: [
      {
        name: 'Decode',
        value: 'decode',
        description: 'Decode a token without checking it',
        action: 'Decode a JWT',
      },
      { name: 'Sign', value: 'sign', description: 'Create a signed token', action: 'Sign a JWT' },
      {
        name: 'Verify',
        value: 'verify',
        description: 'Check the signature and the dates',
        action: 'Verify a JWT',
      },
    ],
  },
  {
    displayName: 'Use JSON to Build Payload',
    name: 'useJson',
    type: 'boolean',
    default: false,
    displayOptions: { show: { operation: ['sign'] } },
  },
  {
    displayName: 'Payload Claims',
    name: 'claims',
    type: 'collection',
    default: {},
    placeholder: 'Add claim',
    description: 'Written as the registered claims aud, exp, iss, jti, nbf and sub',
    displayOptions: { show: { operation: ['sign'], useJson: [false] } },
    options: [
      {
        displayName: 'Audience',
        name: 'audience',
        type: 'string',
        default: '',
        description: 'Written as aud',
      },
      {
        displayName: 'Expires In',
        name: 'expiresIn',
        type: 'number',
        default: 3600,
        typeOptions: { minValue: 0 },
        description: 'Seconds until the token expires, written as exp (0 for no expiry)',
      },
      { displayName: 'Issuer', name: 'issuer', type: 'string', default: '', description: 'Written as iss' },
      { displayName: 'JWT ID', name: 'jwtid', type: 'string', default: '', description: 'Written as jti' },
      {
        displayName: 'Not Before',
        name: 'notBefore',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Seconds from now until the token becomes valid, written as nbf (0 for none)',
      },
      { displayName: 'Subject', name: 'subject', type: 'string', default: '', description: 'Written as sub' },
    ],
  },
  {
    displayName: 'Payload Claims (JSON)',
    name: 'claimsJson',
    type: 'json',
    default: '{\n  "my_field_1": "value 1",\n  "my_field_2": "value 2"\n}',
    displayOptions: { show: { operation: ['sign'], useJson: [true] } },
  },
  {
    displayName: 'Header Claims (JSON)',
    name: 'headerClaims',
    type: 'json',
    default: '{}',
    description: 'Extra header fields. The algorithm always comes from the credential or the option.',
    displayOptions: { show: { operation: ['sign'] } },
  },
  {
    displayName: 'Token',
    name: 'token',
    type: 'string',
    default: '',
    required: true,
    typeOptions: { password: true },
    description: 'The JWT to check or decode',
    displayOptions: { show: { operation: ['verify', 'decode'] } },
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Return Additional Info',
        name: 'complete',
        type: 'boolean',
        default: false,
        description: 'Whether to return the header and the signature next to the payload',
        displayOptions: { show: { '/operation': ['verify', 'decode'] } },
      },
      {
        displayName: 'Ignore Expiration',
        name: 'ignoreExpiration',
        type: 'boolean',
        default: false,
        displayOptions: { show: { '/operation': ['verify'] } },
      },
      {
        displayName: 'Ignore Not Before Claim',
        name: 'ignoreNotBefore',
        type: 'boolean',
        default: false,
        displayOptions: { show: { '/operation': ['verify'] } },
      },
      {
        displayName: 'Clock Tolerance',
        name: 'clockTolerance',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Seconds of allowed clock difference for exp and nbf',
        displayOptions: { show: { '/operation': ['verify'] } },
      },
      {
        displayName: 'Key ID',
        name: 'kid',
        type: 'string',
        default: '',
        description: 'Written to the kid header field',
        displayOptions: { show: { '/operation': ['sign'] } },
      },
      {
        displayName: 'Override Algorithm',
        name: 'algorithm',
        type: 'options',
        default: 'HS256',
        description: 'Use this algorithm instead of the one in the credential',
        options: algorithmOptions,
        displayOptions: { show: { '/operation': ['sign', 'verify'] } },
      },
    ],
  },
];

interface JwtCredential {
  keyType?: string;
  secret?: string;
  privateKey?: string;
  publicKey?: string;
  algorithm?: string;
}

function jsonObject(ctx: ExecuteContext, name: string, i: number, label: string): DataObject {
  const raw = ctx.getNodeParameter(name, i, '{}') as unknown;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      value = JSON.parse(raw);
    } catch {
      throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`, { itemIndex: i });
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`, { itemIndex: i });
  }
  return value as DataObject;
}

function claimsFromCollection(claims: DataObject, nowS: number): DataObject {
  const payload: DataObject = {};
  const text = (key: string, claim: string) => {
    const v = claims[key];
    if (typeof v === 'string' && v !== '') payload[claim] = v;
  };
  text('audience', 'aud');
  text('issuer', 'iss');
  text('jwtid', 'jti');
  text('subject', 'sub');
  // a claim the user never added writes nothing (a collection keeps only the keys that were added)
  const expiresIn = claims.expiresIn === undefined ? 0 : Number(claims.expiresIn);
  if (expiresIn > 0) payload.exp = nowS + Math.floor(expiresIn);
  const notBefore = claims.notBefore === undefined ? 0 : Number(claims.notBefore);
  if (notBefore > 0) payload.nbf = nowS + Math.floor(notBefore);
  return payload;
}

export const JwtNode: NodeType = {
  description: {
    name: 'core.jwt',
    displayName: 'JWT',
    description: 'Sign, decode or verify JSON Web Tokens',
    icon: 'lucide:key-square',
    group: ['transform'],
    version: 1,
    usableAsTool: true,
    defaults: { name: 'JWT' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['jwt', 'json web token', 'token', 'sign', 'verify'],
    credentials: [{ name: 'jwtAuth', required: true }],
    properties,
  },

  async execute(ctx) {
    const credential = await ctx.getCredentials<JwtCredential & DataObject>('jwtAuth');
    const credentialKey: JwtKey =
      credential.keyType === 'pemKey'
        ? { privateKey: String(credential.privateKey ?? ''), publicKey: String(credential.publicKey ?? '') }
        : { secret: String(credential.secret ?? '') };

    return [
      await mapItems(ctx, async (i) => {
        const node = ctx.getNode();
        const operation = ctx.getNodeParameter('operation', i, 'sign') as string;
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const algorithm = String(options.algorithm || credential.algorithm || 'HS256');
        try {
          if (operation === 'sign') {
            const nowMs = Date.now();
            const payload = ctx.getNodeParameter('useJson', i, false)
              ? jsonObject(ctx, 'claimsJson', i, 'The payload claims')
              : claimsFromCollection(
                  ctx.getNodeParameter('claims', i, {}) as DataObject,
                  Math.floor(nowMs / 1000),
                );
            const token = signJwt({
              payload,
              algorithm,
              key: credentialKey,
              header: jsonObject(ctx, 'headerClaims', i, 'The header claims'),
              kid: options.kid ? String(options.kid) : undefined,
              nowMs,
            });
            return { token };
          }

          const token = String(ctx.getNodeParameter('token', i, '') ?? '').trim();
          if (!token) throw new NodeOperationError(node, 'The JWT token was not provided', { itemIndex: i });
          const complete = options.complete === true;
          if (operation === 'decode') {
            const decoded = decodeJwt(token);
            return complete ? { ...decoded } : { payload: decoded.payload };
          }
          const verified = verifyJwt({
            token,
            algorithm,
            key: credentialKey,
            ignoreExpiration: options.ignoreExpiration === true,
            ignoreNotBefore: options.ignoreNotBefore === true,
            clockTolerance: Number(options.clockTolerance) || 0,
          });
          return complete ? { ...verified } : { payload: verified.payload };
        } catch (error) {
          if (error instanceof JwtError) {
            if (error.kind === 'signature') {
              throw new NodeOperationError(node, "The JWT token can't be verified", {
                itemIndex: i,
                description: 'Check the token encoding, the algorithm and the credential',
              });
            }
            throw new NodeOperationError(node, error.message, { itemIndex: i });
          }
          throw error;
        }
      }),
    ];
  },
};
