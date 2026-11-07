import type { DataObject } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { connect, modelRequests, node, run, scriptModel } from './harness';

const chat = (text: string) => [{ json: { chatInput: text, sessionId: 's1' } }];

function wf(parserParams: DataObject, withFixer = true) {
  return {
    nodes: [
      node('Chat', 'ai.chatTrigger'),
      node('Agent', 'ai.agent', { hasOutputParser: true }, { typeVersion: 2 }),
      node('Model', 'test.fakeChatModel'),
      node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"city": "Rome"}', ...parserParams }),
      node('Fixer', 'test.fakeChatModel'),
    ],
    connections: connect(
      ['Chat', 'Agent'],
      ['Model', 'Agent', 'ai_languageModel'],
      ['Parser', 'Agent', 'ai_outputParser'],
      ...(withFixer ? ([['Fixer', 'Parser', 'ai_languageModel']] as Parameters<typeof connect>) : []),
    ),
  };
}

beforeEach(() => {
  clearBufferMemory();
  modelRequests.clear();
});

describe('output parsers (P5-54)', () => {
  it('fixes bad output with the Structured parser model, through the Agent', async () => {
    const main = scriptModel('Model', ['not json']);
    const fixer = scriptModel('Fixer', ['{"city": "Paris"}']);
    const w = wf({ autoFix: true });
    const r = await run(w.nodes, w.connections, { triggerItems: chat('?') });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: { city: 'Paris' } }]);
    expect(main).toHaveLength(1);
    expect(fixer).toHaveLength(1);
    const prompt = String(fixer[0].messages[0].content);
    expect(prompt).toContain('not json');
    expect(prompt).toContain('Error:');
  });

  it('uses a custom retry prompt with the error filled in', async () => {
    scriptModel('Model', ['nope']);
    const fixer = scriptModel('Fixer', ['{"city": "Oslo"}']);
    const w = wf({ autoFix: true, customizeRetryPrompt: true, prompt: 'Fix {completion} because {error}' });
    const r = await run(w.nodes, w.connections, { triggerItems: chat('?') });
    expect(r.status).toBe('success');
    expect(String(fixer[0].messages[0].content)).toMatch(/^Fix nope because /);
  });

  it('refuses a retry prompt without {error}', async () => {
    scriptModel('Model', ['nope']);
    scriptModel('Fixer', ['{"city": "Oslo"}']);
    const w = wf({ autoFix: true, customizeRetryPrompt: true, prompt: 'Fix {completion}' });
    const r = await run(w.nodes, w.connections, { triggerItems: chat('?') });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('Auto-fixing parser prompt has to contain {error} placeholder');
  });

  it('refuses a prompt without {error} on the Auto-fixing node', async () => {
    scriptModel('Model', ['nope']);
    scriptModel('Fixer', ['{}']);
    const w = wf({});
    w.nodes[3] = node('Parser', 'ai.outputParserAutofixing', { options: { prompt: 'try again' } });
    w.nodes.push(node('Inner', 'ai.outputParserStructured', { jsonSchemaExample: '{"city": "Rome"}' }));
    w.connections = connect(
      ['Chat', 'Agent'],
      ['Model', 'Agent', 'ai_languageModel'],
      ['Parser', 'Agent', 'ai_outputParser'],
      ['Fixer', 'Parser', 'ai_languageModel'],
      ['Inner', 'Parser', 'ai_outputParser'],
    );
    const r = await run(w.nodes, w.connections, { triggerItems: chat('?') });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('has to contain {error} placeholder');
  });

  it('keeps the n8n words in the parse error when auto-fix is off', async () => {
    scriptModel('Model', ['nope', 'still nope']);
    const w = wf({}, false);
    const r = await run(w.nodes, w.connections, { triggerItems: chat('?') });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_OUTPUT_PARSE');
    expect(r.error?.message).toContain("Model output doesn't fit required format: ");
  });

  it('declares autoFix off by default and the Retry Prompt label', async () => {
    const { nodes } = await import('../src');
    const structured = nodes.find((n) => n.description.name === 'ai.outputParserStructured')!;
    const props = structured.description.properties as Array<{ name: string; default?: unknown }>;
    expect(props.find((p) => p.name === 'autoFix')?.default).toBe(false);
    expect(props.find((p) => p.name === 'customizeRetryPrompt')?.default).toBe(false);
    const fixing = nodes.find((n) => n.description.name === 'ai.outputParserAutofixing')!;
    const opt = (fixing.description.properties[0] as any).options.find((o: any) => o.name === 'prompt');
    expect(opt.displayName).toBe('Retry Prompt');
  });
});
