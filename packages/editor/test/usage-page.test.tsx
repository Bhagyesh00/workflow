/** P6-84 (L16): the Usage page shows the active count and the limit; no limit reads as unlimited. */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

describe('Usage page', () => {
  it('shows the count against the limit', async () => {
    const b = signedIn();
    b.options.activeWorkflowsLimit = 5;
    b.seedWorkflow({ name: 'A', active: true });
    b.seedWorkflow({ name: 'B', active: true });
    b.seedWorkflow({ name: 'C', active: false });
    renderApp('/settings/usage');
    expect((await screen.findByTestId('usage-active', {}, T)).textContent).toBe('2 of 5 active workflows');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  });

  it('reads no limit as unlimited', async () => {
    signedIn();
    backend().seedWorkflow({ name: 'A', active: true });
    renderApp('/settings/usage');
    expect((await screen.findByTestId('usage-active', {}, T)).textContent).toContain(
      '1 active workflows (unlimited)',
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it("does not count another workspace's workflows", async () => {
    signedIn();
    const other = backend().seedWorkflow({ name: 'Elsewhere', active: true });
    backend().workflow(other.id).tenantId = 'another-tenant';
    renderApp('/settings/usage');
    expect((await screen.findByTestId('usage-active', {}, T)).textContent).toContain('0 active');
  });
});
