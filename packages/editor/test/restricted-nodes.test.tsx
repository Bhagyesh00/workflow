/**
 * P6-50 (L5): node types a policy blocks. The catalogue sorts them last in their section; the node creator
 * greys them, shows a lock popover with "Contact admin" and adds nothing when one is picked; the canvas shows a
 * lock badge; the workflows page filters by `executionBlockedBy` and badges the rows. All on the demo backend.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Connections, NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AvailableType } from '../src/api/types';
import { demoNodeTypes } from '../src/demo/fixtures';
import { allowDemoTypes, denyDemoTypes } from '../src/demo/mock-type-policies';
import { addNodeFromDescription } from '../src/features/editor/add-node';
import { buildCatalog, filterCatalog } from '../src/lib/node-catalog';
import { adminsOf, restrictedReason, restrictedRows, violationText } from '../src/lib/policy-violations';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const mk = (id: string, name: string, type: string, x: number): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, 10],
  parameters: {},
});

describe('catalogue order', () => {
  const list = demoNodeTypes.filter((d) => ['core.set', 'core.code', 'core.noOp'].includes(d.name));

  it('puts a blocked type last in its section and keeps the rest in order', () => {
    const catalog = buildCatalog(list as NodeTypeDescription[]);
    const plain = filterCatalog(catalog, { query: '' }).flatMap((s) =>
      s.entries.map((e) => e.description.name),
    );
    const blocked = filterCatalog(catalog, { query: '', restricted: new Set(['core.set']) }).flatMap((s) =>
      s.entries.map((e) => e.description.name),
    );
    expect(blocked).toHaveLength(plain.length);
    expect(blocked.at(-1)).toBe('core.set');
    expect(blocked.filter((n) => n !== 'core.set')).toEqual(plain.filter((n) => n !== 'core.set'));
  });

  it('sorts blocked results last too and lists nothing twice', () => {
    const catalog = buildCatalog(list as NodeTypeDescription[]);
    const results = filterCatalog(catalog, { query: 'e', restricted: new Set(['core.set', 'core.code']) });
    const names = results.flatMap((s) => s.entries.map((e) => e.description.name));
    expect(new Set(names).size).toBe(names.length);
    const firstBlocked = names.findIndex((n) => n === 'core.set' || n === 'core.code');
    expect(names.slice(firstBlocked).every((n) => n === 'core.set' || n === 'core.code')).toBe(true);
  });
});

describe('policy-violations helpers', () => {
  it('keeps only the unavailable rows', () => {
    const rows: AvailableType[] = [
      { type: 'a.ok', available: true },
      { type: 'a.no', available: false, scope: 'project', optInAvailable: true, reason: 'x' },
    ];
    const map = restrictedRows(rows);
    expect([...map.keys()]).toEqual(['a.no']);
    expect(restrictedRows(undefined).size).toBe(0);
    expect(restrictedReason(map.get('a.no')!)).toContain('this project');
    expect(restrictedReason(map.get('a.no')!)).toContain('project admin');
    expect(restrictedReason({ scope: 'workspace' })).toContain('this workspace');
  });

  it('names the violation and lists active owners and admins only', () => {
    expect(
      violationText(
        {
          kind: 'node-type-unavailable',
          type: 'core.set',
          scope: 'workspace',
          matchedRuleId: null,
          optInAvailable: false,
        },
        'Edit Fields',
      ),
    ).toBe('Edit Fields is blocked by a policy of this workspace.');
    const members = [
      { userId: '1', email: 'o@x', name: 'O', role: 'owner' },
      { userId: '2', email: 'a@x', name: 'A', role: 'admin', status: 'disabled' },
      { userId: '3', email: 'b@x', name: 'B', role: 'admin', status: 'active' },
      { userId: '4', email: 'm@x', name: 'M', role: 'member' },
      { userId: '5', email: 'p@x', name: 'P', role: 'admin', status: 'pending' },
    ] as const;
    expect(adminsOf([...members]).map((m) => m.userId)).toEqual(['1', '3']);
  });
});

describe('demo available-types', () => {
  it('lists every type, with the blocked ones unavailable in the right scope', async () => {
    signedIn();
    const b = backend();
    const tenantId = b.session!.tenantId;
    const project = b.personalProject(tenantId, b.session!.userId);
    denyDemoTypes(b, tenantId, ['core.set']);
    denyDemoTypes(b, tenantId, ['core.code'], { projectId: project.id });
    const res = await fetchRows(project.id);
    expect(res.find((r) => r.type === 'core.set')).toMatchObject({ available: false, scope: 'workspace' });
    expect(res.find((r) => r.type === 'core.code')).toMatchObject({ available: false, scope: 'project' });
    expect(res.find((r) => r.type === 'core.noOp')).toEqual({ type: 'core.noOp', available: true });
    allowDemoTypes(b, tenantId, ['core.set']);
    expect((await fetchRows(project.id)).find((r) => r.type === 'core.set')?.available).toBe(true);
  });
});

async function fetchRows(projectId: string): Promise<AvailableType[]> {
  const { typePoliciesApi } = await import('../src/api/endpoints');
  return typePoliciesApi.availableTypes(projectId);
}

async function openEditor(nodes: WorkflowNode[], connections: Connections = {}) {
  const wf = backend().seedWorkflow({ name: 'Policy', nodes, connections });
  renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector(`[data-id="${nodes[0].id}"]`)).toBeTruthy());
  await waitFor(() => expect(useWorkflowStore.getState().nodeTypeLookup).toBeDefined());
  return wf;
}

describe('node creator and canvas', () => {
  beforeEach(() => {
    useUiStore.setState({ sidePanel: null, replaceTarget: null, creatorContext: {}, ndvNode: null });
    useToastStore.setState({ toasts: [] });
  });

  it('greys a blocked row, sorts it last, adds nothing and shows the toast', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0)]);
    act(() => useUiStore.getState().openCreator());
    const panel = within(await screen.findByRole('complementary', { name: 'Node creator' }));
    const locked = await panel.findByTestId('creator-item-core.set');
    await waitFor(() => expect(locked.getAttribute('aria-disabled')).toBe('true'));
    const inSection = Array.from(
      locked.closest('section')!.querySelectorAll('[data-testid^="creator-item-"]'),
    );
    expect(inSection.at(-1)).toBe(locked);

    const before = useWorkflowStore.getState().nodes.length;
    await userEvent.setup().click(locked);
    expect(useWorkflowStore.getState().nodes).toHaveLength(before);
    expect(useUiStore.getState().sidePanel).toBe('creator');
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Edit Fields (Set) is restricted');
  });

  it('the lock popover says why and Contact admin lists the admins', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0)]);
    act(() => useUiStore.getState().openCreator());
    const user = userEvent.setup();
    const lock = await screen.findByRole('button', { name: 'Why Edit Fields (Set) is restricted' });
    await user.click(lock);
    const pop = await screen.findByRole('dialog', { name: 'Edit Fields (Set) is restricted' });
    expect(within(pop).getByText(/policy of this workspace blocks this node/)).toBeTruthy();
    await user.click(within(pop).getByRole('button', { name: 'Contact admin' }));
    const dialog = await screen.findByRole('dialog', { name: /Contact admin/ });
    const list = await within(dialog).findByRole('list', { name: 'Workspace admins' });
    expect(within(list).getByText('Olive Owner')).toBeTruthy();
    const mail = within(list).getByRole('link', { name: /Email Olive Owner/ });
    expect(mail.getAttribute('href')).toContain('mailto:owner@example.com');
  });

  it('refuses the add path of the command bar and the picker for a blocked type', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0)]);
    act(() => useUiStore.getState().openCreator());
    await screen.findByRole('button', { name: 'Why Edit Fields (Set) is restricted' });
    const description = demoNodeTypes.find((d) => d.name === 'core.set')!;
    const before = useWorkflowStore.getState().nodes.length;
    const added = addNodeFromDescription(description, {
      flow: { screenToFlowPosition: (p) => p },
      descriptions: { get: (t) => demoNodeTypes.find((d) => d.name === t) },
    });
    expect(added).toBeNull();
    expect(useWorkflowStore.getState().nodes).toHaveLength(before);
    expect(useToastStore.getState().toasts.some((t) => t.title.includes('restricted'))).toBe(true);
    // an allowed type still goes in
    const ok = addNodeFromDescription(demoNodeTypes.find((d) => d.name === 'core.noOp')!, {
      flow: { screenToFlowPosition: (p) => p },
      descriptions: { get: (t) => demoNodeTypes.find((d) => d.name === t) },
      openNdv: false,
    });
    expect(ok).not.toBeNull();
  });

  it('draws a lock badge on a canvas node of a blocked type only', async () => {
    signedIn();
    denyDemoTypes(backend(), backend().session!.tenantId, ['core.set']);
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0), mk('n2', 'Shape', 'core.set', 300)]);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="canvas-lock-badge"]')).toHaveLength(1),
    );
    const badge = document.querySelector('[data-testid="canvas-lock-badge"]')!;
    expect(badge.closest('[data-id]')?.getAttribute('data-id')).toBe('n2');
  });

  it('shows no lock anywhere when nothing is blocked', async () => {
    signedIn();
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0), mk('n2', 'Shape', 'core.set', 300)]);
    act(() => useUiStore.getState().openCreator());
    await screen.findByRole('complementary', { name: 'Node creator' });
    await screen.findByTestId('creator-item-core.set');
    expect(document.querySelectorAll('[data-testid="canvas-lock-badge"]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /is restricted/ })).toBeNull();
  });
});

describe('workflows page filter', () => {
  it('narrows to the workflows holding a blocked type and badges them', async () => {
    signedIn();
    const b = backend();
    denyDemoTypes(b, b.session!.tenantId, ['core.set']);
    b.seedWorkflow({ name: 'Clean flow', nodes: [mk('a', 'Start', 'core.manualTrigger', 0)] });
    b.seedWorkflow({ name: 'Blocked flow', nodes: [mk('b', 'Shape', 'core.set', 0)] });
    renderApp('/workflows');
    await screen.findByText('Clean flow', {}, { timeout: 20_000 });
    expect(screen.getByText('Blocked flow')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Blocked by a policy' }));
    await waitFor(() => expect(screen.queryByText('Clean flow')).toBeNull());
    expect(screen.getByText('Blocked flow')).toBeTruthy();
    expect(screen.getByText('Blocked by policy')).toBeTruthy();
  });
});
