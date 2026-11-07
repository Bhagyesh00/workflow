import type { AiChatRequest, DataObject, Item, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { connect, modelRequests, node, reply, run, scriptModel } from './harness';

beforeEach(() => modelRequests.clear());

const methodOptions = (values: DataObject, extra: DataObject = {}) => ({
  options: { summarizationMethodAndPrompts: { values }, ...extra },
});

async function summarize(
  params: DataObject,
  items: Item[],
  extra: WorkflowNode[] = [],
  links: Parameters<typeof connect> = [],
  nodeExtra: Partial<WorkflowNode> = {},
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Sum', 'ai.chainSummarization', params, nodeExtra),
      node('Model', 'test.fakeChatModel'),
      ...extra,
    ],
    connect(['Trigger', 'Sum'], ['Model', 'Sum', 'ai_languageModel'], ...links),
    { triggerItems: items },
  );
}

const bin = (text: string, mimeType: string, fileName: string) => ({
  data: Buffer.from(text).toString('base64'),
  mimeType,
  fileName,
});

describe('Summarization parity', () => {
  it('JSON mode is the default and returns response.output_text', async () => {
    scriptModel('Model', ['Short version']);
    const r = await summarize({ text: '={{ $json.text }}' }, [{ json: { text: 'A long text about cats.' } }]);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Sum')).toEqual([{ response: { output_text: 'Short version' } }]);
  });

  it('simple chunking defaults to 1000 characters', async () => {
    const requests = scriptModel('Model', (_r: AiChatRequest, call) => reply(`m${call}`));
    const r = await summarize({}, [{ json: { text: 'word '.repeat(600) } }]); // 3000 characters
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(requests.length).toBeGreaterThanOrEqual(4); // 3 or more chunks, then a combine
    expect(String(requests[0].messages[0].content).length).toBeLessThan(1200);
  });

  it('binary mode reads the binary property', async () => {
    const requests = scriptModel('Model', ['From a file']);
    const r = await summarize({ operationMode: 'nodeInputBinary', ...methodOptions({ summarizationMethod: 'stuff' }) }, [
      { json: {}, binary: { data: bin('Dogs are loyal animals.', 'text/plain', 'a.txt') } },
    ]);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Sum')).toEqual([{ response: { output_text: 'From a file' } }]);
    expect(String(requests[0].messages[0].content)).toContain('Dogs are loyal animals.');
  });

  it('binary mode fails clearly when the property is missing', async () => {
    scriptModel('Model', ['x']);
    const r = await summarize({ operationMode: 'nodeInputBinary', options: { binaryDataKey: 'file' } }, [
      { json: {}, binary: { data: bin('hello', 'text/plain', 'a.txt') } },
    ]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('"file"');
  });

  it('document loader mode summarizes the loaded documents', async () => {
    const requests = scriptModel('Model', ['From loader']);
    const r = await summarize(
      { operationMode: 'documentLoader', ...methodOptions({ summarizationMethod: 'stuff' }) },
      [{ json: { text: 'Birds can fly high.' } }],
      [
        node('Loader', 'ai.documentDefaultDataLoader', {
          jsonMode: 'expressionData',
          jsonData: '={{ $json.text }}',
        }),
      ],
      [['Loader', 'Sum', 'ai_document']],
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Sum')).toEqual([{ response: { output_text: 'From loader' } }]);
    expect(String(requests[0].messages[0].content)).toContain('Birds can fly high.');
  });

  it('document loader mode needs the Document input', async () => {
    scriptModel('Model', ['x']);
    const r = await summarize({ operationMode: 'documentLoader' }, [{ json: { text: 'a' } }]);
    expect(r.status).toBe('error');
  });

  it('advanced chunking takes the connected text splitter', async () => {
    const requests = scriptModel('Model', (_r: AiChatRequest, call) => reply(`p${call}`));
    const r = await summarize(
      { chunkingMode: 'advanced', text: 'a b c d', ...methodOptions({ summarizationMethod: 'refine' }) },
      [{ json: {} }],
      [node('Splitter', 'ai.textSplitterCharacter', { separator: ' ', chunkSize: 1, chunkOverlap: 0 })],
      [['Splitter', 'Sum', 'ai_textSplitter']],
    );
    expect(r.output('Sum')).toEqual([{ response: { output_text: 'p3' } }]);
    expect(requests).toHaveLength(4);
  });

  it('uses the prompts of each method', async () => {
    const refine = scriptModel('Model', (_r: AiChatRequest, call) => reply(`r${call}`));
    await summarize(
      {
        chunkSize: 10,
        chunkOverlap: 0,
        ...methodOptions({
          summarizationMethod: 'refine',
          refineQuestionPrompt: 'FIRST {text}',
          refinePrompt: 'NEXT {existing_answer} / {text}',
        }),
      },
      [{ json: { text: 'aaaaa bbbbb ccccc' } }],
    );
    expect(String(refine[0].messages[0].content)).toMatch(/^FIRST /);
    expect(String(refine[1].messages[0].content)).toMatch(/^NEXT r0 \//);

    const stuff = scriptModel('Model', ['ok']);
    await summarize(methodOptions({ summarizationMethod: 'stuff', prompt: 'ONE {text}' }), [
      { json: { text: 'hello' } },
    ]);
    expect(stuff[0].messages[0].content).toBe('ONE hello');

    const mapped = scriptModel('Model', (_r: AiChatRequest, call) => reply(`m${call}`));
    await summarize(
      {
        chunkSize: 10,
        chunkOverlap: 0,
        ...methodOptions({ combineMapPrompt: 'MAP {text}', prompt: 'FINAL {text}' }),
      },
      [{ json: { text: 'aaaaa bbbbb ccccc' } }],
    );
    expect(String(mapped[0].messages[0].content)).toMatch(/^MAP /);
    expect(String(mapped.at(-1)!.messages[0].content)).toMatch(/^FINAL /);
  });

  it('runs batches and ends the node after the batch with a failure', async () => {
    let calls = 0;
    scriptModel('Model', () => {
      calls++;
      throw new Error('Revoked key');
    });
    const r = await summarize(
      { options: { batching: { batchSize: 2 } } },
      Array.from({ length: 6 }, (_, n) => ({ json: { text: `text ${n}` } })),
    );
    expect(r.status).toBe('error');
    expect(calls).toBe(2);
  });

  it('keeps going per item with continue on fail', async () => {
    scriptModel('Model', (request: AiChatRequest) => {
      if (String(request.messages[0].content).includes('bad')) throw new Error('boom');
      return reply('fine');
    });
    const r = await summarize(
      { options: { batching: { batchSize: 2 } } },
      [{ json: { text: 'ok' } }, { json: { text: 'bad' } }, { json: { text: 'ok' } }],
      [],
      [],
      { onError: 'continueRegularOutput' },
    );
    expect(r.output('Sum')).toEqual([
      { response: { output_text: 'fine' } },
      { error: 'boom' },
      { response: { output_text: 'fine' } },
    ]);
  });

  it('an empty text is an error', async () => {
    scriptModel('Model', ['x']);
    const r = await summarize({ text: '' }, [{ json: {} }]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('empty');
  });

  it('keeps the Parallel Requests option', async () => {
    const requests = scriptModel('Model', (_r: AiChatRequest, call) => reply(`c${call}`));
    const r = await summarize({ chunkSize: 10, chunkOverlap: 0, options: { concurrency: 1 } }, [
      { json: { text: 'aaaaa bbbbb ccccc' } },
    ]);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(requests.length).toBeGreaterThan(1);
  });
});
