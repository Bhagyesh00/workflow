import { describe, expect, it } from 'vitest';
import { NodeTypes } from '../src/registry';

const nt = (name: string) =>
  ({
    description: {
      name,
      displayName: name,
      description: '',
      group: [],
      version: 1,
      defaults: { name },
      inputs: ['main'],
      outputs: ['main'],
      properties: [],
    },
    async execute() {
      return [[]];
    },
  }) as never;

describe('NodeTypes.unregister', () => {
  it('removes a type, reports whether it existed, and allows a later register', () => {
    const r = new NodeTypes([nt('a'), nt('b')]);
    expect(r.unregister('a')).toBe(true);
    expect(r.get('a')).toBeUndefined();
    expect(r.unregister('a')).toBe(false);
    expect(r.list().map((n) => n.description.name)).toEqual(['b']);
    r.register(nt('a'));
    expect(r.get('a')).toBeTruthy();
  });
});
