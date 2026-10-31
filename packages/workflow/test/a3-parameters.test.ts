import { describe, expect, it } from 'vitest';
import type { NodeProperty } from '../src/interfaces';
import { resolveNodeParameters } from '../src/parameters';

const properties: NodeProperty[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    default: 'message',
    options: [
      { name: 'Message', value: 'message' },
      { name: 'User', value: 'user' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    default: 'send',
    displayOptions: { show: { resource: ['message'] } },
    options: [{ name: 'Send', value: 'send' }],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    default: 'info',
    displayOptions: { show: { resource: ['user'] } },
    options: [{ name: 'Get', value: 'info' }],
  },
  {
    displayName: 'User',
    name: 'user',
    type: 'string',
    default: '',
    displayOptions: { show: { resource: ['user'], operation: ['info'] } },
  },
  {
    displayName: 'Text',
    name: 'text',
    type: 'string',
    default: '',
    displayOptions: { show: { resource: ['message'], operation: ['send'] } },
  },
];

describe('resolveNodeParameters same-named properties (R50)', () => {
  it('takes the default of the displayed property when the operation is not stored', () => {
    const out = resolveNodeParameters(properties, { resource: 'user', user: 'U1' });
    expect(out.operation).toBe('info');
    expect(out.user).toBe('U1');
    expect(out).not.toHaveProperty('text');
  });

  it('still uses the first default for the first resource', () => {
    const out = resolveNodeParameters(properties, { text: 'hi' });
    expect(out.resource).toBe('message');
    expect(out.operation).toBe('send');
    expect(out.text).toBe('hi');
  });

  it('keeps an explicitly stored operation', () => {
    const out = resolveNodeParameters(properties, { resource: 'user', operation: 'info', user: 'U1' });
    expect(out.operation).toBe('info');
    expect(out.user).toBe('U1');
  });
});
