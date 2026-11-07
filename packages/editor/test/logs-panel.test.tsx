import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Connections, RunData, TaskData } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogPanel } from '../src/components/workflow/LogPanel';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';

const connections: Connections = {
  Trigger: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
  Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
  Search: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
};

function task(start: number, extra: Partial<TaskData> = {}): TaskData {
  return {
    startTime: start,
    executionTime: 120,
    executionStatus: 'success',
    data: { main: [[{ json: { done: true } }]] },
    source: [{ previousNode: 'Trigger' }],
    ...extra,
  };
}

function agentRun(t0 = 1000): RunData {
  return {
    Trigger: [task(t0, { executionTime: 1, data: { main: [[{ json: { chatInput: 'hi' } }]] }, source: [] })],
    Agent: [task(t0 + 1, { executionTime: 900, data: { main: [[{ json: { output: 'It is sunny.' } }]] } })],
    Model: [
      {
        startTime: t0 + 100,
        executionTime: 0,
        executionStatus: 'success',
        inputOverride: {
          ai_languageModel: [
            [
              {
                json: {
                  model: 'fake-1',
                  messages: [{ role: 'user', content: 'Weather in Pune?' }],
                  tools: ['Search'],
                },
              },
            ],
          ],
        },
        data: {
          ai_languageModel: [
            [
              {
                json: {
                  response: {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'c1', name: 'Search', arguments: { q: 'weather pune' } }],
                  },
                  tokenUsage: { inputTokens: 5, outputTokens: 10 },
                  stopReason: 'tool_calls',
                },
              },
            ],
          ],
        },
        source: [{ previousNode: 'Agent' }],
      },
      {
        startTime: t0 + 500,
        executionTime: 0,
        executionStatus: 'success',
        inputOverride: { ai_languageModel: [[{ json: { model: 'fake-1', messages: [] } }]] },
        data: {
          ai_languageModel: [
            [
              {
                json: {
                  response: { role: 'assistant', content: 'It is sunny.' },
                  tokenUsage: { inputTokens: 7, outputTokens: 20 },
                  stopReason: 'end',
                },
              },
            ],
          ],
        },
        source: [{ previousNode: 'Agent' }],
      },
    ],
    Search: [
      {
        startTime: t0 + 300,
        executionTime: 0,
        executionStatus: 'success',
        inputOverride: { ai_tool: [[{ json: { q: 'weather pune' } }]] },
        data: { ai_tool: [[{ json: { forecast: 'sunny' } }]] },
        source: [{ previousNode: 'Agent' }],
      },
    ],
  };
}

const onFocusNode = vi.fn();
const baseProps = { logs: [], onClear: vi.fn(), onClose: vi.fn(), onFocusNode };

function panel(runData: RunData) {
  return <LogPanel {...baseProps} runData={runData} />;
}

const treeitem = (name: string) =>
  screen.getAllByRole('treeitem').find((el) => el.textContent?.startsWith(name)) as HTMLElement;

beforeEach(() => {
  onFocusNode.mockClear();
  useUiStore.setState({ logPanelTab: 'logs' });
  useWorkflowStore.setState({ nodes: [], connections });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Logs tab', () => {
  it('shows the empty state before a run', () => {
    render(panel({}));
    expect(screen.getByText('No run yet')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('shows an agent run as a tree with the model and the tool call under the agent, and its tokens', () => {
    render(panel(agentRun()));
    const items = screen.getAllByRole('treeitem');
    expect(items.map((el) => el.getAttribute('aria-level'))).toEqual(['1', '1', '2', '2', '2']);
    expect(items.map((el) => el.querySelector('.truncate')?.textContent)).toEqual([
      'Trigger',
      'Agent',
      'Model',
      'Search',
      'Model (run 2)',
    ]);
    expect(treeitem('Agent').textContent).toContain('12 + 30 tokens');
    expect(treeitem('Model (run 2)').textContent).toContain('7 + 20 tokens');
    // the header sums the whole run
    expect(screen.getByText('12 + 30 tokens', { selector: 'p span' })).toBeTruthy();
  });

  it('switches the details with the selected run and focuses the node on the canvas', () => {
    render(panel(agentRun()));
    expect(screen.getByText('Select a node run')).toBeTruthy();

    fireEvent.click(treeitem('Search'));
    expect(onFocusNode).toHaveBeenLastCalledWith('Search');
    const details = screen.getByRole('region', { name: 'Details of Search' });
    expect(within(details).getByText('"forecast"')).toBeTruthy();
    fireEvent.click(within(details).getByRole('tab', { name: 'Input' }));
    expect(within(details).getByText('"q"')).toBeTruthy();

    fireEvent.click(treeitem('Model'));
    const model = screen.getByRole('region', { name: 'Details of Model' });
    // a model run opens on its overview: messages, tool calls and the stop reason
    expect(within(model).getByText('Weather in Pune?')).toBeTruthy();
    expect(within(model).getByText('tool_calls')).toBeTruthy();
    expect(within(model).getByRole('list', { name: 'Tool calls' }).textContent).toContain('weather pune');
    expect(screen.queryByRole('region', { name: 'Details of Search' })).toBeNull();
  });

  it('collapses and expands a node, with the mouse and the arrow keys', () => {
    render(panel(agentRun()));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Agent' }));
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    expect(treeitem('Agent').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Agent' }));
    expect(screen.getAllByRole('treeitem')).toHaveLength(5);

    const agent = treeitem('Agent');
    agent.focus();
    fireEvent.keyDown(agent, { key: 'ArrowLeft' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.keyDown(treeitem('Agent'), { key: 'ArrowRight' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(5);
  });

  it('moves the selection and the focus with ArrowDown and ArrowUp, and Enter focuses the node', () => {
    render(panel(agentRun()));
    const trigger = treeitem('Trigger');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(treeitem('Agent').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(treeitem('Agent'));
    fireEvent.keyDown(treeitem('Agent'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(treeitem('Model'));
    fireEvent.keyDown(treeitem('Model'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(treeitem('Agent'));
    fireEvent.keyDown(treeitem('Agent'), { key: 'Enter' });
    expect(onFocusNode).toHaveBeenLastCalledWith('Agent');
    fireEvent.keyDown(treeitem('Agent'), { key: 'End' });
    expect(document.activeElement).toBe(treeitem('Model (run 2)'));
    fireEvent.keyDown(treeitem('Model (run 2)'), { key: 'Home' });
    expect(document.activeElement).toBe(treeitem('Trigger'));
  });

  it('shows an error run as failed with its message', () => {
    const runData = agentRun();
    runData.Agent = [
      task(1001, {
        executionStatus: 'error',
        error: { name: 'Error', message: 'Model refused the request' },
      }),
    ];
    render(panel(runData));
    expect(within(treeitem('Agent')).getByRole('img', { name: 'Failed' })).toBeTruthy();
    fireEvent.click(treeitem('Agent'));
    expect(screen.getByText('Model refused the request')).toBeTruthy();
  });

  it('shows a running node with a running state in the header', () => {
    const runData = agentRun();
    runData.Agent = [task(1001, { executionStatus: 'running' })];
    render(panel(runData));
    expect(within(treeitem('Agent')).getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(screen.getByText('Running', { selector: 'p span' })).toBeTruthy();
  });

  it('clears the selection when a new run starts, but keeps it while the same run grows', () => {
    const { rerender } = render(panel(agentRun(1000)));
    fireEvent.click(treeitem('Search'));
    expect(screen.getByRole('region', { name: 'Details of Search' })).toBeTruthy();

    const grown = agentRun(1000);
    grown.Reply = [task(1950)];
    rerender(panel(grown));
    expect(screen.getByRole('region', { name: 'Details of Search' })).toBeTruthy();

    rerender(panel(agentRun(5000)));
    expect(screen.queryByRole('region', { name: /Details of/ })).toBeNull();
    expect(screen.getByText('Select a node run')).toBeTruthy();
  });

  it('writes run data as text, not markup', () => {
    const runData = agentRun();
    runData.Agent = [
      task(1001, { data: { main: [[{ json: { output: '<img src=x onerror=alert(1)>' } }]] } }),
    ];
    const { container } = render(panel(runData));
    fireEvent.click(treeitem('Agent'));
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('pop-out window', () => {
  /** an iframe's window stands in for the pop-up: a real window with its own document */
  function fakePopup() {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const popup = frame.contentWindow as Window & { closed: boolean };
    const doc = popup.document;
    const listeners = new Map<string, () => void>();
    const close = vi.fn(() => {
      Object.defineProperty(popup, 'closed', { configurable: true, value: true });
    });
    Object.assign(popup, { focus: vi.fn(), close });
    popup.addEventListener = ((type: string, fn: () => void) => {
      listeners.set(type, fn);
    }) as unknown as typeof popup.addEventListener;
    return { popup: Object.assign(popup, { close }), doc, listeners };
  }

  it('moves the panel into the new window with the style sheets, and back when it closes', () => {
    document.head.appendChild(
      Object.assign(document.createElement('style'), { textContent: '.x{color:red}' }),
    );
    const { popup, doc, listeners } = fakePopup();
    const open = vi.fn(() => popup);
    vi.stubGlobal('open', open);
    render(panel(agentRun()));

    fireEvent.click(screen.getByRole('button', { name: 'Open logs in a new window' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(doc.head.textContent).toContain('.x{color:red}');
    expect(within(doc.body).getByRole('tree')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByText('The logs are open in another window.')).toBeTruthy();

    // the panel still works in the other window
    fireEvent.click(within(doc.body).getAllByRole('treeitem')[1] as HTMLElement);
    expect(onFocusNode).toHaveBeenLastCalledWith('Agent');

    act(() => listeners.get('pagehide')?.());
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(screen.queryByText('The logs are open in another window.')).toBeNull();
  });

  it('brings the panel back with the button and closes the window', () => {
    const { popup, doc } = fakePopup();
    vi.stubGlobal('open', () => popup);
    render(panel(agentRun()));
    fireEvent.click(screen.getByRole('button', { name: 'Open logs in a new window' }));
    fireEvent.click(within(doc.body).getByRole('button', { name: 'Bring logs back' }));
    expect(popup.close).toHaveBeenCalled();
    expect(screen.getByRole('tree')).toBeTruthy();
  });

  it('closes the window when the panel unmounts', () => {
    const { popup } = fakePopup();
    vi.stubGlobal('open', () => popup);
    const { unmount } = render(panel(agentRun()));
    fireEvent.click(screen.getByRole('button', { name: 'Open logs in a new window' }));
    unmount();
    expect(popup.close).toHaveBeenCalled();
  });

  it('shows a toast and keeps the panel in the page when the pop-up is blocked', () => {
    vi.stubGlobal('open', () => null);
    render(panel(agentRun()));
    fireEvent.click(screen.getByRole('button', { name: 'Open logs in a new window' }));
    expect(screen.getByRole('tree')).toBeTruthy();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('Couldn’t open the logs window');
    expect(toasts[0]?.kind).toBe('error');
  });
});
