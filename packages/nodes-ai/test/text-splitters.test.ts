import { beforeEach, describe, expect, it } from 'vitest';
import { clearMemoryVectorStores } from '../src/nodes/vector-stores/vector-stores.nodes';
import { CODE_LANGUAGES, codeSeparators } from '../src/shared/code-separators';
import { splitCode } from '../src/shared/text-splitting';
import { countTokens, splitByTokens } from '../src/shared/token-splitting';
import { connect, node, run } from './harness';

async function splitThrough(
  splitter: ReturnType<typeof node>,
  text: string,
): Promise<{ chunks: string[]; status: string; message?: string }> {
  clearMemoryVectorStores();
  const r = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Store', 'ai.vectorStoreInMemory', { mode: 'insert', memoryKey: `split-${Math.random()}` }),
      node('Loader', 'ai.documentDefaultDataLoader', {
        jsonMode: 'expressionData',
        jsonData: '={{ $json.text }}',
        textSplittingMode: 'custom',
      }),
      splitter,
      node('Embeddings', 'test.fakeEmbeddings'),
    ],
    connect(
      ['Trigger', 'Store'],
      ['Loader', 'Store', 'ai_document'],
      [splitter.name, 'Loader', 'ai_textSplitter'],
      ['Embeddings', 'Store', 'ai_embedding'],
    ),
    { triggerItems: [{ json: { text } }] },
  );
  const out = r.status === 'success' ? (r.output('Store') as Array<{ pageContent: string }>) : [];
  return { chunks: out.map((d) => d.pageContent), status: r.status, message: r.error?.message };
}

describe('Token Text Splitter', () => {
  it('counts known cl100k tokens: "hello world" is 2', async () => {
    expect(await countTokens('hello world')).toBe(2);
  });

  it('allows special tokens: <|endoftext|> is one token, not an error', async () => {
    expect(await countTokens('<|endoftext|>')).toBe(1);
  });

  it('splits by token count with overlap', async () => {
    const text = 'one two three four five six seven eight';
    const plain = await splitByTokens(text, { chunkSize: 3, chunkOverlap: 0 });
    expect(plain).toEqual(['one two three', ' four five six', ' seven eight']);
    const overlap = await splitByTokens(text, { chunkSize: 4, chunkOverlap: 2 });
    expect(overlap[0]).toBe('one two three four');
    expect(overlap[1]).toBe(' three four five six');
    expect(overlap.at(-1)).toContain('eight');
    for (const chunk of overlap) expect(await countTokens(chunk)).toBeLessThanOrEqual(4);
  });

  it('refuses overlap >= chunk size and a chunk size below 1', async () => {
    await expect(splitByTokens('a', { chunkSize: 5, chunkOverlap: 5 })).rejects.toThrow(
      /smaller than the chunk size/,
    );
    await expect(splitByTokens('a', { chunkSize: 0, chunkOverlap: 0 })).rejects.toThrow();
  });

  it('returns nothing for empty text and keeps multi-byte text whole', async () => {
    expect(await splitByTokens('', { chunkSize: 5, chunkOverlap: 0 })).toEqual([]);
    const text = 'héllo wörld 日本語のテキスト 🙂 done';
    const chunks = await splitByTokens(text, { chunkSize: 1000, chunkOverlap: 0 });
    expect(chunks).toEqual([text]);
  });

  it('a one million character run finishes in under 5 seconds', async () => {
    const started = Date.now();
    const chunks = await splitByTokens('a'.repeat(1_000_000), { chunkSize: 1000, chunkOverlap: 0 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(chunks.join('')).toBe('a'.repeat(1_000_000));
    expect(chunks.length).toBeGreaterThan(100);
    const spaces = await splitByTokens(`${' '.repeat(300_000)}x`, { chunkSize: 1000, chunkOverlap: 0 });
    expect(spaces.join('').length).toBeGreaterThan(0);
  });

  it.each([
    ['a', 400],
    ['ab', 400],
    ['!', 400],
    ['😀', 200],
    ['中', 400],
    ['中', 16],
    ['x', 47],
    ['é', 24],
  ])('a megabyte of "%s" runs of %i characters finishes in under 5 seconds', async (unit, length) => {
    const text = `${unit.repeat(length)} `.repeat(Math.ceil(1_000_000 / (length + 1)));
    const started = Date.now();
    const chunks = await splitByTokens(text, { chunkSize: 1000, chunkOverlap: 0 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(chunks.join('')).toBe(text);
  });

  it('a megabyte of mixed CJK prose and ASCII finishes in under 5 seconds', async () => {
    const sentence = '这是一个很长的句子，没有空格，用来测试分词器的速度。hello world 日本語のテキストです。';
    const text = sentence.repeat(Math.ceil(1_000_000 / sentence.length));
    const started = Date.now();
    const chunks = await splitByTokens(text, { chunkSize: 1000, chunkOverlap: 100 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(chunks.length).toBeGreaterThan(100);
  });

  it('counts a CJK run past the encode limit near one token per character', async () => {
    const run = '中'.repeat(300);
    const chunks = await splitByTokens(run, { chunkSize: 100, chunkOverlap: 0 });
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 100]);
  });

  it('the node uses defaults 1000 and 0 and splits a loader document', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const r = await splitThrough(
      node('Tokens', 'ai.textSplitterTokenSplitter', { chunkSize: 10, chunkOverlap: 0 }),
      text,
    );
    expect(r.status, r.message).toBe('success');
    expect(r.chunks.length).toBeGreaterThan(2);
    const whole = await splitThrough(node('Tokens', 'ai.textSplitterTokenSplitter', {}), text);
    expect(whole.chunks).toEqual([text]);
  });

  it('the node refuses overlap >= chunk size', async () => {
    const r = await splitThrough(
      node('Tokens', 'ai.textSplitterTokenSplitter', { chunkSize: 10, chunkOverlap: 10 }),
      'x',
    );
    expect(r.status).toBe('error');
    expect(r.message).toContain('smaller than the chunk size');
  });
});

describe('code splitting', () => {
  it('lists the 15 languages, each with separators ending in the empty string', () => {
    expect([...CODE_LANGUAGES].sort()).toEqual(
      [
        'cpp',
        'go',
        'html',
        'java',
        'js',
        'latex',
        'markdown',
        'php',
        'proto',
        'python',
        'rst',
        'ruby',
        'rust',
        'scala',
        'swift',
      ].sort(),
    );
    for (const language of CODE_LANGUAGES) {
      const separators = codeSeparators(language);
      expect(separators.length, language).toBeGreaterThan(3);
      expect(separators.at(-1), language).toBe('');
    }
    expect(() => codeSeparators('cobol')).toThrow(/Unknown code language/);
  });

  it('python splits on its own definitions and keeps the keyword', () => {
    const code = [
      'class Cat:',
      '    def meow(self):',
      '        return "meow meow"',
      '',
      'def walk():',
      '    return "walking along"',
      '',
      'def sleep():',
      '    return "sleeping soundly"',
    ].join('\n');
    const chunks = splitCode(code, { chunkSize: 60, chunkOverlap: 0 }, 'python');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some((c) => c.startsWith('def walk'))).toBe(true);
    expect(chunks.some((c) => c.startsWith('def sleep'))).toBe(true);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
  });

  it('js, go and markdown split on their own markers', () => {
    const js = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\nconst c = 3;';
    const jsChunks = splitCode(js, { chunkSize: 30, chunkOverlap: 0 }, 'js');
    expect(jsChunks.some((c) => c.startsWith('function b'))).toBe(true);
    const go = 'func one() int {\n\treturn 1\n}\nfunc two() int {\n\treturn 2\n}\n';
    expect(
      splitCode(go, { chunkSize: 30, chunkOverlap: 0 }, 'go').some((c) => c.startsWith('func two')),
    ).toBe(true);
    const md = '# Title\n\nintro text here\n\n## Part\n\nbody of the part goes here';
    const mdChunks = splitCode(md, { chunkSize: 30, chunkOverlap: 0 }, 'markdown');
    expect(mdChunks.some((c) => c.startsWith('## Part'))).toBe(true);
  });

  it('the recursive node splits code with splitCode and keeps Separators when no language is set', async () => {
    const code = 'def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3';
    const withCode = await splitThrough(
      node('Rec', 'ai.textSplitterRecursiveCharacter', {
        chunkSize: 25,
        options: { splitCode: 'python' },
      }),
      code,
    );
    expect(withCode.status, withCode.message).toBe('success');
    expect(withCode.chunks.some((c) => c.startsWith('def b'))).toBe(true);
    expect(withCode.chunks.some((c) => c.startsWith('def c'))).toBe(true);
    const custom = await splitThrough(
      node('Rec', 'ai.textSplitterRecursiveCharacter', {
        chunkSize: 8,
        options: { separators: '["|", ""]' },
      }),
      'aaa|bbb|ccc|ddd',
    );
    expect(custom.chunks).toEqual(['aaa|bbb', 'ccc|ddd']);
  });
});

describe('splitter defaults', () => {
  beforeEach(() => clearMemoryVectorStores());

  it('recursive has overlap 0 and character has an empty separator by default', async () => {
    const { textSplitterNodes } = await import('../src/nodes/text-splitters/text-splitters.nodes');
    const find = (name: string) => textSplitterNodes.find((n) => n.description.name === name)!;
    const prop = (name: string, field: string) =>
      find(name).description.properties.find((p) => p.name === field)!;
    expect(prop('ai.textSplitterRecursiveCharacter', 'chunkSize').default).toBe(1000);
    expect(prop('ai.textSplitterRecursiveCharacter', 'chunkOverlap').default).toBe(0);
    expect(prop('ai.textSplitterCharacter', 'chunkOverlap').default).toBe(0);
    expect(prop('ai.textSplitterCharacter', 'separator').default).toBe('');
    expect(prop('ai.textSplitterTokenSplitter', 'chunkSize').default).toBe(1000);
    expect(prop('ai.textSplitterTokenSplitter', 'chunkOverlap').default).toBe(0);
  });

  it('a character splitter with the empty separator splits by characters', async () => {
    const r = await splitThrough(
      node('Chars', 'ai.textSplitterCharacter', { separator: '', chunkSize: 4, chunkOverlap: 0 }),
      'abcdefghij',
    );
    expect(r.chunks).toEqual(['abcd', 'efgh', 'ij']);
  });
});
