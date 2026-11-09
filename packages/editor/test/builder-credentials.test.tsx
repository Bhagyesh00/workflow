/**
 * P5-62: credentials of a builder draft. The model never sees or sets a credential; in the browser each
 * node of the draft that shows a credential slot with nothing in it gets the first credential of that type
 * (n8n's rule), a slot already set keeps its credential, a hidden slot gets nothing, and the review shows
 * the assignment.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBuildStreamConnector } from '../src/api/ai-stream';
import type { CredentialSummary } from '../src/api/types';
import { demoNodeTypes } from '../src/demo/fixtures';
import { assignDefaultCredentials } from '../src/features/builder/assign-credentials';
import { useBuilderStore } from '../src/stores/builder-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const descriptions = {
  get: (type: string): NodeTypeDescription | undefined => demoNodeTypes.find((d) => d.name === type),
};

const node = (id: string, name: string, type: string, extra: Partial<WorkflowNode> = {}) =>
  ({ id, name, type, typeVersion: 1, position: [0, 0], parameters: {}, ...extra }) as WorkflowNode;

const cred = (id: string, name: string, type: string): CredentialSummary => ({
  id,
  name,
  type,
  createdAt: '2026-11-08T00:00:00Z',
  updatedAt: '2026-11-08T00:00:00Z',
});

const CREDENTIALS = [
  cred('basic-1', 'Basic one', 'httpBasicAuth'),
  cred('crm-1', 'Main CRM', 'crmApi'),
  cred('crm-2', 'Backup CRM', 'crmApi'),
];

describe('assignDefaultCredentials (P5-62)', () => {
  it('gives the first credential of the type when there are two', () => {
    const [crm] = assignDefaultCredentials([node('c', 'Acme CRM', 'app.crm')], CREDENTIALS, descriptions);
    expect(crm.credentials).toEqual({ crmApi: { id: 'crm-1', name: 'Main CRM' } });
  });

  it('keeps a credential the node already has', () => {
    const set = node('c', 'Acme CRM', 'app.crm', {
      credentials: { crmApi: { id: 'crm-2', name: 'Backup CRM' } },
    });
    const [crm] = assignDefaultCredentials([set], CREDENTIALS, descriptions);
    expect(crm).toBe(set);
  });

  it('fills only slots the node shows', () => {
    const none = node('h1', 'Open API', 'core.httpRequest', { parameters: { url: 'https://example.com' } });
    const basic = node('h2', 'Basic API', 'core.httpRequest', {
      parameters: {
        url: 'https://example.com',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBasicAuth',
      },
    });
    const [open, withBasic] = assignDefaultCredentials([none, basic], CREDENTIALS, descriptions);
    expect(open).toBe(none);
    expect(withBasic.credentials).toEqual({ httpBasicAuth: { id: 'basic-1', name: 'Basic one' } });
  });

  it('leaves nodes alone when the user has no credential of the type, or the type is unknown', () => {
    const crm = node('c', 'Acme CRM', 'app.crm');
    const unknown = node('u', 'Mystery', 'vendor.unknown');
    const out = assignDefaultCredentials([crm, unknown], [cred('b', 'Basic', 'httpBasicAuth')], descriptions);
    expect(out[0]).toBe(crm);
    expect(out[1]).toBe(unknown);
  });
});

describe('credentials of a draft on the canvas (P5-62)', () => {
  beforeEach(() => {
    signedIn();
    useBuilderStore.getState().reset();
  });
  afterEach(() => {
    setBuildStreamConnector(null);
    useBuilderStore.getState().reset();
  });

  it('the draft gets the first credential of each type, the request carries none, and the review shows it', async () => {
    const user = userEvent.setup();
    // P6-39: a create with no project goes to the personal project; these belong with the workflow's team project
    const projectId = backend().oldestTeamProject(backend().auth().tenant.id).id;
    for (const body of [
      { name: 'Main CRM', type: 'crmApi', data: { apiKey: 'main-secret' }, projectId },
      { name: 'Backup CRM', type: 'crmApi', data: { apiKey: 'backup-secret' }, projectId },
    ]) {
      await backend().handle({ method: 'POST', path: '/credentials', body });
    }
    const main = backend().credentials.find((c) => c.name === 'Main CRM')!;
    const wf = backend().seedWorkflow({
      name: 'CRM',
      nodes: [node('t', 'Start', 'core.manualTrigger')],
      connections: {},
    });
    const bodies: unknown[] = [];
    setBuildStreamConnector(async (body, onChunk) => {
      bodies.push(body);
      onChunk({
        type: 'workflow-updated',
        workflow: {
          name: 'CRM',
          nodes: [
            node('t', 'Start', 'core.manualTrigger'),
            node('c', 'Acme CRM', 'app.crm', {
              position: [300, 0],
              parameters: { resource: 'contact', operation: 'create', email: '={{ $json.email }}' },
            }),
          ],
          connections: { Start: { main: [[{ node: 'Acme CRM', type: 'main', index: 0 }]] } },
        },
      });
    });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' });
    await user.click(entry);
    const panel = await screen.findByRole('complementary', { name: 'AI builder' });
    await user.type(within(panel).getByRole('textbox', { name: 'Message the AI builder' }), 'Add contacts');
    await user.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(useBuilderStore.getState().reviewing).toBe(true));

    const crm = useWorkflowStore.getState().nodes.find((n) => n.name === 'Acme CRM')!;
    expect(crm.credentials).toEqual({ crmApi: { id: main.id, name: 'Main CRM' } });
    // the assignment happens here: the request held no credential, and no secret ever left the server
    expect(JSON.stringify(bodies)).not.toContain(main.id);
    expect(JSON.stringify(bodies)).not.toContain('secret');
    const bar = await within(panel).findByRole('region', { name: 'Draft review' });
    const changes = within(bar).getByRole('group', { name: 'Changes to Acme CRM' });
    expect(within(changes).getByText('credentials.crmApi')).toBeTruthy();
    expect(changes.textContent).toContain('Main CRM');
    expect(changes.textContent).not.toContain('main-secret');
  }, 60_000);
});
