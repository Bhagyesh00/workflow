/**
 * Phase 6 S5 C0 contracts (C0e and C0f): the Log streaming and OpenTelemetry links show for an admin and hide
 * for a member; `/settings/log-streaming` and `/settings/opentelemetry` render in the settings layout; the three
 * telemetry tag slots (stubs of L11, mocked here to a test id) are mounted inside WorkflowSettingsModal,
 * NodeSettingsForm and ProjectSettingsPage; the API key form lists the seven new scopes; every demo
 * `/eventbus/*` and `/otel/*` route is registered (501 until L8 and L12); and the demo project PATCH keeps
 * `customTelemetryTags` (FULL). Stubs (501, null) are the lanes' and are not asserted beyond being registered
 * and mounted.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectDetail } from '../src/api/types';
import { NodeSettingsForm } from '../src/components/ndv/NodeSettingsForm';
import { ApiKeyScopesField } from '../src/components/settings/ApiKeyScopesField';
import { WorkflowSettingsModal } from '../src/components/workflow/WorkflowSettingsModal';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

vi.mock('../src/components/telemetry/WorkflowTelemetryTags', () => ({
  WorkflowTelemetryTags: () => <div data-testid="workflow-telemetry-tags" />,
}));
vi.mock('../src/components/telemetry/NodeTelemetryTags', () => ({
  NodeTelemetryTags: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="node-telemetry-tags" data-readonly={String(readOnly)} />
  ),
}));
vi.mock('../src/components/telemetry/ProjectTelemetryTags', () => ({
  ProjectTelemetryTags: ({
    value,
    onChange,
    disabled,
  }: {
    value: Array<{ key: string; value: string }>;
    onChange(next: Array<{ key: string; value: string }>): void;
    disabled?: boolean;
  }) => (
    <div data-testid="project-telemetry-tags" data-disabled={String(Boolean(disabled))}>
      <span>tags: {value.map((tag) => `${tag.key}=${tag.value}`).join(',') || 'none'}</span>
      <button type="button" onClick={() => onChange([...value, { key: 'team', value: 'growth' }])}>
        add tag stub
      </button>
    </div>
  ),
}));

const T = { timeout: 20_000 };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function call(method: Method, path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return {
    status: res.status,
    body: res.body as { data?: unknown; error?: { code: string; message: string } },
  };
}

const trigger: WorkflowNode = {
  id: 't1',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

function teamProject() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const project = demo.createProject({ tenantId, name: 'Growth', type: 'team', description: 'Marketing' });
  return { demo, project };
}

describe('Log streaming and OpenTelemetry links and routes', () => {
  it('shows both links to an admin and hides them from a member', async () => {
    signedIn().setDemoRole('admin');
    const first = renderApp('/settings/account');
    const logs = await screen.findByRole('link', { name: 'Log streaming' }, T);
    expect(logs.getAttribute('href')).toBe('/settings/log-streaming');
    const otel = screen.getByRole('link', { name: 'OpenTelemetry' });
    expect(otel.getAttribute('href')).toBe('/settings/opentelemetry');
    first.unmount();
    backend().setDemoRole('member');
    renderApp('/settings/account');
    await screen.findByRole('link', { name: 'API keys' }, T);
    // the role has loaded once the account page shows it
    await screen.findAllByText('member', {}, T);
    expect(screen.queryByRole('link', { name: 'Log streaming' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'OpenTelemetry' })).toBeNull();
  });

  for (const path of ['/settings/log-streaming', '/settings/opentelemetry']) {
    it(`${path} renders in the settings layout`, async () => {
      signedIn();
      renderApp(path);
      expect(await screen.findByRole('heading', { name: 'Settings' }, T)).toBeTruthy();
      expect(screen.queryByText('This page does not exist')).toBeNull();
    });
  }
});

describe('telemetry tag slots (stub, L11)', () => {
  it('WorkflowSettingsModal mounts WorkflowTelemetryTags', async () => {
    signedIn();
    withProviders(
      <WorkflowSettingsModal
        open
        onClose={() => undefined}
        value={{}}
        workflowId="w1"
        onSave={vi.fn()}
        readOnly={false}
      />,
    );
    const dialog = await screen.findByRole('dialog', {}, T);
    expect(within(dialog).getByTestId('workflow-telemetry-tags')).toBeTruthy();
  });

  it('NodeSettingsForm mounts NodeTelemetryTags with its readOnly', () => {
    signedIn();
    const { container } = withProviders(<NodeSettingsForm node={trigger} readOnly onChange={vi.fn()} />);
    const slot = within(container).getByTestId('node-telemetry-tags');
    expect(slot.getAttribute('data-readonly')).toBe('true');
  });

  it('ProjectSettingsPage mounts ProjectTelemetryTags with the stored tags and saves a change', async () => {
    const { demo, project } = teamProject();
    demo.projects.find((p) => p.id === project.id)!.customTelemetryTags = [{ key: 'env', value: 'prod' }];
    renderApp(`/projects/${project.id}/settings`);
    const slot = await screen.findByTestId('project-telemetry-tags', {}, T);
    await within(slot).findByText('tags: env=prod', {}, T);
    expect(slot.getAttribute('data-disabled')).toBe('false');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(within(slot).getByRole('button', { name: 'add tag stub' }));
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() =>
      expect(demo.projects.find((p) => p.id === project.id)?.customTelemetryTags).toEqual([
        { key: 'env', value: 'prod' },
        { key: 'team', value: 'growth' },
      ]),
    );
  });
});

describe('API key scopes', () => {
  it('lists the seven new scopes in two groups', () => {
    render(<ApiKeyScopesField value={['otel:manage']} onChange={vi.fn()} />);
    const logScopes = [
      'eventBusDestination:list',
      'eventBusDestination:read',
      'eventBusDestination:create',
      'eventBusDestination:update',
      'eventBusDestination:test',
      'eventBusDestination:delete',
    ];
    for (const scope of [...logScopes, 'otel:manage'])
      expect(screen.getByRole('checkbox', { name: scope })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'otel:manage' }) as HTMLInputElement).checked).toBe(true);
    const namesIn = (label: string, prefix: string) =>
      within(screen.getByRole('group', { name: label }))
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label') ?? box.closest('label')?.textContent ?? '')
        .filter((name) => name.startsWith(prefix));
    expect(namesIn('Log streaming', 'eventBusDestination:')).toEqual(logScopes);
    expect(namesIn('OpenTelemetry', 'otel:')).toEqual(['otel:manage']);
    // the two S5 groups follow S3's Insights, in the server's API_KEY_SCOPES order
    const groups = screen
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label'))
      .filter((label): label is string => label !== null);
    const at = groups.indexOf('Insights');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(groups.slice(at + 1, at + 3)).toEqual(['Log streaming', 'OpenTelemetry']);
  });
});

describe('demo /eventbus/* and /otel/* routes (stub, L8 and L12)', () => {
  it('registers every REST path (501 until its lane, never 404)', async () => {
    signedIn();
    const paths: Array<[Method, string]> = [
      ['GET', '/eventbus/eventnames'],
      ['GET', '/eventbus/destination'],
      ['GET', '/eventbus/destination?id=d1'],
      ['POST', '/eventbus/destination'],
      ['DELETE', '/eventbus/destination?id=d1'],
      ['POST', '/eventbus/testmessage?id=d1'],
      ['GET', '/otel/settings'],
      ['PUT', '/otel/settings'],
      ['POST', '/otel/test-trace'],
    ];
    for (const [method, path] of paths)
      expect((await call(method, path)).status, `${method} ${path}`).not.toBe(404);
  });
});

describe('demo project customTelemetryTags (FULL)', () => {
  it('PATCH keeps the tags (keys trimmed), absent keeps them, null clears them; GET answers them', async () => {
    const { project } = teamProject();
    let res = await call('GET', `/projects/${project.id}`);
    expect((res.body.data as ProjectDetail).customTelemetryTags).toEqual([]);

    res = await call('PATCH', `/projects/${project.id}`, {
      customTelemetryTags: [{ key: ' env ', value: 'prod' }],
    });
    expect(res.status).toBe(200);
    expect((res.body.data as ProjectDetail).customTelemetryTags).toEqual([{ key: 'env', value: 'prod' }]);

    res = await call('PATCH', `/projects/${project.id}`, { name: 'Growth team' });
    expect((res.body.data as ProjectDetail).customTelemetryTags).toEqual([{ key: 'env', value: 'prod' }]);
    res = await call('GET', `/projects/${project.id}`);
    expect((res.body.data as ProjectDetail).customTelemetryTags).toEqual([{ key: 'env', value: 'prod' }]);

    res = await call('PATCH', `/projects/${project.id}`, { customTelemetryTags: null });
    expect((res.body.data as ProjectDetail).customTelemetryTags).toEqual([]);
  });

  it('PATCH refuses invalid tags with 400 and changes nothing', async () => {
    const { demo, project } = teamProject();
    for (const customTelemetryTags of [
      'env=prod',
      [{ key: '', value: 'x' }],
      [
        { key: 'env', value: 'a' },
        { key: 'env', value: 'b' },
      ],
    ]) {
      const res = await call('PATCH', `/projects/${project.id}`, { name: 'Renamed', customTelemetryTags });
      expect(res.status, JSON.stringify(customTelemetryTags)).toBe(400);
    }
    const stored = demo.projects.find((p) => p.id === project.id)!;
    expect(stored.name).toBe('Growth');
    expect(stored.customTelemetryTags).toEqual([]);
  });
});
