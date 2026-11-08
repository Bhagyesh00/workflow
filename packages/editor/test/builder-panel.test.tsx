/**
 * P5-62: the AI builder's side panel. A turn streams into the panel (progress rows, the reply through
 * `Markdown`), the canvas holds the draft and stays locked while the turn streams, a new canvas gets its
 * row once before the first turn, a model's HTML stays text, a viewer gets no entry, and the server
 * stream is read as NDJSON.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BUILDER_PROMPT_LIMIT,
  type BuilderChunk,
  type BuildRequest,
  type WorkflowNode,
} from '@workflow/workflow';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BuildStreamConnector, setBuildStreamConnector, streamBuild } from '../src/api/ai-stream';
import type { ApiRequest } from '../src/api/client';
import { demoBuildChunks, seedDemoAiSession } from '../src/demo/mock-ai';
import { newId } from '../src/lib/ids';
import { useBuilderStore } from '../src/stores/builder-store';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

const node = (id: string, name: string, type: string, x: number, extra: Partial<WorkflowNode> = {}) =>
  ({ id, name, type, typeVersion: 1, position: [x, 0], parameters: {}, ...extra }) as WorkflowNode;

const NODES = [node('t', 'Start', 'core.manualTrigger', 0), node('s', 'Shape', 'core.set', 300)];
const CONNECTIONS = { Start: { main: [[{ node: 'Shape', type: 'main' as const, index: 0 }]] } };

/** the builder adds "Call API" after Shape */
const DRAFT: BuilderChunk = {
  type: 'workflow-updated',
  workflow: {
    name: 'Draft',
    nodes: [
      ...NODES,
      node('h', 'Call API', 'core.httpRequest', 600, {
        parameters: { method: 'GET', url: 'https://api.example.com/leads' },
      }),
    ],
    connections: {
      ...CONNECTIONS,
      Shape: { main: [[{ node: 'Call API', type: 'main', index: 0 }]] },
    },
  },
};

const writes = () =>
  backend().requests.filter(
    (r: ApiRequest) =>
      (r.method === 'PATCH' && /^\/workflows\/[^/]+$/.test(r.path)) ||
      (r.method === 'POST' && r.path === '/workflows'),
  );

/** a connector that plays `chunks`, then waits for `gate` (the turn is still streaming meanwhile) */
function scripted(chunks: BuilderChunk[], gate?: Promise<void>): BuildRequest[] {
  const bodies: BuildRequest[] = [];
  const connector: BuildStreamConnector = async (body, onChunk, signal) => {
    bodies.push(body);
    for (const chunk of chunks) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      onChunk(chunk);
      await Promise.resolve();
    }
    if (gate) await gate;
  };
  setBuildStreamConnector(connector);
  return bodies;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function openEditor(path: string) {
  const utils = renderApp(path);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  return utils;
}

async function openPanel() {
  const user = userEvent.setup();
  const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' });
  await user.click(entry);
  const panel = await screen.findByRole('complementary', { name: 'AI builder' });
  return { user, panel };
}

async function sendText(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, text: string) {
  const box = within(panel).getByRole('textbox', { name: 'Message the AI builder' });
  await user.type(box, text);
  await user.click(within(panel).getByRole('button', { name: 'Send' }));
}

describe('builder panel (P5-62)', () => {
  beforeEach(() => {
    signedIn();
    useBuilderStore.getState().reset();
  });
  afterEach(() => {
    setBuildStreamConnector(null);
    useBuilderStore.getState().reset();
  });

  it('streams progress and the reply, shows the draft and locks the canvas meanwhile', async () => {
    const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
    await openEditor(`/workflow/${wf.id}`);
    const { user, panel } = await openPanel();
    const gate = deferred();
    const bodies = scripted(
      [
        { type: 'message', id: 'a1', text: 'Adding an ', delta: true },
        { type: 'message', id: 'a1', text: 'HTTP Request', delta: true },
        { type: 'tool', toolName: 'search_nodes', status: 'running' },
        { type: 'tool', toolName: 'search_nodes', status: 'done', summary: 'Found HTTP Request' },
        { type: 'tool', toolName: 'add_nodes', status: 'running' },
        DRAFT,
      ],
      gate.promise,
    );
    await sendText(user, panel, 'Call the leads API');

    expect(await within(panel).findByText('Found HTTP Request')).toBeTruthy();
    expect(within(panel).getByText('Add nodes')).toBeTruthy();
    expect(within(panel).getByText('Adding an HTTP Request')).toBeTruthy();
    expect(within(panel).getByText('Call the leads API')).toBeTruthy();
    // the draft is on the canvas, under review, and the canvas is locked while the turn streams
    await waitFor(() =>
      expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'Shape', 'Call API']),
    );
    expect(useBuilderStore.getState()).toMatchObject({ streaming: true, reviewing: true });
    expect(within(panel).getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(document.querySelector('.react-flow__node[data-id="h"]')).not.toBeNull();

    await act(async () => gate.resolve());
    await waitFor(() => expect(useBuilderStore.getState().streaming).toBe(false));
    expect(within(panel).getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(within(panel).getByText(/Edits · 1 node/)).toBeTruthy();
    // the request: this workflow, the canvas as workflowData, build mode
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ workflowId: wf.id, text: 'Call the leads API', mode: 'build' });
    expect((bodies[0].workflowData as { id: string; nodes: unknown[] }).id).toBe(wf.id);
    expect((bodies[0].workflowData as { nodes: unknown[] }).nodes).toHaveLength(2);
    expect(writes()).toHaveLength(0);
  }, 60_000);

  it('while a turn streams no canvas edit path changes the workflow or runs it', async () => {
    const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
    await openEditor(`/workflow/${wf.id}`);
    const { user, panel } = await openPanel();
    const gate = deferred();
    scripted([DRAFT], gate.promise);
    await sendText(user, panel, 'Call the leads API');
    const names = () => useWorkflowStore.getState().nodes.map((n) => n.name);
    await waitFor(() => expect(names()).toEqual(['Start', 'Shape', 'Call API']));
    expect(useBuilderStore.getState().streaming).toBe(true);
    backend().requests.length = 0;

    // the add buttons and the run button wait
    expect(screen.queryByRole('button', { name: 'Add node' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tidy up' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Execute workflow' })).toHaveProperty('disabled', true);
    // the shortcuts that edit or run do nothing; copy still works, paste waits
    act(() => useWorkflowStore.getState().select({ nodes: ['Call API'], stickies: [], edges: [] }));
    for (const init of [
      { key: 'Delete' },
      { key: 'Backspace' },
      { key: 'd' },
      { key: 'd', ctrlKey: true },
      { key: 'z', ctrlKey: true },
      { key: 'Enter', ctrlKey: true },
      { key: 'c', ctrlKey: true },
    ]) {
      fireEvent.keyDown(window, init);
      expect(names(), init.key).toEqual(['Start', 'Shape', 'Call API']);
      expect(useWorkflowStore.getState().nodes.some((n) => n.disabled)).toBe(false);
    }
    fireEvent.paste(document);
    expect(names()).toEqual(['Start', 'Shape', 'Call API']);
    expect(backend().requests.some((r) => /\/run$/.test(r.path))).toBe(false);
    // the node details open read-only, without a run
    act(() => useUiStore.getState().openNdv('Call API'));
    const ndv = await screen.findByRole('dialog', { name: 'Call API details' });
    expect(within(ndv).getByRole('textbox', { name: 'Node name' })).toHaveProperty('readOnly', true);
    expect(within(ndv).queryByRole('button', { name: 'Execute step' })).toBeNull();
    act(() => useUiStore.getState().openNdv(null));

    await act(async () => gate.resolve());
    await waitFor(() => expect(useBuilderStore.getState().streaming).toBe(false));
    // after the turn the same key edits the draft again
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(names()).toEqual(['Start', 'Shape']);
    expect(screen.getByRole('button', { name: 'Add node' })).toBeTruthy();
  }, 60_000);

  it('Stop ends the turn and keeps the draft under review', async () => {
    const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
    await openEditor(`/workflow/${wf.id}`);
    const { user, panel } = await openPanel();
    let aborted = false;
    setBuildStreamConnector(async (_body, onChunk, signal) => {
      onChunk(DRAFT);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    await sendText(user, panel, 'Call the leads API');
    await user.click(await within(panel).findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(useBuilderStore.getState().streaming).toBe(false));
    expect(aborted).toBe(true);
    expect(useBuilderStore.getState()).toMatchObject({ reviewing: true, error: null });
    expect(useWorkflowStore.getState().nodes).toHaveLength(3);
  }, 60_000);

  it('the first send on a new canvas saves the row once, then reviews the draft', async () => {
    const { router } = await openEditor('/workflow/new');
    const { user, panel } = await openPanel();
    const bodies = scripted([
      {
        type: 'workflow-updated',
        workflow: {
          name: 'My workflow',
          nodes: [node('t', 'Start', 'core.manualTrigger', 0)],
          connections: {},
        },
      },
      { type: 'message', id: 'a1', text: 'Added a manual trigger.' },
    ]);
    await sendText(user, panel, 'Start by hand');
    await waitFor(() => expect(useBuilderStore.getState().streaming).toBe(false));

    const created = writes();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ method: 'POST', path: '/workflows' });
    expect((created[0].body as { nodes: unknown[] }).nodes).toHaveLength(0);
    const id = useWorkflowStore.getState().meta.id!;
    expect(bodies[0].workflowId).toBe(id);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflow/${id}`));
    expect(useBuilderStore.getState().reviewing).toBe(true);
    expect(useBuilderStore.getState().snapshot?.versionId).toBe(useWorkflowStore.getState().meta.versionId);
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start']);
    expect(await screen.findByText('Added a manual trigger.')).toBeTruthy();
  }, 60_000);

  it("renders a model's HTML as text, never as markup", async () => {
    const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
    await openEditor(`/workflow/${wf.id}`);
    const { user, panel } = await openPanel();
    const hostile = '<img src=x onerror="window.__builderPwned=1"> and **bold**';
    scripted([{ type: 'message', id: 'a1', text: hostile }]);
    await sendText(user, panel, 'Hi');
    expect(await within(panel).findByText(/<img src=x onerror=/)).toBeTruthy();
    expect(panel.querySelector('img')).toBeNull();
    expect(within(panel).getByText('bold').tagName).toBe('STRONG');
    expect((window as unknown as { __builderPwned?: number }).__builderPwned).toBeUndefined();
  }, 60_000);

  it('a turn error shows its title and message', async () => {
    const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
    await openEditor(`/workflow/${wf.id}`);
    const { user, panel } = await openPanel();
    scripted([{ type: 'error', title: 'Workflow update failed', message: 'The model is not reachable' }]);
    await sendText(user, panel, 'Hi');
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('Workflow update failed');
    expect(alert.textContent).toContain('The model is not reachable');
    expect(useBuilderStore.getState().reviewing).toBe(false);
  }, 60_000);

  it("shows n8n's text at the 5000 character limit and the placeholders", async () => {
    const wf = backend().seedWorkflow({ name: 'Empty', nodes: [], connections: {} });
    await openEditor(`/workflow/${wf.id}`);
    const { panel } = await openPanel();
    const box = within(panel).getByRole('textbox', { name: 'Message the AI builder' }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe('Ask AI to build...');
    expect(box.maxLength).toBe(BUILDER_PROMPT_LIMIT);
    expect(within(panel).queryByText("You've reached the 5000 character limit")).toBeNull();
    fireEvent.change(box, { target: { value: 'x'.repeat(BUILDER_PROMPT_LIMIT) } });
    expect(within(panel).getByText("You've reached the 5000 character limit")).toBeTruthy();
    act(() => useWorkflowStore.getState().addNode(node('t', 'Start', 'core.manualTrigger', 0)));
    expect(box.placeholder).toBe('What would you like to modify or add?');
  }, 60_000);

  it('opening the panel loads the chat of this workflow', async () => {
    const wf = backend().seedWorkflow({ name: 'Leads', nodes: NODES, connections: CONNECTIONS });
    seedDemoAiSession(backend(), wf.id, [
      { id: newId(), role: 'user', text: 'Earlier question', createdAt: '2026-11-08T00:00:00Z' },
      { id: newId(), role: 'assistant', text: 'Earlier answer', createdAt: '2026-11-08T00:00:01Z' },
    ]);
    await openEditor(`/workflow/${wf.id}`);
    const { panel } = await openPanel();
    expect(await within(panel).findByText('Earlier answer')).toBeTruthy();
    expect(within(panel).getByText('Earlier question')).toBeTruthy();
    expect(backend().requests.some((r) => r.method === 'POST' && r.path === '/ai/sessions')).toBe(true);
  }, 60_000);

  it('a viewer gets no entry and no prompt box', async () => {
    const b = backend();
    const viewer = newId();
    b.users.push({ id: viewer, email: 'vic@example.com', name: 'Vic', password: 'secret-pass-1' });
    b.memberships.push({ tenantId: b.session!.tenantId, userId: viewer, role: 'viewer' });
    const wf = b.seedWorkflow({ name: 'Empty', nodes: [], connections: {} });
    b.session = { userId: viewer, tenantId: b.session!.tenantId };
    await openEditor(`/workflow/${wf.id}`);
    // wait until /me is in, then neither the canvas nor the top bar offers the builder
    await waitFor(() => expect(useWorkflowStore.getState().readOnly).toBe(true));
    expect(screen.queryByRole('button', { name: 'Build with AI' })).toBeNull();
    // even when opened another way, the panel offers no prompt to a viewer
    act(() => useBuilderStore.getState().setOpen(true));
    const panel = await screen.findByRole('complementary', { name: 'AI builder' });
    expect(within(panel).queryByRole('textbox', { name: 'Message the AI builder' })).toBeNull();
    expect(within(panel).getByText('Only editors can build with AI.')).toBeTruthy();
  }, 60_000);
});

describe('build stream from the server (P5-62)', () => {
  beforeEach(() => {
    signedIn();
  });

  it('reads NDJSON lines split across reads and skips blank and broken lines', async () => {
    const seen: unknown[] = [];
    server.use(
      http.post('*/rest/ai/build', async ({ request }) => {
        seen.push(await request.json());
        const encoder = new TextEncoder();
        const parts = [
          '{"type":"message","id":"a1","te',
          'xt":"Hello"}\n\n{"type":"tool","toolName":"search_nodes","status":"running"}\nnot json\n',
          '{"type":"message","id":"a1","text":" there","delta":true}',
        ];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part));
            controller.close();
          },
        });
        return new HttpResponse(stream, { headers: { 'content-type': 'application/x-ndjson' } });
      }),
    );
    const chunks: BuilderChunk[] = [];
    const body: BuildRequest = { workflowId: 'wf1', text: 'Hi', mode: 'build' };
    await streamBuild(body, (chunk) => chunks.push(chunk), new AbortController().signal);
    expect(seen).toEqual([body]);
    expect(chunks).toEqual([
      { type: 'message', id: 'a1', text: 'Hello' },
      { type: 'tool', toolName: 'search_nodes', status: 'running' },
      { type: 'message', id: 'a1', text: ' there', delta: true },
    ]);
  });

  it('an error answer before the stream becomes an ApiError with its message', async () => {
    server.use(
      http.post('*/rest/ai/build', () =>
        HttpResponse.json(
          { error: { code: 'bad_request', message: 'Message exceeds maximum length of 5000 characters' } },
          { status: 400 },
        ),
      ),
    );
    await expect(
      streamBuild({ workflowId: 'wf1', text: 'Hi' }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ status: 400, message: 'Message exceeds maximum length of 5000 characters' });
  });
});

describe('demo build scripts (P5-62)', () => {
  const lastDraft = (chunks: BuilderChunk[]) =>
    chunks
      .filter((c): c is Extract<BuilderChunk, { type: 'workflow-updated' }> => c.type === 'workflow-updated')
      .at(-1);

  it('a new canvas gets a connected three step draft, a canvas with nodes one more step', () => {
    const fresh = lastDraft(
      demoBuildChunks({ workflowId: 'w', text: 'Leads to CRM', workflowData: { nodes: [] } }),
    );
    expect(fresh?.workflow.nodes.map((n) => n.type)).toEqual([
      'core.scheduleTrigger',
      'core.httpRequest',
      'app.crm',
    ]);
    expect(Object.keys(fresh?.workflow.connections ?? {})).toHaveLength(2);
    const more = lastDraft(
      demoBuildChunks({
        workflowId: 'w',
        text: 'Mark them',
        workflowData: { nodes: NODES, connections: CONNECTIONS },
      }),
    );
    expect(more?.workflow.nodes.map((n) => n.name)).toEqual(['Start', 'Shape', 'Mark as processed']);
    expect(more?.workflow.connections.Shape?.main?.[0]?.[0]?.node).toBe('Mark as processed');
  });

  it('plan mode asks first, answers give a plan, an approved plan builds', () => {
    const asked = demoBuildChunks({ workflowId: 'w', text: 'Plan it', mode: 'plan' });
    expect(asked.some((c) => c.type === 'questions')).toBe(true);
    const planned = demoBuildChunks({
      workflowId: 'w',
      text: '',
      mode: 'plan',
      resumeData: { answers: [{ id: 'trigger', answer: 'Every hour' }] },
    });
    expect(planned.some((c) => c.type === 'plan')).toBe(true);
    const built = demoBuildChunks({ workflowId: 'w', text: '', resumeData: { planDecision: 'approve' } });
    expect(lastDraft(built)).toBeTruthy();
  });

  it('a link asks to read the page; the decision then builds', () => {
    const asked = demoBuildChunks({ workflowId: 'w', text: 'Use https://docs.example.com/api please' });
    expect(asked.at(-1)).toEqual({
      type: 'web-fetch-approval',
      url: 'https://docs.example.com/api',
      domain: 'docs.example.com',
    });
    const approved = demoBuildChunks({
      workflowId: 'w',
      text: '',
      resumeData: { webFetch: { url: 'https://docs.example.com/api', decision: 'approve' } },
    });
    expect(approved.some((c) => c.type === 'tool' && c.toolName === 'web_fetch')).toBe(true);
    expect(lastDraft(approved)).toBeTruthy();
    const denied = demoBuildChunks({
      workflowId: 'w',
      text: '',
      resumeData: { webFetch: { url: 'https://docs.example.com/api', decision: 'deny' } },
    });
    expect(denied.some((c) => c.type === 'tool' && c.toolName === 'web_fetch')).toBe(false);
    expect(lastDraft(denied)).toBeTruthy();
  });
});
