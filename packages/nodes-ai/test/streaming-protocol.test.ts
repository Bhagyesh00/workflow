import type { DataObject } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { connect, modelRequests, node, run, scriptModel, services, toolCalls } from './harness';

const chat = (chatInput: string) => [{ json: { sessionId: 's1', chatInput, action: 'sendMessage' } }];

async function runStreaming(agentParams: DataObject, modelParams: DataObject, extra = false) {
  const chunks: unknown[] = [];
  const r = await run(
    [
      node('Chat', 'ai.chatTrigger'),
      node('Agent', 'ai.agent', agentParams),
      node('Model', 'test.fakeChatModel', modelParams),
      ...(extra ? [node('Calculator', 'ai.toolCalculator')] : []),
    ],
    connect(
      ['Chat', 'Agent'],
      ['Model', 'Agent', 'ai_languageModel'],
      ...((extra ? [['Calculator', 'Agent', 'ai_tool']] : []) as Parameters<typeof connect>),
    ),
    {
      triggerItems: chat('stream please'),
      services: services({ hooks: { sendChunk: (c) => void chunks.push(c) } }),
    },
  );
  return { r, chunks };
}

beforeEach(() => {
  clearBufferMemory();
  modelRequests.clear();
});

describe('agent streaming protocol', () => {
  it('sends plain text deltas only, never protocol objects (the server owns begin and end)', async () => {
    scriptModel('Model', ['Streaming works fine']);
    const { r, chunks } = await runStreaming({}, { streaming: true });
    expect(r.status).toBe('success');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => typeof c === 'string')).toBe(true);
    expect(chunks.join('')).toBe('Streaming works fine');
  });

  it('streams only the model text across tool steps', async () => {
    scriptModel('Model', [toolCalls(['Calculator', { input: '6*7' }]), 'It is 42']);
    const { r, chunks } = await runStreaming({}, { streaming: true }, true);
    expect(r.status).toBe('success');
    expect(chunks.every((c) => typeof c === 'string')).toBe(true);
    expect(chunks.join('')).toBe('It is 42');
  });

  it('sends the final answer as one chunk when the model cannot stream', async () => {
    scriptModel('Model', ['The answer is 42']);
    const { r, chunks } = await runStreaming({}, { streaming: false });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'The answer is 42' }]);
    expect(chunks).toEqual(['The answer is 42']);
  });

  it('sends nothing when the agent has streaming turned off', async () => {
    scriptModel('Model', ['Quiet answer']);
    const { r, chunks } = await runStreaming({ options: { enableStreaming: false } }, { streaming: true });
    expect(r.status).toBe('success');
    expect(chunks).toEqual([]);
  });

  it('sends no chunk for a run that fails', async () => {
    scriptModel('Model', [toolCalls(['Calculator', { input: '1+1' }])]);
    const { r, chunks } = await runStreaming({ options: { maxIterations: 1 } }, { streaming: false }, true);
    expect(r.status).toBe('error');
    expect(chunks).toEqual([]);
  });
});
