/**
 * P6-20: the members page: search, role filter, sort, paging, the 2FA and last active columns, Pending,
 * Disabled and Managed by SCIM badges, inviting several people at once, resend and copy invite link (the old
 * link stops working), and the Invite button following `useInviteGate`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const gate = vi.hoisted(() => ({ value: { disabled: false } as { disabled: boolean; reason?: string } }));
vi.mock('../src/lib/invite-gate', () => ({ useInviteGate: () => gate.value }));

const T = { timeout: 20_000 };

function addMember(
  id: string,
  name: string,
  extra: Partial<ReturnType<typeof backend>['memberships'][number]> = {},
) {
  const demo = backend();
  demo.users.push({ id, email: `${id}@example.com`, name, password: 'x' });
  demo.memberships.push({ tenantId: demo.auth().tenant.id, userId: id, role: 'member', ...extra });
}

function setup() {
  gate.value = { disabled: false };
  return signedIn();
}

const rowOf = async (text: string) => (await screen.findByText(text, {}, T)).closest('li') as HTMLElement;

describe('members page list', () => {
  it('shows the Pending, Disabled and Managed by SCIM badges, 2FA and last active', async () => {
    const demo = setup();
    addMember('u-dee', 'Dee Disabled', { status: 'disabled' });
    addMember('u-sam', 'Sam Scim', {
      managedByScim: true,
      lastActiveAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    demo.mfaEnabledUsers.add('u-sam');
    demo.invitations.push({
      token: 'tok-1',
      tenantId: demo.auth().tenant.id,
      email: 'wait@example.com',
      role: 'member',
    });
    renderApp('/settings/members');

    const dee = await rowOf('Dee Disabled');
    expect(within(dee).getByText('Disabled')).toBeTruthy();
    expect(within(dee).getByText('Never')).toBeTruthy();
    const sam = await rowOf('Sam Scim');
    expect(within(sam).getByText('Managed by SCIM')).toBeTruthy();
    expect(within(sam).getByText('On')).toBeTruthy();
    expect(within(sam).getByText(/hour/)).toBeTruthy();
    const pending = await rowOf('wait@example.com');
    expect(within(pending).getByText('Pending')).toBeTruthy();
    expect(within(pending).getByRole('button', { name: 'Resend' })).toBeTruthy();
    // a pending row has no role select and no removal
    expect(within(pending).queryByLabelText(/^Role of/)).toBeNull();
    expect(within(pending).queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('searches by name or email and filters by role', async () => {
    setup();
    addMember('u-ann', 'Ann Adams');
    addMember('u-bob', 'Bob Brown', { role: 'admin' });
    const user = userEvent.setup();
    renderApp('/settings/members');
    expect(await screen.findByText('Ann Adams', {}, T)).toBeTruthy();
    expect(screen.getByText('Bob Brown')).toBeTruthy();

    await user.type(screen.getByLabelText('Search members'), 'bob');
    await waitFor(() => expect(screen.queryByText('Ann Adams')).toBeNull(), T);
    expect(screen.getByText('Bob Brown')).toBeTruthy();

    await user.clear(screen.getByLabelText('Search members'));
    await waitFor(() => expect(screen.getByText('Ann Adams')).toBeTruthy(), T);
    await user.selectOptions(screen.getByLabelText('Filter by role'), 'admin');
    await waitFor(() => expect(screen.queryByText('Ann Adams')).toBeNull(), T);
    expect(screen.getByText('Bob Brown')).toBeTruthy();

    await user.type(screen.getByLabelText('Search members'), 'nobody-here');
    expect(await screen.findByText('No members match', {}, T)).toBeTruthy();
  });

  it('sorts by a column and flips the direction on a second click', async () => {
    setup();
    addMember('u-zed', 'Zed Zane');
    addMember('u-amy', 'Amy Avery');
    const user = userEvent.setup();
    renderApp('/settings/members');
    const names = () =>
      screen
        .getAllByRole('listitem')
        .map((li) => li.textContent ?? '')
        .filter((t) => /Amy Avery|Olive Owner|Zed Zane/.test(t))
        .map((t) => /Amy Avery|Olive Owner|Zed Zane/.exec(t)?.[0]);
    await screen.findByText('Zed Zane', {}, T);
    expect(names()).toEqual(['Amy Avery', 'Olive Owner', 'Zed Zane']);
    const byName = screen.getByRole('button', { name: 'Sort by Name' });
    expect(byName.getAttribute('aria-pressed')).toBe('true');
    await user.click(byName);
    await waitFor(() => expect(names()).toEqual(['Zed Zane', 'Olive Owner', 'Amy Avery']), T);
    await user.click(screen.getByRole('button', { name: 'Sort by Role' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sort by Role' }).getAttribute('aria-pressed')).toBe('true'),
    );
    expect(screen.getByRole('button', { name: 'Sort by Name' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('pages 25 at a time', async () => {
    setup();
    for (let i = 0; i < 30; i++)
      addMember(`u-${String(i).padStart(2, '0')}`, `Person ${String(i).padStart(2, '0')}`);
    const user = userEvent.setup();
    renderApp('/settings/members');
    await screen.findByText('Person 00', {}, T);
    expect(screen.getByText(/1–25 of 31/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Person 29')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/26–31 of 31/, {}, T)).toBeTruthy();
    expect(screen.getByText('Person 29')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('inviting', () => {
  it('an admin invites three at once and sees a link per person', async () => {
    const demo = setup();
    const user = userEvent.setup();
    renderApp('/settings/members');
    await user.click(await screen.findByRole('button', { name: 'Invite' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a member' });
    const send = within(dialog).getByRole('button', { name: 'Send invitation' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.type(
      within(dialog).getByLabelText('Email'),
      'a1@example.com, b2@example.com{enter}c3@example.com',
    );
    await user.click(send);
    const results = await within(dialog).findByRole('list', { name: 'Invitation results' }, T);
    expect(within(results).getAllByText(/\/invitation\//)).toHaveLength(3);
    expect(demo.invitations.map((i) => i.email)).toEqual([
      'a1@example.com',
      'b2@example.com',
      'c3@example.com',
    ]);
    // the box is empty again; the list behind the dialog has the three as Pending
    expect((within(dialog).getByLabelText('Email') as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(screen.getAllByText('Pending')).toHaveLength(3), T);
  });

  it('keeps the people who failed in the box and says why', async () => {
    setup();
    const user = userEvent.setup();
    renderApp('/settings/members');
    await user.click(await screen.findByRole('button', { name: 'Invite' }, T));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a member' });
    await user.type(within(dialog).getByLabelText('Email'), 'owner@example.com good@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText('Could not invite owner@example.com', {}, T)).toBeTruthy();
    expect(within(dialog).getByText('This user is already a member of the workspace')).toBeTruthy();
    expect(within(dialog).getByText('Invitation for good@example.com')).toBeTruthy();
    expect((within(dialog).getByLabelText('Email') as HTMLTextAreaElement).value).toBe('owner@example.com');
  });

  it('the Invite button is off, with the reason, while the gate says so', async () => {
    setup();
    gate.value = { disabled: true, reason: 'SSO manages the members' };
    renderApp('/settings/members');
    const button = await screen.findByRole('button', { name: 'Invite' }, T);
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toBe('SSO manages the members');
  });

  it('resend gives a pending person a new link: the old one stops working', async () => {
    const demo = setup();
    demo.invitations.push({
      token: 'old-token',
      tenantId: demo.auth().tenant.id,
      email: 'wait@example.com',
      role: 'member',
    });
    const user = userEvent.setup();
    renderApp('/settings/members');
    const row = await rowOf('wait@example.com');
    await user.click(within(row).getByRole('button', { name: 'Resend' }));
    // the demo sends no mail, so the new link is shown
    const dialog = await screen.findByRole('dialog', { name: 'Invitation link' }, T);
    expect(demo.invitations[0].token).not.toBe('old-token');
    expect(within(dialog).getByText(new RegExp(`/invitation/${demo.invitations[0].token}$`))).toBeTruthy();
    const old = await demo.handle({
      method: 'POST',
      path: '/invitations/old-token/accept',
      body: { name: 'X', password: 'Passw0rd!' },
    });
    expect(old.status).toBe(404);
  });

  it('copy invite link copies a fresh link and the old one dies', async () => {
    const demo = setup();
    demo.invitations.push({
      token: 'old-token',
      tenantId: demo.auth().tenant.id,
      email: 'wait@example.com',
      role: 'member',
    });
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    renderApp('/settings/members');
    const row = await rowOf('wait@example.com');
    await user.click(within(row).getByRole('button', { name: 'Copy invite link' }));
    expect(await screen.findByText('Invitation link copied', {}, T)).toBeTruthy();
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/\/invitation\/.+/));
    expect(write.mock.calls[0][0]).toContain(demo.invitations[0].token);
    expect(demo.invitations[0].token).not.toBe('old-token');
  });
});

describe('a member without invite rights', () => {
  it('sees the list but no Invite, Resend or Copy invite link', async () => {
    const demo = setup();
    demo.invitations.push({
      token: 'tok',
      tenantId: demo.auth().tenant.id,
      email: 'wait@example.com',
      role: 'member',
    });
    addMember('u-sam', 'Sam Shaw');
    demo.signIn('u-sam@example.com');
    renderApp('/settings/members');
    expect(await screen.findByText('Olive Owner', {}, T)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).toBeNull();
  });
});

describe('the demo list route', () => {
  it('counts statuses for user:create only, and refuses a status filter without it', async () => {
    const demo = setup();
    addMember('u-dee', 'Dee', { status: 'disabled' });
    demo.invitations.push({
      token: 't',
      tenantId: demo.auth().tenant.id,
      email: 'p@example.com',
      role: 'member',
    });
    const asAdmin = await demo.handle({ method: 'GET', path: '/members', query: { status: 'disabled' } });
    expect(asAdmin.status).toBe(200);
    expect((asAdmin.body as any).count).toBe(1);
    expect((asAdmin.body as any).statusCounts).toEqual({ active: 1, pending: 1, disabled: 1 });
    demo.signIn('u-dee@example.com');
    demo.setDemoRole('member');
    const asMember = await demo.handle({ method: 'GET', path: '/members', query: { status: 'disabled' } });
    expect(asMember.status).toBe(403);
    const plain = await demo.handle({ method: 'GET', path: '/members' });
    expect((plain.body as any).statusCounts).toBeUndefined();
    const bad = await demo.handle({ method: 'GET', path: '/members', query: { sort: 'password:asc' } });
    expect(bad.status).toBe(400);
  });
});
