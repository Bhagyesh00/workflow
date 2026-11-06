import { type CodeRunnerInput, PyodideCodeRunner } from '@workflow/core';
import type { DataObject, Item, NodeProperty } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolCodeNode } from '../src/nodes/tools/tools.nodes';
import { connect, modelRequests, node, reply, run, scriptModel, services, toolCalls } from './harness';

const pythonRunner = new PyodideCodeRunner({
  memoryLimitMb: 256,
  timeoutMs: 20_000,
  maxConcurrency: 5,
  stdlibAllow: [],
  externalAllow: [],
  builtinsDeny: ['open', 'eval', 'exec'],
  allowTransitiveImports: false,
});

const properties = ToolCodeNode.description.properties as NodeProperty[];
const property = (name: string) => properties.find((p) => p.name === name);

/** An agent with one Code tool and a scripted model whose answer quotes the tool result it was sent. */
async function agentWith(
  parameters: DataObject,
  args: DataObject,
  options: { withPython?: boolean; messages?: unknown[][] } = {},
) {
  const requests = scriptModel('Model', (request, call) => {
    if (call === 0) return toolCalls(['Tool', args]);
    return reply(`The tool said: ${request.messages[request.messages.length - 1].content}`);
  });
  const { messages } = options;
  const r = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', {
        promptType: 'define',
        text: 'go',
        options: { returnIntermediateSteps: true },
      }),
      node('Model', 'test.fakeChatModel'),
      node('Tool', 'ai.toolCode', { toolDescription: 'A Python tool', ...parameters }),
    ],
    connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Tool', 'Agent', 'ai_tool']),
    {
      services: services({
        pythonRunner: options.withPython === false ? undefined : pythonRunner,
        hooks: { sendMessageToUI: (_node, args) => void messages?.push(args as unknown[]) },
      }),
    },
  );
  const agent = r.output('Agent')[0];
  const steps = (agent?.intermediateSteps ?? []) as Array<{ observation: string }>;
  return { r, requests, output: agent?.output, observation: steps[0]?.observation };
}

const python = (pythonCode: string) => ({ language: 'python', pythonCode });

/** the runner input fields a direct call needs */
function direct(code: string, extra: Partial<CodeRunnerInput>): CodeRunnerInput {
  return {
    code,
    mode: 'runOnceForAllItems',
    language: 'pythonNative',
    items: [{ json: { a: 1 } }],
    nodeOutputs: {},
    variables: {},
    workflow: { id: 'w', name: 'w', active: false },
    execution: { id: 'e', mode: 'test' },
    nodeName: 'Tool',
    timezone: 'UTC',
    ...extra,
  };
}

const firstResult = (items: Item[]) => items[0]?.json.result;

beforeEach(() => modelRequests.clear());

describe('Code tool description', () => {
  it("offers n8n's stored values, JavaScript by default", () => {
    const language = property('language');
    expect(language?.type).toBe('options');
    expect(language?.default).toBe('javaScript');
    expect(language?.noDataExpression).toBe(true);
    expect(language?.options?.map((o) => ('value' in o ? o.value : undefined))).toEqual([
      'javaScript',
      'python',
    ]);
  });

  it('shows pythonCode for Python only, with the default and the hint', () => {
    const field = property('pythonCode');
    expect(field?.default).toBe('return _query.upper()');
    expect(field?.noDataExpression).toBe(true);
    expect(field?.typeOptions?.editorLanguage).toBe('python');
    expect(field?.displayOptions?.show?.language).toEqual(['python']);
    expect(field?.hint).toContain('input property "_query"');
    expect(field?.hint).toContain('returned value should be a single string');
  });

  it('shows jsCode for JavaScript only', () => {
    expect(property('jsCode')?.displayOptions?.show?.language).toEqual(['javaScript']);
  });
});

describe('Python Code tool in an agent', () => {
  it('gives the agent the return value', async () => {
    const { r, output, observation, requests } = await agentWith(python('return _query.upper() + "!"'), {
      query: 'hello',
    });
    expect(r.status).toBe('success');
    expect(observation).toBe('HELLO!');
    expect(requests[1].messages.at(-1)?.content).toBe('HELLO!');
    expect(output).toBe('The tool said: HELLO!');
  });

  it('runs the default code', async () => {
    const { observation } = await agentWith({ language: 'python' }, { query: 'default' });
    expect(observation).toBe('DEFAULT');
  });

  it('accepts any return value', async () => {
    const cases: Array<[string, string]> = [
      ['return {"total": 42, "list": [1, 2]}', '{"total":42,"list":[1,2]}'],
      ['return [1, "two", None]', '[1,"two",null]'],
      ['return 42', '42'],
      ['return True', 'true'],
      ['return {"json": {"x": 1}}', '{"json":{"x":1}}'],
      ['return [{"json": {"x": 1}}]', '[{"json":{"x":1}}]'],
    ];
    for (const [code, expected] of cases) {
      const { r, observation } = await agentWith(python(code), { query: 'q' });
      expect(r.status, code).toBe('success');
      expect(observation, code).toBe(expected);
    }
  });

  it('gives the same result for no return as for None', async () => {
    const empty = await agentWith(python('x = 1'), { query: 'q' });
    const none = await agentWith(python('return None'), { query: 'q' });
    expect(empty.r.status).toBe('success');
    expect(empty.observation).toBe(none.observation);
  });

  it('passes structured arguments as a dict when an input schema is set', async () => {
    const { observation, requests } = await agentWith(
      {
        ...python('return {"total": _query["a"] + _query["b"]}'),
        specifyInputSchema: true,
        schemaType: 'fromJson',
        jsonSchemaExample: '{"a": 1, "b": 2}',
      },
      { a: 2, b: 40 },
    );
    expect(requests[0].tools?.[0]).toMatchObject({
      name: 'Tool',
      parameters: { properties: { a: { type: 'number' }, b: { type: 'number' } } },
    });
    expect(observation).toBe('{"total":42}');
  });

  it('treats the query as data, never as code or an expression', async () => {
    for (const query of ['"""\nimport os\n"""', '"); import os; ("', '{{ $json.x }}', "\\'\ud83d\ude00"]) {
      const { r, observation } = await agentWith(python('return _query'), { query });
      expect(r.status).toBe('success');
      expect(observation).toBe(query);
    }
  });

  it('reports a Python error to the model', async () => {
    const { r, observation } = await agentWith(python('raise ValueError("tool exploded")'), { query: 'q' });
    expect(r.status).toBe('success');
    expect(observation).toBe('Error: ValueError: tool exploded');
  });

  it('keeps the sandbox: imports and denied builtins are refused', async () => {
    const blocked = await agentWith(python('import os\nreturn os.getcwd()'), { query: 'q' });
    expect(blocked.observation).toContain("Import of standard library module 'os' is disallowed");
    const js = await agentWith(python('import js\nreturn 1'), { query: 'q' });
    expect(js.observation).toContain("Import of external package 'js' is disallowed");
    const opened = await agentWith(python('return open("/etc/passwd").read()'), { query: 'q' });
    expect(opened.observation).toMatch(/^Error: NameError/);
  });

  it('sends print() to the browser console of a manual run', async () => {
    const messages: unknown[][] = [];
    const { observation } = await agentWith(python('print("from python", _query)\nreturn "ok"'), { query: 'q' }, {
      messages,
    });
    expect(observation).toBe('ok');
    expect(messages).toEqual([['from python', 'q']]);
  });

  it('tells the model when this instance has Python off', async () => {
    const { r, observation } = await agentWith(python('return 1'), { query: 'q' }, { withPython: false });
    expect(r.status).toBe('success');
    expect(observation).toContain('PYTHON_ENABLED');
  });

  it('leaves JavaScript as it was, with no language set and with javaScript', async () => {
    const plain = await agentWith({ jsCode: 'return query + "!";' }, { query: 'js' }, { withPython: false });
    expect(plain.observation).toBe('js!');
    const named = await agentWith(
      { language: 'javaScript', jsCode: 'return query + "?";', pythonCode: 'return "wrong"' },
      { query: 'js' },
    );
    expect(named.observation).toBe('js?');
  });
});

describe('Python runner tool mode', () => {
  it('returns any value in one item when a query is passed', async () => {
    const items = await pythonRunner.run(direct('return [_query, 1]', { query: 'q' }));
    expect(items).toHaveLength(1);
    expect(firstResult(items)).toEqual(['q', 1]);
  });

  it('treats a null query as tool mode', async () => {
    const items = await pythonRunner.run(direct('return _query', { query: null }));
    expect(items).toHaveLength(1);
    expect(firstResult(items)).toBeNull();
  });

  it('has _items as an empty list, since a tool run has no workflow items, and no _item', async () => {
    const items = await pythonRunner.run(direct('return _items', { query: 'q' }));
    expect(firstResult(items)).toEqual([]);
    await expect(pythonRunner.run(direct('return _item', { query: 'q' }))).rejects.toThrow('NameError');
  });

  it('keeps per-item code out of tool mode: one call, any value', async () => {
    const items = await pythonRunner.run(
      direct('return [_query, len(_items)]', {
        query: 'q',
        mode: 'runOnceForEachItem',
        items: [{ json: { a: 1 } }, { json: { a: 2 } }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(firstResult(items)).toEqual(['q', 0]);
  });

  it('gives the Code node its items', async () => {
    const items = await pythonRunner.run(direct('return [{"n": len(_items)}]', {}));
    expect(items.map((item) => item.json)).toEqual([{ n: 1 }]);
  });

  it('gives the Code node no _query and keeps its return rules', async () => {
    const code = `
try:
    _query
    found = True
except NameError:
    found = False
return [{"found": found}]
`;
    const items = await pythonRunner.run(direct(code, {}));
    expect(items.map((item) => item.json)).toEqual([{ found: false }]);
    await expect(pythonRunner.run(direct('return 42', {}))).rejects.toThrow("Code doesn't return items properly");
  });
});
