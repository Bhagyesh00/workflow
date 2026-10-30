import type { AiDocument, DataObject, Item } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { flattenJson, parseCsv } from '../src/nodes/document-loaders/DocumentDefaultDataLoader.node';
import { parseItemList, structuredParser } from '../src/nodes/output-parsers/output-parsers.nodes';
import { clearMemoryVectorStores } from '../src/nodes/vector-stores/vector-stores.nodes';
import {
  schemaFromExample,
  toAnthropicSchema,
  toGeminiSchema,
  validateJsonSchema,
} from '../src/shared/json-schema';
import { mergeSplits, splitByCharacter, splitRecursively } from '../src/shared/text-splitting';
import { extractJson, redactSecrets } from '../src/shared/utils';
import { connect, modelRequests, node, run, scriptModel } from './harness';

describe('text splitters', () => {
  it('recursive splitter keeps paragraphs, then lines, then words together', () => {
    const text =
      'First paragraph is short.\n\nSecond paragraph is a bit longer than the first one.\n\nThird.';
    expect(splitRecursively(text, { chunkSize: 60, chunkOverlap: 0 })).toEqual([
      'First paragraph is short.',
      'Second paragraph is a bit longer than the first one.\n\nThird.',
    ]);
    const words = splitRecursively('one two three four five six seven', { chunkSize: 10, chunkOverlap: 0 });
    expect(words).toEqual(['one two', 'three four', 'five six', 'seven']);
    expect(words.every((c) => c.length <= 10)).toBe(true);
  });

  it('applies overlap between chunks', () => {
    const chunks = splitByCharacter('a b c d e f g h', ' ', { chunkSize: 5, chunkOverlap: 2 });
    expect(chunks).toEqual(['a b c', 'c d e', 'e f g', 'g h']);
  });

  it('hard-splits text without separators', () => {
    const chunks = splitRecursively('x'.repeat(25), { chunkSize: 10, chunkOverlap: 0 }, ['\n']);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
  });

  it('validates sizes', () => {
    expect(() => splitByCharacter('a', ' ', { chunkSize: 5, chunkOverlap: 5 })).toThrow(
      /smaller than the chunk size/,
    );
    expect(() => splitRecursively('a', { chunkSize: 0, chunkOverlap: 0 })).toThrow();
    expect(mergeSplits([], ' ', { chunkSize: 5, chunkOverlap: 0 })).toEqual([]);
  });

  it('splitter nodes supply a text splitter (via the loader)', async () => {
    clearMemoryVectorStores();
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'ai.vectorStoreInMemory', { mode: 'insert', memoryKey: 'split' }),
        node('Loader', 'ai.documentDefaultDataLoader', {
          jsonMode: 'expressionData',
          jsonData: '={{ $json.text }}',
          textSplittingMode: 'custom',
        }),
        node('Splitter', 'ai.textSplitterRecursiveCharacter', { chunkSize: 12, chunkOverlap: 0 }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Splitter', 'Loader', 'ai_textSplitter'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: [{ json: { text: 'alpha beta gamma delta' } }] },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Store')).toEqual([
      { pageContent: 'alpha beta', metadata: { source: 'json', chunk: 0 } },
      { pageContent: 'gamma delta', metadata: { source: 'json', chunk: 1 } },
    ]);
    expect(r.runData.Splitter).toHaveLength(1);
  });

  it('the character splitter rejects overlap >= chunk size', async () => {
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'ai.vectorStoreInMemory', { mode: 'insert' }),
        node('Loader', 'ai.documentDefaultDataLoader', { textSplittingMode: 'custom' }),
        node('Splitter', 'ai.textSplitterCharacter', { chunkSize: 10, chunkOverlap: 10 }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Splitter', 'Loader', 'ai_textSplitter'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: [{ json: { text: 'x' } }] },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('smaller than the chunk size');
  });
});

describe('Default Data Loader', () => {
  beforeEach(() => clearMemoryVectorStores());

  async function loadDocs(loaderParams: DataObject, items: Item[]) {
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'ai.vectorStoreInMemory', { mode: 'insert' }),
        node('Loader', 'ai.documentDefaultDataLoader', loaderParams),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: items },
    );
    return { r, docs: r.output('Store') as unknown as AiDocument[] };
  }

  const file = (text: string, mimeType: string, fileName: string) => ({
    data: Buffer.from(text).toString('base64'),
    mimeType,
    fileName,
  });

  it('loads all item fields as key: value lines', async () => {
    const { docs } = await loadDocs({}, [
      { json: { name: 'Ada', tags: ['math', 'code'], address: { city: 'London' } } },
    ]);
    expect(docs).toEqual([
      {
        pageContent: 'name: Ada\ntags[0]: math\ntags[1]: code\naddress.city: London',
        metadata: { source: 'json' },
      },
    ]);
  });

  it('loads CSV, JSON and text files', async () => {
    const { r, docs } = await loadDocs({ dataType: 'binary' }, [
      {
        json: {},
        binary: {
          csv: file('name,role\n"Ada, Countess",math\nAlan,"says ""hi"""\n', 'text/csv', 'people.csv'),
          json: file('[{"q": 1}, {"q": 2}]', 'application/json', 'q.json'),
          txt: file('Plain words.', 'text/plain', 'notes.txt'),
        },
      },
    ]);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(docs).toEqual([
      {
        pageContent: 'name: Ada, Countess\nrole: math',
        metadata: { source: 'blob', blobType: 'text/csv', fileName: 'people.csv', line: 2 },
      },
      {
        pageContent: 'name: Alan\nrole: says "hi"',
        metadata: { source: 'blob', blobType: 'text/csv', fileName: 'people.csv', line: 3 },
      },
      {
        pageContent: 'q: 1',
        metadata: { source: 'blob', blobType: 'application/json', fileName: 'q.json', index: 0 },
      },
      {
        pageContent: 'q: 2',
        metadata: { source: 'blob', blobType: 'application/json', fileName: 'q.json', index: 1 },
      },
      {
        pageContent: 'Plain words.',
        metadata: { source: 'blob', blobType: 'text/plain', fileName: 'notes.txt' },
      },
    ]);
  });

  it('refuses binary formats it cannot read', async () => {
    const { r } = await loadDocs({ dataType: 'binary' }, [
      { json: {}, binary: { data: file('%PDF-1.7', 'application/pdf', 'a.pdf') } },
    ]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('cannot be loaded as text');
  });

  it('parses CSV edge cases and flattens JSON', () => {
    expect(parseCsv('a;b\r\n1;"x;y"\r\n\r\n', ';')).toEqual([
      ['a', 'b'],
      ['1', 'x;y'],
    ]);
    expect(flattenJson({ a: [{ b: null, c: true }] })).toEqual(['a[0].c: true']);
  });
});

describe('output parsers', () => {
  it('structured parser extracts and validates JSON', async () => {
    const parser = structuredParser(schemaFromExample({ name: 'x', tags: ['a'] }));
    expect(await parser.parse('Here you go:\n```json\n{"name": "n", "tags": ["t"]}\n```')).toEqual({
      name: 'n',
      tags: ['t'],
    });
    await expect(parser.parse('{"name": 1, "tags": []}')).rejects.toThrow('$.name must be string');
    await expect(parser.parse('no json')).rejects.toThrow('not valid JSON');
    expect(parser.getFormatInstructions()).toContain('"required":["name","tags"]');
  });

  it('item list parser strips bullets and numbering', () => {
    expect(parseItemList('1. one\n2) two\n- three\n\n* four', '\\n')).toEqual([
      'one',
      'two',
      'three',
      'four',
    ]);
    expect(parseItemList('a, b ,c', ',', 2)).toEqual(['a', 'b']);
  });

  it('auto-fixing parser asks its model to repair invalid output', async () => {
    modelRequests.clear();
    scriptModel('Agent model', ['{"city": "Lyon"'] /* broken JSON */);
    const fixer = scriptModel('Fixer model', ['{"city": "Lyon"}']);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent'),
        node('Agent model', 'test.fakeChatModel'),
        node('Fixing', 'ai.outputParserAutofixing'),
        node('Fixer model', 'test.fakeChatModel'),
        node('Structured', 'ai.outputParserStructured', { jsonSchemaExample: '{"city": "Paris"}' }),
      ],
      connect(
        ['Chat', 'Agent'],
        ['Agent model', 'Agent', 'ai_languageModel'],
        ['Fixing', 'Agent', 'ai_outputParser'],
        ['Fixer model', 'Fixing', 'ai_languageModel'],
        ['Structured', 'Fixing', 'ai_outputParser'],
      ),
      { triggerItems: [{ json: { sessionId: 's', chatInput: 'Where?' } }] },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: { city: 'Lyon' } }]);
    const prompt = String(fixer[0].messages[0].content);
    expect(prompt).toContain('{"city": "Lyon"');
    expect(prompt).toContain('not valid JSON');
    expect(fixer[0].responseFormat?.type).toBe('json');
  });
});

describe('JSON schema helpers', () => {
  it('validates types, required, enums, nesting and additional properties', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        kind: { enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        nested: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        maybe: { type: ['string', 'null'] },
      },
      required: ['id'],
    };
    expect(
      validateJsonSchema({ id: 1, kind: 'a', tags: ['x'], nested: { ok: true }, maybe: null }, schema),
    ).toEqual([]);
    const errors = validateJsonSchema(
      { id: 0.5, kind: 'c', tags: ['x', 1, 'z'], nested: { extra: 1 } },
      schema,
    ).map((e) => `${e.path} ${e.message}`);
    expect(errors).toEqual([
      '$.id must be integer, got number',
      '$.kind must be one of "a", "b"',
      '$.tags must have at most 2 items',
      '$.tags[1] must be string, got integer',
      '$.nested.ok is required',
      '$.nested.extra is not an allowed property',
    ]);
    expect(validateJsonSchema({}, schema)).toEqual([{ path: '$.id', message: 'is required' }]);
  });

  it('resolves local $refs and anyOf', () => {
    const schema = { $defs: { n: { type: 'number' } }, anyOf: [{ $ref: '#/$defs/n' }, { type: 'string' }] };
    expect(validateJsonSchema(3, schema)).toEqual([]);
    expect(validateJsonSchema(true, schema)).toHaveLength(1);
  });

  it('converts schemas for Anthropic and Gemini', () => {
    const schema = {
      $schema: 'x',
      type: 'object',
      properties: { n: { type: 'number', minimum: 0 }, s: { type: ['string', 'null'], maxLength: 3 } },
      required: ['n'],
    };
    expect(toAnthropicSchema(schema)).toEqual({
      type: 'object',
      properties: { n: { type: 'number' }, s: { type: ['string', 'null'] } },
      required: ['n'],
      additionalProperties: false,
    });
    expect(toAnthropicSchema({ type: 'object' })).toBeUndefined();
    expect(toGeminiSchema(schema)).toEqual({
      type: 'object',
      properties: { n: { type: 'number', minimum: 0 }, s: { type: 'string', nullable: true } },
      required: ['n'],
    });
  });

  it('extracts JSON from model text', () => {
    expect(extractJson('  {"a":1} ')).toEqual({ a: 1 });
    expect(extractJson('Sure! [1,2] is the list')).toEqual([1, 2]);
    expect(() => extractJson('nothing')).toThrow();
  });
});

describe('secret redaction', () => {
  it('removes common credential formats', () => {
    const text = [
      'openai sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws AKIAABCDEFGHIJKLMNOP',
      'auth: Bearer abcdefghijklmnopqrstuvwxyz',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
      'keep normal words and numbers 12345',
    ].join('\n');
    expect(redactSecrets(text)).toBe(
      [
        'openai [redacted]',
        'gh [redacted]',
        'aws [redacted]',
        'auth: Bearer [redacted]',
        'jwt [redacted]',
        '[redacted]',
        'keep normal words and numbers 12345',
      ].join('\n'),
    );
  });
});
