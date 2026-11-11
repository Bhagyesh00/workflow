/**
 * P6-50 (L5): the NDV panels for blocked types, on the demo backend: "This node is restricted" with Replace node
 * (opens the creator in replace mode; picking an allowed node swaps it in), the callout on an agent whose tool is
 * blocked, and the callout on an Execute Workflow node whose sub-workflow would not start.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Connections, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { denyDemoTypes } from '../src/demo/mock-type-policies';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const mk = (
  id: string,
  name: string,
  type: string,
  x: number,
  parameters: WorkflowNode['parameters'] = {},
): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [x, 10], parameters });

async function openEditor(nodes: WorkflowNode[], connections: Connections = {}) {
  const wf = backend().seedWorkflow({ name: 'NDV policy', nodes, connections });
  renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector(`[data-id="${nodes[0].id}"]`)).toBeTruthy());
  await waitFor(() => expect(useWorkflowStore.getState().nodeTypeLookup).toBeDefined());
  return wf;
}

describe('restricted node panel', () => {
  beforeEach(() => {
    useUiStore.setState({ sidePanel: null, replaceTarget: null, creatorContext: {}, ndvNode: null });
    useToastStore.setState({ toasts: [] });
  });

  it('shows "This node is restricted" for a blocked type and nothing for an allowed one', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0), mk('n2', 'Shape', 'core.set', 300)]);
    act(() => useUiStore.getState().openNdv('Start'));
    await screen.findByRole('dialog', { name: 'Start details' });
    expect(screen.queryByText('This node is restricted')).toBeNull();
    act(() => useUiStore.getState().openNdv('Shape'));
    expect(await screen.findByText('This node is restricted')).toBeTruthy();
    expect(screen.getByText(/policy of this workspace blocks this node/)).toBeTruthy();
  });

  it('Replace node swaps in an allowed node and keeps the cables', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0), mk('n2', 'Shape', 'core.set', 300)], {
      Start: { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
    });
    act(() => useUiStore.getState().openNdv('Shape'));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Replace node' }));
    expect(useUiStore.getState()).toMatchObject({
      sidePanel: 'creator',
      replaceTarget: 'Shape',
      ndvNode: null,
    });
    const panel = within(await screen.findByRole('complementary', { name: 'Node creator' }));
    expect(await panel.findByText('Replace Shape')).toBeTruthy();
    // the blocked type stays in the list but cannot be picked
    await user.click(await panel.findByTestId('creator-item-core.set'));
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'Shape']);
    await user.click(await panel.findByText('Code'));
    const s = useWorkflowStore.getState();
    expect(s.nodes.map((n) => n.name)).toEqual(['Start', 'Code']);
    expect(s.nodes[1].position).toEqual([300, 10]);
    expect(s.connections.Start.main?.[0]?.[0]?.node).toBe('Code');
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="canvas-lock-badge"]')).toHaveLength(0),
    );
  });

  it('Contact admin opens the list of admins', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n2', 'Shape', 'core.set', 300)]);
    act(() => useUiStore.getState().openNdv('Shape'));
    const user = userEvent.setup();
    const callout = (await screen.findByText('This node is restricted')).closest('div')!;
    await user.click(within(callout).getByRole('button', { name: 'Contact admin' }));
    const list = await screen.findByRole('list', { name: 'Workspace admins' });
    expect(within(list).getByText('owner@example.com')).toBeTruthy();
  });

  it('hides Replace node while the workflow is read only', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n2', 'Shape', 'core.set', 300)]);
    act(() => useWorkflowStore.setState({ readOnly: true }));
    act(() => useUiStore.getState().openNdv('Shape'));
    await screen.findByText('This node is restricted');
    expect(screen.queryByRole('button', { name: 'Replace node' })).toBeNull();
  });
});

describe('tool and sub-workflow callouts', () => {
  beforeEach(() => {
    useUiStore.setState({ sidePanel: null, replaceTarget: null, creatorContext: {}, ndvNode: null });
  });

  it('warns on an agent whose connected tool is blocked, and only then', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.httpRequestTool']);
    await openEditor(
      [
        mk('n1', 'Agent', 'ai.agent', 0),
        mk('n2', 'Fetch', 'core.httpRequestTool', 300),
        mk('n3', 'Calc', 'ai.toolCalculator', 300),
      ],
      {
        Fetch: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
        Calc: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
      },
    );
    act(() => useUiStore.getState().openNdv('Agent'));
    expect(await screen.findByText('Some tools of this node are restricted')).toBeTruthy();
    const text = screen.getByText(/A policy blocks this tool/).textContent ?? '';
    expect(text).toContain('Fetch');
    expect(text).not.toContain('Calc');
  });

  it('shows no tool callout when no tool is blocked', async () => {
    signedIn();
    await openEditor([mk('n1', 'Agent', 'ai.agent', 0), mk('n2', 'Fetch', 'core.httpRequestTool', 300)], {
      Fetch: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    });
    act(() => useUiStore.getState().openNdv('Agent'));
    await screen.findByRole('dialog', { name: 'Agent details' });
    expect(screen.queryByText('Some tools of this node are restricted')).toBeNull();
  });

  it('warns on an Execute Workflow node whose sub-workflow holds a blocked type', async () => {
    signedIn();
    const b = backend();
    denyDemoTypes(b, b.session!.tenantId, ['core.set']);
    const sub = b.seedWorkflow({ name: 'Child', nodes: [mk('c1', 'Shape', 'core.set', 0)] });
    const ok = b.seedWorkflow({ name: 'Clean child', nodes: [mk('d1', 'Nop', 'core.noOp', 0)] });
    await openEditor([
      mk('n1', 'Call child', 'core.executeWorkflow', 0, { source: 'database', workflowId: sub.id }),
      mk('n2', 'Call clean', 'core.executeWorkflow', 300, { source: 'database', workflowId: ok.id }),
    ]);
    act(() => useUiStore.getState().openNdv('Call child'));
    expect(await screen.findByText('The workflow this node calls would not start')).toBeTruthy();
    expect(screen.getByText('Shape is blocked by a policy of this workspace.')).toBeTruthy();
    act(() => useUiStore.getState().openNdv('Call clean'));
    await screen.findByRole('dialog', { name: 'Call clean details' });
    await waitFor(() =>
      expect(screen.queryByText('The workflow this node calls would not start')).toBeNull(),
    );
  });
});
