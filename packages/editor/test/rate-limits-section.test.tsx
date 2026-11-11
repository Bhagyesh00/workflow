/**
 * P6-83 (L15): Settings > Security, the public API rate limits: the saved values load, a change saves only the
 * fields changed, a bad number blocks the save, and no section for a member without `securitySettings:manage`.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { rateLimitsApi } from '../src/api/endpoints';
import { signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

describe('rate limits section', () => {
  it('shows the defaults with the switch off and the fixed 600 note', async () => {
    signedIn();
    renderApp('/settings/security');
    const toggle = await screen.findByRole('switch', { name: 'Public API rate limits' }, T);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect((screen.getByLabelText('Global read limit') as HTMLInputElement).value).toBe('1200');
    expect((screen.getByLabelText('Endpoint write window (seconds)') as HTMLInputElement).value).toBe('60');
    expect(screen.getByText(/each API key can make 600 calls per minute/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save rate limits' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves the switch and a changed limit, and keeps what was not touched', async () => {
    signedIn();
    renderApp('/settings/security');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Public API rate limits' }, T));
    const limit = screen.getByLabelText('Global read limit');
    await user.clear(limit);
    await user.type(limit, '0');
    await user.click(screen.getByRole('button', { name: 'Save rate limits' }));
    await waitFor(async () => {
      const saved = await rateLimitsApi.get();
      expect(saved.enabled).toBe(true);
      expect(saved.globalReadLimit).toBe(0);
    });
    const saved = await rateLimitsApi.get();
    expect(saved.globalWriteLimit).toBe(600);
    await waitFor(() =>
      expect(screen.queryByText(/each API key can make 600 calls per minute/)).toBeNull(),
    );
    expect((screen.getByRole('button', { name: 'Save rate limits' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks the save on a bad number', async () => {
    signedIn();
    renderApp('/settings/security');
    const user = userEvent.setup();
    const window = await screen.findByLabelText('Global write window (seconds)', {}, T);
    await user.clear(window);
    await user.type(window, '0');
    expect(screen.getByText('Enter 1 or more')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save rate limits' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(window);
    await user.type(window, 'abc');
    expect(screen.getByText('Enter a whole number')).toBeTruthy();
  });

  it('shows nothing to a member without securitySettings:manage', async () => {
    const demo = signedIn();
    demo.setDemoRole('member');
    renderApp('/settings/security');
    await screen.findByText('Only admins can change the personal space settings.', {}, T);
    expect(screen.queryByRole('switch', { name: 'Public API rate limits' })).toBeNull();
    expect(screen.queryByText('Public API rate limits')).toBeNull();
  });
});
