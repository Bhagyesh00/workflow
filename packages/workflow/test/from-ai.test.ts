import { describe, expect, it } from 'vitest';
import { ExpressionError } from '../src/errors';
import {
  extractFromAiArguments,
  FROM_AI_MARKER,
  FromAiError,
  fromAiSchema,
  fromAiValue,
  fromAiVariables,
} from '../src/from-ai';

const scan = (value: string) => extractFromAiArguments({ value });

function failure(run: () => unknown): FromAiError {
  try {
    run();
  } catch (error) {
    return error as FromAiError;
  }
  throw new Error('expected a failure');
}

describe('extractFromAiArguments', () => {
  it('reads key, description, type and default', () => {
    expect(scan(`={{ $fromAI('city', 'The city', 'string', 'Pune') }}`)).toEqual([
      { key: 'city', description: 'The city', type: 'string', defaultValue: 'Pune' },
    ]);
  });

  it('a key alone is a string with no description and no default', () => {
    expect(scan(`={{ $fromAI('city') }}`)).toEqual([{ key: 'city', type: 'string' }]);
  });

  it('finds every spelling, in any case', () => {
    const found = extractFromAiArguments([
      `={{ $fromAI('a') }}`,
      `={{ $fromAi('b') }}`,
      `={{ $fromai('c') }}`,
      `={{ $FROMAI('d') }}`,
    ]);
    expect(found.map((a) => a.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('walks nested parameters and finds calls in strings that are not expressions', () => {
    const found = extractFromAiArguments({
      url: `https://x.test/$fromAI('path')`,
      options: { deep: [{ headers: [`={{ $fromAI('header') }}`] }] },
      number: 5,
      nothing: null,
      flag: true,
    });
    expect(found.map((a) => a.key)).toEqual(['path', 'header']);
  });

  it('reads own keys only', () => {
    const parameters = Object.create({ inherited: `={{ $fromAI('inherited') }}` }) as Record<string, unknown>;
    parameters.own = `={{ $fromAI('own') }}`;
    expect(extractFromAiArguments(parameters).map((a) => a.key)).toEqual(['own']);
  });

  it('allows spaces around the call and between the arguments', () => {
    expect(scan(`={{ $fromAI  (  'k' ,  "d"  ,  \`number\`  ) }}`)).toEqual([
      { key: 'k', description: 'd', type: 'number' },
    ]);
  });

  it('handles the three quotes and their escapes', () => {
    expect(scan(`$fromAI('a', 'it\\'s')`)[0].description).toBe(`it's`);
    expect(scan(`$fromAI("b", "say \\"hi\\"")`)[0].description).toBe('say "hi"');
    expect(scan(`$fromAI(\`c\`, \`the \\\` tick\`)`)[0].description).toBe('the ` tick');
    expect(scan(`$fromAI('d', 'a\\nb')`)[0].description).toBe('a\nb');
    expect(scan(`$fromAI('e', 'back\\\\slash')`)[0].description).toBe('back\\slash');
  });

  it('keeps commas and parentheses inside quotes', () => {
    expect(scan(`$fromAI('k', 'one, two (three) )')`)).toEqual([
      { key: 'k', description: 'one, two (three) )', type: 'string' },
    ]);
  });

  it('handles nested parentheses and finds a call nested in another', () => {
    const found = scan(`$fromAI('outer', 'd', 'string', $fromAI('inner'))`);
    expect(found.map((a) => a.key)).toEqual(['outer', 'inner']);
  });

  it('text inside a quoted argument is not a call', () => {
    const found = scan(`$fromAI('k', 'use $fromAI(\\'zz\\') here', 'string') $fromAI('next')`);
    expect(found.map((a) => a.key)).toEqual(['k', 'next']);
    expect(found[0].description).toBe(`use $fromAI('zz') here`);
    expect(scan(`$fromAI('k', 'text $fromAI(', 'string')`).map((a) => a.key)).toEqual(['k']);
  });

  it('takes the type in any case', () => {
    expect(scan(`$fromAI('k', 'd', 'NUMBER')`)[0].type).toBe('number');
    expect(scan(`$fromAI('k', 'd', 'Json')`)[0].type).toBe('json');
    expect(scan(`$fromAI('k', 'd', 'Boolean')`)[0].type).toBe('boolean');
  });

  it('an empty description or type counts as left out', () => {
    expect(scan(`$fromAI('k', '', '')`)).toEqual([{ key: 'k', type: 'string' }]);
  });

  it('parses a default by its type', () => {
    expect(scan(`$fromAI('k', 'd', 'string', 'text')`)[0].defaultValue).toBe('text');
    expect(scan(`$fromAI('k', 'd', 'string', 5)`)[0].defaultValue).toBe('5');
    expect(scan(`$fromAI('k', 'd', 'number', 5.5)`)[0].defaultValue).toBe(5.5);
    expect(scan(`$fromAI('k', 'd', 'number', '7')`)[0].defaultValue).toBe(7);
    expect(scan(`$fromAI('k', 'd', 'boolean', true)`)[0].defaultValue).toBe(true);
    expect(scan(`$fromAI('k', 'd', 'boolean', 'FALSE')`)[0].defaultValue).toBe(false);
    expect(scan(`$fromAI('k', 'd', 'json', {"a":1,"b":[2,3]})`)[0].defaultValue).toEqual({ a: 1, b: [2, 3] });
    expect(scan(`$fromAI('k', 'd', 'json', '[1, 2]')`)[0].defaultValue).toEqual([1, 2]);
  });

  it('a bad number or boolean default is tried as JSON, then kept as text', () => {
    expect(scan(`$fromAI('k', 'd', 'number', '{"a":1}')`)[0].defaultValue).toEqual({ a: 1 });
    expect(scan(`$fromAI('k', 'd', 'number', 'many')`)[0].defaultValue).toBe('many');
    expect(scan(`$fromAI('k', 'd', 'boolean', '[true]')`)[0].defaultValue).toEqual([true]);
    expect(scan(`$fromAI('k', 'd', 'boolean', 'perhaps')`)[0].defaultValue).toBe('perhaps');
    expect(scan(`$fromAI('k', 'd', 'json', 'not json')`)[0].defaultValue).toBe('not json');
  });

  it('an empty or undefined default is no default', () => {
    expect(scan(`$fromAI('k', 'd', 'string', '')`)[0]).not.toHaveProperty('defaultValue');
    expect(scan(`$fromAI('k', 'd', 'string', undefined)`)[0]).not.toHaveProperty('defaultValue');
  });

  it('a default of JSON with __proto__ stays plain data', () => {
    const { defaultValue } = scan(`$fromAI('k', 'd', 'json', '{"__proto__":{"polluted":1}}')`)[0];
    expect(Object.getPrototypeOf(defaultValue)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('the same key with the same description and type is one entry, and the last one wins', () => {
    const found = extractFromAiArguments({
      a: `$fromAI('k', 'd', 'string', 'first')`,
      b: `$fromAI('other')`,
      c: `$fromAI('k', 'd', 'string', 'last')`,
    });
    expect(found).toEqual([
      { key: 'k', description: 'd', type: 'string', defaultValue: 'last' },
      { key: 'other', type: 'string' },
    ]);
  });

  it('is not evaluated: a call that would throw or reach something is only text', () => {
    const found = scan(`={{ $fromAI('k', process.exit(1), 'string', globalThis.secret) }}`);
    expect(found[0].key).toBe('k');
    expect(found[0].description).toBe('process.exit(1)');
    expect(found[0].defaultValue).toBe('globalThis.secret');
  });

  it('skips reserved names: they are refused at run time, not in the scan', () => {
    for (const key of ['constructor', 'prototype', 'getPrototypeOf', '__proto__']) {
      expect(scan(`$fromAI('${key}')`).map((a) => a.key)).toEqual([key]);
    }
  });

  it('the override marker in front of a call changes nothing', () => {
    expect(scan(`={{ ${FROM_AI_MARKER} $fromAI('k', 'd') }}`)).toEqual([
      { key: 'k', description: 'd', type: 'string' },
    ]);
  });

  it('no call, no argument', () => {
    expect(extractFromAiArguments({ a: 'plain', b: '={{ $json.x }}', c: '$fromAIish(1)' })).toEqual([]);
    expect(extractFromAiArguments(undefined)).toEqual([]);
    expect(extractFromAiArguments(null)).toEqual([]);
  });

  describe('errors users see', () => {
    it('no key', () => {
      for (const text of ['$fromAI()', `$fromAI('')`, '$fromAI(  )']) {
        expect(failure(() => scan(text)).message).toBe('You must specify a key when using $fromAI()');
      }
    });

    it('a bad key names the key and explains the rule', () => {
      for (const key of ['has space', 'a.b', 'x'.repeat(65), 'ключ']) {
        const error = failure(() => scan(`$fromAI('${key}')`));
        expect(error.message).toBe(`Parameter key \`${key}\` is invalid`);
        expect(error.description).toBe(
          'Invalid parameter key, must be between 1 and 64 characters long and only contain letters, numbers, underscores, and hyphens',
        );
      }
      expect(scan(`$fromAI('${'x'.repeat(64)}')`)[0].key).toHaveLength(64);
      expect(scan(`$fromAI('a-b_C9')`)[0].key).toBe('a-b_C9');
    });

    it('a key that is not a text literal is a bad key', () => {
      expect(failure(() => scan(`$fromAI('a' + 'b')`)).message).toBe(
        `Parameter key \`'a' + 'b'\` is invalid`,
      );
    });

    it('a duplicate with another description or type', () => {
      const description =
        'Ensure all $fromAI() calls with the same key have consistent descriptions and types';
      const other = failure(() => scan(`$fromAI('k', 'one') $fromAI('k', 'two')`));
      expect(other.message).toBe(`Duplicate key 'k' found with different description or type`);
      expect(other.description).toBe(description);
      const type = failure(() => scan(`$fromAI('k', 'd', 'string') $fromAI('k', 'd', 'number')`));
      expect(type.message).toBe(`Duplicate key 'k' found with different description or type`);
      expect(type.description).toBe(description);
    });

    it('a bad type', () => {
      expect(failure(() => scan(`$fromAI('k', 'd', 'date')`)).message).toBe(
        `Failed to parse $fromAI arguments: 'k', 'd', 'date': Invalid type: date`,
      );
    });

    it('unbalanced parentheses, also from a quote that never closes', () => {
      expect(failure(() => scan(`$fromAI('k', ('d')`)).message).toBe(
        `Unbalanced parentheses while parsing $fromAI call: 'k', ('d')`,
      );
      expect(failure(() => scan(`$fromAI('k)`)).message).toBe(
        `Unbalanced parentheses while parsing $fromAI call: 'k)`,
      );
    });

    it('all of them are expression errors of the FromAiError class', () => {
      const error = failure(() => scan('$fromAI()'));
      expect(error).toBeInstanceOf(FromAiError);
      expect(error).toBeInstanceOf(ExpressionError);
    });
  });
});

describe('fromAiSchema', () => {
  it('no call gives an empty schema', () => {
    expect(fromAiSchema({ url: 'https://x.test' })).toEqual({ type: 'object', properties: {} });
  });

  it('gives one property per key with its type and description; keys without a default are required', () => {
    expect(
      fromAiSchema({
        a: `$fromAI('text', 'The text')`,
        b: `$fromAI('count', 'How many', 'number')`,
        c: `$fromAI('on', 'Is it on', 'boolean')`,
        d: `$fromAI('bare')`,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text' },
        count: { type: 'number', description: 'How many' },
        on: { type: 'boolean', description: 'Is it on' },
        bare: { type: 'string' },
      },
      required: ['text', 'count', 'on', 'bare'],
    });
  });

  it('a key with a default is not required and carries the default', () => {
    const schema = fromAiSchema({
      a: `$fromAI('limit', 'How many', 'number', 10)`,
      b: `$fromAI('needed')`,
    });
    expect(schema.properties).toMatchObject({ limit: { type: 'number', default: 10 } });
    expect(schema.required).toEqual(['needed']);
  });

  it('json means a non-empty object or a non-empty array, by minProperties and minItems', () => {
    const schema = fromAiSchema({ a: `$fromAI('data', 'The data', 'json')` });
    expect((schema.properties as Record<string, unknown>).data).toEqual({
      description: 'The data',
      anyOf: [
        { type: 'object', minProperties: 1 },
        { type: 'array', items: {}, minItems: 1 },
      ],
    });
    expect(schema.required).toEqual(['data']);
  });

  it('a key named __proto__ becomes an own property and touches no prototype', () => {
    const schema = fromAiSchema({ a: `$fromAI('__proto__', 'bad')` });
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
    expect(schema.required).toEqual(['__proto__']);
  });

  it('passes the scan errors on', () => {
    expect(() => fromAiSchema({ a: '$fromAI()' })).toThrow('You must specify a key when using $fromAI()');
  });
});

describe('run time, as C0 built it', () => {
  it('reads query, then the arguments, then the default', () => {
    expect(fromAiValue({ query: { k: 'q' }, k: 'a' }, 'k')).toBe('q');
    expect(fromAiValue({ k: 'a' }, 'k')).toBe('a');
    expect(fromAiValue({}, 'k', 'd', 'string', 'fallback')).toBe('fallback');
  });

  it('own keys only', () => {
    const args = Object.create({ inherited: 'no' }) as Record<string, never>;
    expect(fromAiValue(args, 'inherited', '', '', 'default')).toBe('default');
    expect(fromAiValue({ query: args }, 'inherited', '', '', 'default')).toBe('default');
    expect(fromAiValue({}, 'toString', '', '', 'default')).toBe('default');
  });

  it('reserved names are refused, also when the scan took them', () => {
    for (const key of ['__proto__', 'prototype', 'constructor', 'getPrototypeOf']) {
      expect(failure(() => fromAiValue({}, key)).message).toBe('Invalid parameter key');
    }
  });

  it('the run-time texts', () => {
    expect(failure(() => fromAiValue({}, '')).message).toBe("Add a key, e.g. $fromAI('placeholder_name')");
    expect(failure(() => fromAiValue({}, 'a b')).message).toBe(
      'Invalid parameter key, must be between 1 and 64 characters long and only contain lowercase letters, uppercase letters, numbers, underscores, and hyphens',
    );
    expect(failure(() => fromAiValue(undefined, 'k')).message).toBe('No execution data available');
  });

  it('the three spellings read the same arguments', () => {
    const variables = fromAiVariables({ k: 'v' }) as Record<string, (key: string) => unknown>;
    expect(variables.$fromAI('k')).toBe('v');
    expect(variables.$fromAi('k')).toBe('v');
    expect(variables.$fromai('k')).toBe('v');
  });
});
