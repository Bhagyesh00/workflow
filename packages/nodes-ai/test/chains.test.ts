import type { AiChatRequest, DataObject, WorkflowNode } from '@workflow/workflow';
import { evaluateSimple } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SentimentAnalysisNode,
  schemaFromAttributes,
  TextClassifierNode,
} from '../src/nodes/chains/llm-chains.nodes';
import { connect, modelRequests, node, reply, run, scriptModel } from './harness';

beforeEach(() => modelRequests.clear());

async function chain(
  root: WorkflowNode,
  items: DataObject[],
  extra: WorkflowNode[] = [],
  links: Parameters<typeof connect> = [],
) {
  return run(
    [node('Trigger', 'test.trigger'), root, node('Model', 'test.fakeChatModel'), ...extra],
    connect(['Trigger', root.name], ['Model', root.name, 'ai_languageModel'], ...links),
    { triggerItems: items.map((json) => ({ json })) },
  );
}

describe('Basic LLM Chain', () => {
  it('sends fixed messages and the prompt, outputs text', async () => {
    const requests = scriptModel('Model', ['Bonjour']);
    const r = await chain(
      node('Chain', 'ai.chainLlm', {
        promptType: 'define',
        text: '=Translate: {{ $json.text }}',
        messages: {
          messageValues: [
            { type: 'system', message: 'You translate to French.' },
            { type: 'user', message: 'Translate: Bye' },
            { type: 'assistant', message: 'Au revoir' },
          ],
        },
      }),
      [{ text: 'Hello' }],
    );
    expect(r.output('Chain')).toEqual([{ text: 'Bonjour' }]);
    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'You translate to French.' },
      { role: 'user', content: 'Translate: Bye' },
      { role: 'assistant', content: 'Au revoir' },
      { role: 'user', content: 'Translate: Hello' },
    ]);
  });

  it('uses an output parser', async () => {
    scriptModel('Model', ['- red\n- green\n- blue']);
    const r = await chain(
      node('Chain', 'ai.chainLlm', {
        promptType: 'define',
        text: 'List three colours',
        hasOutputParser: true,
      }),
      [{}],
      [node('List', 'ai.outputParserItemList', { options: { numberOfItems: 2 } })],
      [['List', 'Chain', 'ai_outputParser']],
    );
    expect(r.output('Chain')).toEqual([{ data: ['red', 'green'] }]);
    const system = modelRequests.get('Model')![0].messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('at most 2 items');
  });

  it('runs once per item', async () => {
    scriptModel('Model', (request: AiChatRequest) => reply(`echo ${request.messages.at(-1)!.content}`));
    const r = await chain(node('Chain', 'ai.chainLlm', { promptType: 'define', text: '={{ $json.q }}' }), [
      { q: 'a' },
      { q: 'b' },
    ]);
    expect(r.output('Chain')).toEqual([{ text: 'echo a' }, { text: 'echo b' }]);
  });
});

describe('Information Extractor', () => {
  it('builds a schema from attributes and validates the output', async () => {
    const requests = scriptModel('Model', [
      '{"company": "Acme", "founded": "1999"}',
      '{"company": "Acme", "founded": 1999}',
    ]);
    const r = await chain(
      node('Extract', 'ai.informationExtractor', {
        text: '={{ $json.text }}',
        attributes: {
          attributes: [
            { name: 'company', type: 'string', description: 'Company name', required: true },
            { name: 'founded', type: 'number', description: 'Year founded' },
          ],
        },
      }),
      [{ text: 'Acme was founded in 1999.' }],
    );
    expect(r.status).toBe('success');
    expect(r.output('Extract')).toEqual([{ output: { company: 'Acme', founded: 1999 } }]);
    // first answer had a string where a number was required: one corrective retry
    expect(requests).toHaveLength(2);
    expect(requests[0].responseFormat).toEqual({
      type: 'json',
      schema: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Company name' },
          founded: { type: 'number', description: 'Year founded' },
        },
        required: ['company'],
      },
    });
    expect(requests[0].messages[1]).toEqual({ role: 'user', content: 'Acme was founded in 1999.' });
  });

  it('supports manual JSON schemas', async () => {
    scriptModel('Model', ['{"tags": ["a", "b"]}']);
    const r = await chain(
      node('Extract', 'ai.informationExtractor', {
        text: 'x',
        schemaType: 'manual',
        inputSchema:
          '{"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"}}},"required":["tags"]}',
      }),
      [{}],
    );
    expect(r.output('Extract')).toEqual([{ output: { tags: ['a', 'b'] } }]);
  });

  it('dates become ISO strings in the schema', () => {
    expect(schemaFromAttributes([{ name: 'when', type: 'date' }])).toEqual({
      type: 'object',
      properties: { when: { type: 'string', description: 'Date in ISO 8601 format (YYYY-MM-DD)' } },
      required: [],
    });
  });
});

describe('Text Classifier', () => {
  const categories = {
    categories: [
      { category: 'billing', description: 'Invoices and payments' },
      { category: 'support', description: 'Technical problems' },
      { category: 'sales' },
    ],
  };

  it('declares one output per category (plus Other)', () => {
    const outputs = (params: DataObject) =>
      evaluateSimple(TextClassifierNode.description.outputs as string, { $parameter: params }) as Array<{
        displayName: string;
      }>;
    expect(outputs({ categories }).map((o) => o.displayName)).toEqual(['billing', 'support', 'sales']);
    expect(outputs({ categories, options: { fallback: 'other' } }).map((o) => o.displayName)).toEqual([
      'billing',
      'support',
      'sales',
      'Other',
    ]);
    expect(outputs({})).toEqual([]);
  });

  it('routes items to their category and drops unmatched ones', async () => {
    scriptModel('Model', [
      '{"billing": true, "support": false, "sales": false}',
      '{"billing": false, "support": true, "sales": true}',
      '{"billing": false, "support": false, "sales": false}',
    ]);
    const r = await chain(node('Classify', 'ai.textClassifier', { categories }), [
      { text: 'My invoice is wrong', id: 1 },
      { text: 'The app crashes and I want to buy more', id: 2 },
      { text: 'Hello', id: 3 },
    ]);
    expect(r.status).toBe('success');
    expect(r.outputs('Classify').map((o) => o.map((j) => j.id))).toEqual([[1], [2], []]);
    const system = String(modelRequests.get('Model')![0].messages[0].content);
    expect(system).toContain('exactly one of the following categories: billing, support, sales');
    expect(system).toContain('- billing: Invoices and payments');
  });

  it('supports multiple classes and the Other branch', async () => {
    scriptModel('Model', [
      '{"billing": false, "support": true, "sales": true}',
      '{"billing": false, "support": false, "sales": false}',
    ]);
    const r = await chain(
      node('Classify', 'ai.textClassifier', { categories, options: { multiClass: true, fallback: 'other' } }),
      [
        { id: 1, text: 'a' },
        { id: 2, text: 'b' },
      ],
    );
    expect(r.outputs('Classify').map((o) => o.map((j) => j.id))).toEqual([[], [1], [1], [2]]);
  });
});

describe('Sentiment Analysis', () => {
  it('declares outputs from the category list', () => {
    const outputs = (params: DataObject) =>
      (
        evaluateSimple(SentimentAnalysisNode.description.outputs as string, { $parameter: params }) as Array<{
          displayName: string;
        }>
      ).map((o) => o.displayName);
    expect(outputs({})).toEqual(['Positive', 'Neutral', 'Negative']);
    expect(outputs({ options: { categories: 'Happy, Angry' } })).toEqual(['Happy', 'Angry']);
  });

  it('routes by sentiment and adds detailed results', async () => {
    scriptModel('Model', [
      '{"sentiment": "Negative", "strength": 0.9, "confidence": 0.8}',
      '{"sentiment": "positive", "strength": 0.5, "confidence": 1}',
    ]);
    const r = await chain(
      node('Sentiment', 'ai.sentimentAnalysis', { options: { includeDetailedResults: true } }),
      [{ text: 'Terrible service' }, { text: 'Lovely' }],
    );
    expect(r.status).toBe('success');
    expect(r.outputs('Sentiment')).toEqual([
      [{ text: 'Lovely', sentimentAnalysis: { category: 'Positive', strength: 0.5, confidence: 1 } }],
      [],
      [
        {
          text: 'Terrible service',
          sentimentAnalysis: { category: 'Negative', strength: 0.9, confidence: 0.8 },
        },
      ],
    ]);
    expect(modelRequests.get('Model')![0].responseFormat?.type).toBe('json');
  });
});

describe('Summarization Chain', () => {
  const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`).join('\n\n');

  it('map-reduces over chunks', async () => {
    const requests = scriptModel('Model', (request: AiChatRequest) => {
      const prompt = String(request.messages[0].content);
      return reply(prompt.startsWith('Write a concise summary') ? `S${requests.length}` : 'FINAL');
    });
    const r = await chain(
      node('Sum', 'ai.chainSummarization', { options: { chunkSize: 300, chunkOverlap: 0 } }),
      [{ text: long }],
    );
    expect(r.status).toBe('success');
    expect(r.output('Sum')).toEqual([{ text: 'FINAL', chunks: 6 }]);
    expect(requests).toHaveLength(7); // 6 map calls + 1 combine
    expect(String(requests.at(-1)!.messages[0].content)).toContain('S1');
  });

  it('refines a running summary', async () => {
    const requests = scriptModel('Model', (_r, call) => reply(`v${call}`));
    const r = await chain(
      node('Sum', 'ai.chainSummarization', {
        summarizationMethod: 'refine',
        options: { chunkSize: 300, chunkOverlap: 0 },
      }),
      [{ text: long }],
    );
    expect(r.output('Sum')).toEqual([{ text: 'v5', chunks: 6 }]);
    expect(String(requests[1].messages[0].content)).toContain('existing summary up to a certain point: "v0"');
  });

  it('uses a connected text splitter', async () => {
    scriptModel('Model', (_r, call) => reply(`p${call}`));
    const r = await chain(
      node('Sum', 'ai.chainSummarization', { summarizationMethod: 'stuff' }),
      [{ text: 'a b c d e f' }],
      [node('Splitter', 'ai.textSplitterCharacter', { separator: ' ', chunkSize: 3, chunkOverlap: 0 })],
      [['Splitter', 'Sum', 'ai_textSplitter']],
    );
    expect(r.output('Sum')).toEqual([{ text: 'p0', chunks: 3 }]);
  });
});

describe('Retrieval QA chain', () => {
  it('requires a retriever or a vector store', async () => {
    const r = await chain(node('QA', 'ai.chainRetrievalQa'), [{ chatInput: 'q' }]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('Connect a retriever or a vector store');
  });
});
