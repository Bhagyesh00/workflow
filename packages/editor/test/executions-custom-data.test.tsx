/** Executions page: the Highlighted data filter (P5-61). */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const LONG = { timeout: 10_000 };

const trigger: WorkflowNode = {
  id: 't',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

function seed() {
  const wf = backend().seedWorkflow({ name: 'Orders', nodes: [trigger], connections: {} });
  const stored = backend().workflow(wf.id);
  const make = (customData: Record<string, string> | null, name: string) => {
    const id = backend().startExecution({ ...stored, name }, { ...stored, name }, { mode: 'manual' });
    backend().executions.find((e) => e.id === id)!.customData = customData;
    return id;
  };
  make({ orderId: '1042' }, 'Run exact');
  make({ orderId: '10420' }, 'Run longer');
  make(null, 'Run plain');
}

describe('Executions page highlighted data filter', () => {
  it('sends key, value and exact as query parameters and narrows the list', async () => {
    signedIn();
    seed();
    const requests: Array<Record<string, string>> = [];
    const original = backend().handle.bind(backend());
    backend().handle = (async (req: Parameters<typeof original>[0]) => {
      if (req.method === 'GET' && req.path === '/executions') {
        const query: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null) query[k] = String(v);
        requests.push(query);
      }
      return original(req);
    }) as typeof original;
    const user = userEvent.setup();
    renderApp('/executions');
    await screen.findByRole('link', { name: 'Run plain' }, LONG);
    expect(requests.at(-1)?.customDataKey).toBeUndefined();

    await user.type(screen.getByLabelText('Highlighted data key'), 'orderId');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Run plain' })).toBeNull(), LONG);
    expect(screen.getByRole('link', { name: 'Run exact' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Run longer' })).toBeTruthy();
    expect(requests.at(-1)).toMatchObject({ customDataKey: 'orderId' });
    expect(requests.at(-1)?.customDataValue).toBeUndefined();

    await user.type(screen.getByLabelText('Highlighted data value'), '1042');
    await waitFor(() => expect(requests.at(-1)).toMatchObject({ customDataValue: '1042' }), LONG);
    expect(screen.getByRole('link', { name: 'Run longer' })).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: 'Exact match' }));
    await waitFor(() => expect(requests.at(-1)).toMatchObject({ customDataExact: 'true' }), LONG);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Run longer' })).toBeNull(), LONG);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('link', { name: 'Run exact' })).toBeTruthy();
  });

  it('keeps the value fields off until a key is typed', async () => {
    signedIn();
    renderApp('/executions');
    const value = (await screen.findByLabelText('Highlighted data value', {}, LONG)) as HTMLInputElement;
    expect(value.disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Exact match' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
