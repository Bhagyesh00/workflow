/** P3-12: open sub-workflows and credentials from the editor: targets, new tab, modal host, commands. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommandRegistry } from '../src/features/command-bar/commands';
import {
  credentialTargets,
  openCredential,
  openSubWorkflow,
  subWorkflowTargets,
} from '../src/features/editor/open-resources';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { signedIn } from './backend';
import { renderApp } from './utils';

const node = (name: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: `id-${name}`,
  name,
  type: 'core.set',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
  ...extra,
});
const trigger = node('Start', { id: 'n1', type: 'core.manualTrigger' });
const child = (name: string, workflowId: unknown, extra: Record<string, unknown> = {}) =>
  node(name, { type: 'core.executeWorkflow', parameters: { workflowId, ...extra } });

describe('targets (model)', () => {
  it('lists Execute Workflow nodes that have a workflow id, with the name or else the id', () => {
    const nodes = [
      trigger,
      child('Call A', { __rl: true, mode: 'list', value: 'wf-a', cachedResultName: 'Invoice sync' }),
      child('Call B', { __rl: true, mode: 'id', value: 'wf-b' }),
      child('Call C', 'wf-c'),
      child('Empty', { __rl: true, mode: 'list', value: '' }),
      child('Missing', undefined),
      child('Inline', { __rl: true, mode: 'id', value: 'wf-x' }, { source: 'parameter' }),
      node('Plain', { parameters: { workflowId: 'wf-z' } }),
    ];
    expect(subWorkflowTargets(nodes)).toEqual([
      { nodeName: 'Call A', workflowId: 'wf-a', label: 'Invoice sync' },
      { nodeName: 'Call B', workflowId: 'wf-b', label: 'wf-b' },
      { nodeName: 'Call C', workflowId: 'wf-c', label: 'wf-c' },
    ]);
  });

  it('lists each credential once, by id, with its type; skips unsaved ones', () => {
    const nodes = [
      node('A', { credentials: { httpBasicAuth: { id: 'c1', name: 'Shop login' } } }),
      node('B', { credentials: { httpBasicAuth: { id: 'c1', name: 'Shop login' } } }),
      node('C', { credentials: { apiKey: { id: 'c2', name: 'Key' }, other: { id: null, name: 'none' } } }),
    ];
    expect(credentialTargets(nodes)).toEqual([
      { id: 'c1', name: 'Shop login', type: 'httpBasicAuth' },
      { id: 'c2', name: 'Key', type: 'apiKey' },
    ]);
    expect(credentialTargets([trigger])).toEqual([]);
  });
});

describe('opening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useUiStore.setState({ openCredentialId: null });
  });

  it('opens the sub-workflow in a new tab without an opener; other nodes do nothing', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    useWorkflowStore.setState({
      nodes: [trigger, child('Call A', { __rl: true, mode: 'id', value: 'wf a/1' })],
    });
    openSubWorkflow('Start');
    openSubWorkflow('Nope');
    expect(open).not.toHaveBeenCalled();
    openSubWorkflow('Call A');
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0];
    expect(String(url)).toMatch(/\/workflow\/wf%20a%2F1$/);
    expect(target).toBe('_blank');
    expect(features).toBe('noopener,noreferrer');
  });

  it('openCredential sets the id the host shows', () => {
    openCredential('c9');
    expect(useUiStore.getState().openCredentialId).toBe('c9');
  });
});

describe('in the editor', () => {
  function seed() {
    const mock = signedIn();
    const now = new Date().toISOString();
    mock.credentials.push({
      id: 'cred-1',
      tenantId: mock.session!.tenantId,
      name: 'Shop login',
      type: 'httpBasicAuth',
      data: { user: 'u' },
      createdAt: now,
      updatedAt: now,
    });
    const target = mock.seedWorkflow({ name: 'Invoice sync', nodes: [trigger], connections: {} });
    return mock.seedWorkflow({
      name: 'Parent',
      nodes: [
        trigger,
        child('Call A', { __rl: true, mode: 'list', value: target.id, cachedResultName: 'Invoice sync' }),
        node('Shape', { id: 'n3', credentials: { httpBasicAuth: { id: 'cred-1', name: 'Shop login' } } }),
      ],
      connections: {},
    });
  }

  async function openEditor(id: string) {
    const utils = renderApp(`/workflow/${id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    await waitFor(() => expect(document.querySelector('[data-id="n1"]')).toBeTruthy());
    return utils;
  }

  async function search(text: string) {
    act(() => {
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    });
    const bar = await screen.findByRole('dialog', { name: 'Command bar' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Search the command bar' }), {
      target: { value: text },
    });
    return within(bar);
  }

  beforeEach(() => {
    useUiStore.setState({ commandBarOpen: false, openCredentialId: null, ndvNode: null, sidePanel: null });
  });
  afterEach(() => {
    useCommandRegistry.setState({ sources: {}, nodeAdder: null });
    vi.restoreAllMocks();
  });

  it('Open sub-workflow lists one child per target and opens it in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await openEditor(seed().id);
    const bar = await search('Open sub-workflow');
    fireEvent.click(await bar.findByRole('option', { name: /Open sub-workflow/ }));
    fireEvent.click(await bar.findByRole('option', { name: /Invoice sync/ }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toMatch(/\/workflow\//);
  });

  it('Open credential shows the credential modal in the editor', async () => {
    await openEditor(seed().id);
    const bar = await search('Open credential');
    fireEvent.click(await bar.findByRole('option', { name: /Open credential/ }));
    fireEvent.click(await bar.findByRole('option', { name: /Shop login/ }));
    expect(useUiStore.getState().openCredentialId).toBe('cred-1');
    await screen.findByDisplayValue('Shop login', {}, { timeout: 10_000 });
    act(() => useUiStore.getState().setOpenCredentialId(null));
    await waitFor(() => expect(screen.queryByDisplayValue('Shop login')).toBeNull());
  });

  it('both commands are absent when the workflow has no targets', async () => {
    const wf = signedIn().seedWorkflow({ name: 'Plain', nodes: [trigger], connections: {} });
    await openEditor(wf.id);
    const bar = await search('Open ');
    await bar.findByRole('option', { name: /Open workflow/ });
    expect(bar.queryByRole('option', { name: /Open sub-workflow/ })).toBeNull();
    expect(bar.queryByRole('option', { name: /Open credential/ })).toBeNull();
  });
});
