/**
 * Phase 5 S1 P5-26: Cohere, Ollama, Lemonade and Hugging Face text completion models. Replies are fixtures
 * written from the vendor docs; they prove the request we send.
 */
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { textCompletionNodes } from '../src/nodes/models/text-completion.nodes';
import { connect, FakeHttpClient, node, run, sequence, services } from './harness';

interface Case {
  type: string;
  credential: string;
  creds: DataObject;
  params: DataObject;
  url: string;
  reply: unknown;
  check: (body: DataObject) => void;
}

const openAiReply = {
  id: 'c1',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Bonjour' } }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

const CASES: Case[] = [
  {
    type: 'ai.lmCohere',
    credential: 'cohereApi',
    creds: { apiKey: 'co-key' },
    params: { model: 'command-r', options: { maxTokens: 50, temperature: 0.3, topP: 0.8 } },
    url: 'https://api.cohere.ai/v2/chat',
    reply: {
      id: 'x',
      finish_reason: 'COMPLETE',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Bonjour' }] },
      usage: { tokens: { input_tokens: 5, output_tokens: 1 } },
    },
    check: (b) => expect(b).toMatchObject({ model: 'command-r', max_tokens: 50, temperature: 0.3 }),
  },
  {
    type: 'ai.lmOllama',
    credential: 'ollamaApi',
    creds: { baseUrl: 'http://ollama.test:11434' },
    params: { model: 'llama3.2', options: { temperature: 0.1, topK: 20, numCtx: 2048 } },
    url: 'http://ollama.test:11434/api/chat',
    reply: {
      model: 'llama3.2',
      message: { role: 'assistant', content: 'Bonjour' },
      done: true,
      done_reason: 'stop',
    },
    check: (b) => expect(b).toMatchObject({ model: 'llama3.2' }),
  },
  {
    type: 'ai.lmLemonade',
    credential: 'lemonadeApi',
    creds: { baseUrl: 'http://lemonade.test:8000/api/v1', apiKey: 'lm-key' },
    params: { model: 'Llama-3.2', options: { maxTokens: -1, frequencyPenalty: 0.5 } },
    url: 'http://lemonade.test:8000/api/v1/chat/completions',
    reply: openAiReply,
    check: (b) => {
      expect(b).toMatchObject({ model: 'Llama-3.2', frequency_penalty: 0.5 });
      expect(b.max_tokens).toBeUndefined();
    },
  },
  {
    type: 'ai.lmOpenHuggingFaceInference',
    credential: 'huggingFaceApi',
    creds: { apiKey: 'hf-key' },
    params: {
      model: 'meta-llama/Llama-3.1-8B-Instruct',
      options: { maxTokens: 64, topK: 10, topP: 0.9, presencePenalty: 0.2 },
    },
    url: 'https://router.huggingface.co/v1/chat/completions',
    reply: openAiReply,
    check: (b) =>
      expect(b).toMatchObject({
        model: 'meta-llama/Llama-3.1-8B-Instruct',
        max_tokens: 64,
        top_k: 10,
        top_p: 0.9,
        presence_penalty: 0.2,
      }),
  },
];

const withCreds = (n: WorkflowNode, credential: string): WorkflowNode => ({
  ...n,
  credentials: { [credential]: { id: 'cred-1', name: credential } },
});

function runWith(c: Case, root: WorkflowNode, http: FakeHttpClient) {
  return run(
    [node('Trigger', 'test.trigger'), root, withCreds(node('Model', c.type, c.params), c.credential)],
    connect(['Trigger', root.name], ['Model', root.name, 'ai_languageModel']),
    { services: services({ creds: { [c.credential]: c.creds }, http }) },
  );
}

const chain = () => node('Chain', 'ai.chainLlm', { promptType: 'define', text: 'Say hello in French' });
const agent = () =>
  node('Agent', 'ai.agent', { promptType: 'define', text: 'Say hello', options: { enableStreaming: false } });

describe('text completion models', () => {
  it('registers the four nodes as language models', () => {
    expect(textCompletionNodes.map((n) => n.description.name)).toEqual([
      'ai.lmCohere',
      'ai.lmOllama',
      'ai.lmLemonade',
      'ai.lmOpenHuggingFaceInference',
    ]);
    for (const n of textCompletionNodes) {
      expect(n.description.outputs).toEqual(['ai_languageModel']);
      expect(n.supplyData).toBeTypeOf('function');
    }
  });

  for (const c of CASES) {
    describe(c.type, () => {
      it('runs a Basic LLM Chain and sends the recorded request', async () => {
        const http = new FakeHttpClient(sequence({ body: c.reply }));
        const r = await runWith(c, chain(), http);
        expect(r.status).toBe('success');
        expect(r.output('Chain')).toEqual([{ text: 'Bonjour' }]);
        const [req] = http.requests;
        expect(req.url).toBe(c.url);
        c.check(req.body as DataObject);
        expect(JSON.stringify(req.headers ?? {})).not.toMatch(/openai-platform|n8n/i);
      });

      it('is refused by the Agent with a clear text and no model call', async () => {
        const http = new FakeHttpClient(sequence());
        const r = await runWith(c, agent(), http);
        expect(r.status).toBe('error');
        expect(JSON.stringify(r)).toContain(`${'Model'} is a text completion model; connect a chat model`);
        expect(http.requests).toHaveLength(0);
      });
    });
  }

  it('sends to a custom Hugging Face inference endpoint', async () => {
    const c = CASES[3];
    const http = new FakeHttpClient(sequence({ body: openAiReply }));
    const custom: Case = {
      ...c,
      params: { model: 'tgi', options: { endpointUrl: 'https://abc.endpoints.huggingface.cloud/v1/' } },
    };
    const r = await runWith(custom, chain(), http);
    expect(r.status).toBe('success');
    expect(http.requests[0].url).toBe('https://abc.endpoints.huggingface.cloud/v1/chat/completions');
  });

  it('refuses an empty Hugging Face model', async () => {
    const http = new FakeHttpClient(sequence());
    const r = await runWith({ ...CASES[3], params: { model: ' ' } }, chain(), http);
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);
  });
});
