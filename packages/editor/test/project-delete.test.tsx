/**
 * P6-42: delete a team project from its settings: radio Transfer or Wipe; wipe needs the text
 * "delete all data".
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

function setup() {
  const demo = signedIn();
  const tenantId = demo.auth().tenant.id;
  const from = demo.createProject({ tenantId, name: 'Old team', type: 'team' });
  const to = demo.createProject({ tenantId, name: 'New team', type: 'team' });
  demo.seedWorkflow({ name: 'In old', nodes: [], connections: {}, projectId: from.id });
  return { demo, from, to };
}

async function openDialog(projectId: string) {
  renderApp(`/projects/${projectId}/settings`);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Delete project' }, T));
  const dialog = await screen.findByRole('dialog');
  return { user, dialog };
}

describe('delete project dialog', () => {
  it('transfers the work to the chosen project and leaves the settings', async () => {
    const { demo, from, to } = setup();
    const { user, dialog } = await openDialog(from.id);
    const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
    expect(radios[0]?.checked).toBe(true);
    const target = within(dialog).getByLabelText('Transfer to project') as HTMLSelectElement;
    await waitFor(() => expect(within(target).queryByText('New team')).toBeTruthy());
    expect(within(target).queryByText('Old team')).toBeNull();
    await user.selectOptions(target, to.id);
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(demo.projects.some((p) => p.id === from.id)).toBe(false));
    expect(demo.workflows.find((w) => w.name === 'In old')?.projectId).toBe(to.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('wipe needs the text "delete all data" and then deletes the work', async () => {
    const { demo, from } = setup();
    const { user, dialog } = await openDialog(from.id);
    await user.click(within(dialog).getAllByRole('radio')[1] as HTMLElement);
    const confirm = within(dialog).getByLabelText('Confirmation text');
    const button = within(dialog).getByRole('button', { name: 'Delete project' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(confirm, 'delete all dat');
    expect(button.disabled).toBe(true);
    await user.type(confirm, 'a');
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(demo.projects.some((p) => p.id === from.id)).toBe(false));
    expect(demo.workflows.some((w) => w.name === 'In old')).toBe(false);
  });

  it('Cancel closes the dialog and deletes nothing', async () => {
    const { demo, from } = setup();
    const { user, dialog } = await openDialog(from.id);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(demo.projects.some((p) => p.id === from.id)).toBe(true);
  });
});
