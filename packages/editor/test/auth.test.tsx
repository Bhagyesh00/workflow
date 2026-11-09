import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backend } from './backend';
import { renderApp } from './utils';

describe('authentication', () => {
  it('sends signed-out visitors to sign in and back after login', async () => {
    const user = userEvent.setup();
    backend().createAccount({
      email: 'ada@example.com',
      password: 'analytical-1',
      name: 'Ada',
      workspaceName: 'Engines',
    });
    const { router } = renderApp('/executions');
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    expect(router.state.location.search).toBe('?redirect=%2Fexecutions');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'analytical-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/home/executions'));
    expect(await screen.findByRole('heading', { name: 'Executions' })).toBeTruthy();
    // the session cookie equivalent: the backend now has a session and the shell shows the workspace
    expect(await screen.findAllByText('Engines')).not.toHaveLength(0);
    const login = backend().requests.find((r) => r.path === '/auth/login');
    expect(login?.body).toEqual({ email: 'ada@example.com', password: 'analytical-1' });
  });

  it('shows a clear error for a wrong password', async () => {
    const user = userEvent.setup();
    backend().createAccount({
      email: 'ada@example.com',
      password: 'analytical-1',
      name: 'Ada',
      workspaceName: 'Engines',
    });
    renderApp('/signin');
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-pass-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That email and password do not match an account.')).toBeTruthy();
  });

  it('creates a workspace and lands on an empty workflow list', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/signup');
    await user.type(await screen.findByLabelText('Your name'), 'Grace');
    await user.type(screen.getByLabelText('Work email'), 'grace@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Workspace name'), 'Compilers');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Use at least 8 characters')).toBeTruthy();
    expect(backend().users).toHaveLength(0);

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'cobol-1959');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/workflows'));
    expect(await screen.findByText('Build your first workflow')).toBeTruthy();
    expect(backend().tenants.map((t) => t.name)).toEqual(['Compilers']);
  });

  it('accepts an invitation', async () => {
    const user = userEvent.setup();
    const { tenant } = backend().createAccount({
      email: 'owner@example.com',
      password: 'owner-pass-1',
      name: 'Owner',
      workspaceName: 'Team',
    });
    backend().invitations.push({
      token: 'tok123',
      tenantId: tenant.id,
      email: 'new@example.com',
      role: 'member',
    });
    const { router } = renderApp('/invitation/tok123');
    await user.type(await screen.findByLabelText('Your name'), 'Newcomer');
    await user.type(screen.getByLabelText('Password'), 'welcome-123');
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/workflows'));
    expect(backend().memberships.some((m) => m.tenantId === tenant.id && m.role === 'member')).toBe(true);
  });
});
