/**
 * P6-53 (L8): the editor side of execution data redaction. The workflow settings fields (policy from three
 * switches, the floor holds them on), Settings > Security (the floor, its confirm, a member sees no section,
 * who can reveal), and the execution page (the redacted state, the reason, Reveal with its confirm, the items
 * after, a viewer who cannot reveal).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowSettings } from '@workflow/workflow';
import { act, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../src/api/queries';
import { RedactionSettingsFields } from '../src/components/redaction/RedactionSettingsFields';
import type { StoredExecution } from '../src/demo/mock-backend';
import { useOpenWorkflowStore } from '../src/features/editor/open-resources';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { addMembership, backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const T = { timeout: 20_000 };

function seedRun(mode: 'manual' | 'trigger', policy: WorkflowSettings['redactionPolicy']) {
  const demo = signedIn();
  const { tenant } = demo.auth();
  const team = demo.oldestTeamProject(tenant.id);
  const wf = demo.seedWorkflow({ name: 'Redacted flow', projectId: team.id });
  const run = {
    id: 'exec-redacted-1',
    tenantId: tenant.id,
    workflowId: wf.id,
    workflowName: wf.name,
    mode,
    status: 'error',
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    durationMs: 10,
    errorMessage: 'secret failure text',
    customData: null,
    workflowVersionId: null,
    annotation: null,
    workflowData: {
      id: wf.id,
      name: wf.name,
      nodes: [],
      connections: {},
      settings: { redactionPolicy: policy },
    },
    state: {
      startData: {},
      resultData: {
        runData: {
          Set: [
            {
              startTime: 1,
              executionTime: 1,
              executionStatus: 'success',
              source: [],
              data: { main: [[{ json: { secret: 'canary-editor-value' } }]] },
            },
          ],
        },
        error: { name: 'Error', message: 'secret failure text' },
      },
      executionData: {
        nodeExecutionStack: [],
        waitingExecution: {},
        waitingExecutionSource: {},
        contextData: {},
      },
    },
  } as unknown as StoredExecution;
  demo.executions.unshift(run);
  return { demo, run, tenantId: tenant.id };
}

/** a second member of the signed-in workspace, signed in; `viewer` holds the team project's viewer role */
function signInAs(demo: ReturnType<typeof signedIn>, email: string, role: string) {
  const tenantId = demo.auth().tenant.id;
  const id = `user-${role}`;
  demo.users.push({ id, email, name: role, password: 'secret-pass-1' } as never);
  addMembership(id, role);
  demo.session = { userId: id, tenantId };
}

function Harness({
  initial,
  onChange,
}: {
  initial: WorkflowSettings;
  onChange: (s: WorkflowSettings) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <RedactionSettingsFields
      draft={draft}
      set={(patch) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        onChange(next);
      }}
    />
  );
}

describe('RedactionSettingsFields', () => {
  it('turns the three switches into a policy: production, then manual with it, and callers', async () => {
    signedIn();
    const seen: WorkflowSettings[] = [];
    withProviders(<Harness initial={{}} onChange={(s) => seen.push(s)} />);
    const user = userEvent.setup();
    const production = await screen.findByRole('switch', { name: 'Redact production runs' }, T);
    const manual = screen.getByRole('switch', { name: 'Redact manual runs' });
    expect(manual.hasAttribute('disabled')).toBe(true);
    await user.click(production);
    expect(seen.at(-1)?.redactionPolicy).toBe('non-manual');
    await user.click(screen.getByRole('switch', { name: 'Redact manual runs' }));
    expect(seen.at(-1)?.redactionPolicy).toBe('all');
    await user.click(screen.getByRole('switch', { name: 'Redact production runs' }));
    expect(seen.at(-1)?.redactionPolicy).toBe('none');
    await user.click(screen.getByRole('switch', { name: "Redact callers' copies" }));
    expect(seen.at(-1)?.redactCallerExecutions).toBe(false);
  });

  describe('on a saved workflow, by its own scopes', () => {
    afterEach(() => {
      useOpenWorkflowStore.getState().clear();
      useWorkflowStore.getState().reset();
    });

    /** a member of the workspace with `scopes` on the open workflow */
    function openAsMember(scopes: string[]) {
      const demo = signedIn();
      signInAs(demo, 'member@example.com', 'member');
      act(() => {
        useWorkflowStore
          .getState()
          .load({ id: 'wf-open', name: 'Open flow', nodes: [], connections: {} } as never);
        useOpenWorkflowStore
          .getState()
          .set({ id: 'wf-open', projectId: 'project-1', scopes: scopes as never });
      });
    }

    it('turns every switch off for a project editor without the redaction scopes, and says why', async () => {
      openAsMember(['workflow:read', 'workflow:update']);
      withProviders(<Harness initial={{ redactionPolicy: 'non-manual' }} onChange={() => undefined} />);
      const production = await screen.findByRole('switch', { name: 'Redact production runs' }, T);
      await screen.findByText('You need permission to change data redaction.', undefined, T);
      expect(production.hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('switch', { name: 'Redact manual runs' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('switch', { name: "Redact callers' copies" }).hasAttribute('disabled')).toBe(
        true,
      );
    });

    it('lets a user who may only raise turn a switch on and back off, not lower what was saved', async () => {
      openAsMember(['workflow:read', 'workflow:update', 'workflow:enableRedaction']);
      const seen: WorkflowSettings[] = [];
      withProviders(<Harness initial={{ redactionPolicy: 'non-manual' }} onChange={(s) => seen.push(s)} />);
      const user = userEvent.setup();
      const production = await screen.findByRole('switch', { name: 'Redact production runs' }, T);
      await waitFor(() => expect(production.hasAttribute('disabled')).toBe(true));
      const manual = screen.getByRole('switch', { name: 'Redact manual runs' });
      expect(manual.hasAttribute('disabled')).toBe(false);
      await user.click(manual);
      expect(seen.at(-1)?.redactionPolicy).toBe('all');
      // back to what was saved: no lowering
      await user.click(screen.getByRole('switch', { name: 'Redact manual runs' }));
      expect(seen.at(-1)?.redactionPolicy).toBe('non-manual');
    });
  });

  it('holds the switches on that the workspace floor requires', async () => {
    const demo = signedIn();
    const { tenant } = demo.auth();
    (demo as unknown as { settingsOf(id: string): { redaction: { floor: string } } }).settingsOf(
      tenant.id,
    ).redaction = { floor: 'production' };
    withProviders(<Harness initial={{}} onChange={() => undefined} />);
    const production = await screen.findByRole('switch', { name: 'Redact production runs' }, T);
    await waitFor(() => expect(production.getAttribute('aria-checked')).toBe('true'));
    expect(production.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('switch', { name: 'Redact manual runs' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('Settings > Security, execution data redaction', () => {
  const floorOf = (tenantId: string) =>
    (backend() as unknown as { settingsOf(id: string): { redaction: { floor: string } } }).settingsOf(
      tenantId,
    ).redaction.floor;

  it('saves a new floor after the confirm, and a cancel changes nothing', async () => {
    const demo = signedIn();
    const { tenant } = demo.auth();
    renderApp('/settings/security');
    const user = userEvent.setup();
    const select = await screen.findByLabelText('Redaction floor', undefined, T);
    expect((select as HTMLSelectElement).value).toBe('off');
    await user.selectOptions(select, 'all');
    const dialog = await screen.findByRole('dialog', { name: 'Raise the redaction floor?' }, T);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(floorOf(tenant.id)).toBe('off');
    await user.selectOptions(screen.getByLabelText('Redaction floor'), 'all');
    const again = await screen.findByRole('dialog', { name: 'Raise the redaction floor?' }, T);
    await user.click(within(again).getByRole('button', { name: 'Save floor' }));
    await waitFor(() => expect(floorOf(tenant.id)).toBe('all'));
    await waitFor(() =>
      expect((screen.getByLabelText('Redaction floor') as HTMLSelectElement).value).toBe('all'),
    );
  });

  it('lists who can reveal in a project', async () => {
    const demo = signedIn();
    const { tenant, user: owner } = demo.auth();
    const team = demo.oldestTeamProject(tenant.id);
    demo.projectRelations = demo.projectRelations.filter(
      (r) => !(r.projectId === team.id && r.userId === owner.id),
    );
    demo.projectRelations.push({
      tenantId: tenant.id,
      projectId: team.id,
      userId: owner.id,
      role: 'project:admin',
    });
    renderApp('/settings/security');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Who can reveal in', undefined, T), team.id);
    await user.click(screen.getByRole('button', { name: 'Show who can reveal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Who can reveal data' }, T);
    const list = await within(dialog).findByRole('list', { name: 'Project admins' }, T);
    expect(within(list).getByText(owner.name)).toBeTruthy();
  });

  it('shows a member no redaction section', async () => {
    const demo = signedIn();
    signInAs(demo, 'member@example.com', 'member');
    renderApp('/settings/security');
    await waitFor(() => expect(screen.queryByLabelText('Redaction floor')).toBeNull());
  });
});

describe('the execution page', () => {
  it('shows the redacted state with its reason, hides the error text, and Reveal confirms then shows the run', async () => {
    const { run } = seedRun('manual', 'all');
    renderApp(`/executions/${run.id}`);
    const user = userEvent.setup();
    await screen.findByText('The data of this execution is redacted', undefined, T);
    expect(screen.getByText('This workflow redacts the data of its executions.')).toBeTruthy();
    expect(screen.queryByText(/secret failure text/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reveal data' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reveal execution data' }, T);
    expect(within(dialog).getByText(/This action will be logged/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Reveal data' }));
    await waitFor(() => expect(screen.queryByText('The data of this execution is redacted')).toBeNull(), T);
  });

  it('keeps a revealed run on this page only: the shared cache and a later visit stay redacted', async () => {
    const { run } = seedRun('manual', 'all');
    const { queryClient, router } = renderApp(`/executions/${run.id}`);
    const user = userEvent.setup();
    await screen.findByText('The data of this execution is redacted', undefined, T);
    await user.click(screen.getByRole('button', { name: 'Reveal data' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reveal execution data' }, T);
    await user.click(within(dialog).getByRole('button', { name: 'Reveal data' }));
    await waitFor(() => expect(screen.queryByText('The data of this execution is redacted')).toBeNull(), T);
    const cached = queryClient.getQueryData<{ redactionInfo?: { isRedacted: boolean } }>(
      queryKeys.execution(run.id),
    );
    expect(cached?.redactionInfo?.isRedacted).toBe(true);
    await act(() => router.navigate('/home/executions'));
    await act(() => router.navigate(`/executions/${run.id}`));
    await screen.findByText('The data of this execution is redacted', undefined, T);
  });

  it('shows a run that no channel redacts as it is', async () => {
    const { run } = seedRun('trigger', 'manual-only');
    renderApp(`/executions/${run.id}`);
    await screen.findByText(/Redacted flow/, undefined, T);
    expect(screen.queryByText('The data of this execution is redacted')).toBeNull();
  });

  it('tells a viewer without the reveal scope that they cannot reveal, with no button', async () => {
    const { run, demo } = seedRun('manual', 'all');
    signInAs(demo, 'viewer@example.com', 'viewer');
    renderApp(`/executions/${run.id}`);
    await screen.findByText('The data of this execution is redacted', undefined, T);
    expect(screen.queryByRole('button', { name: 'Reveal data' })).toBeNull();
    expect(screen.getByText(/You need permission to reveal execution data/)).toBeTruthy();
  });
});
