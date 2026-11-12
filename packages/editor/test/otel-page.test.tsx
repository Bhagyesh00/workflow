/**
 * P6-68 (L12): Settings > OpenTelemetry on the demo backend: the status and enable control, the connection block,
 * saving, the test trace with its result text, header values that come back blank, the unsaved-changes dialog
 * and a member who sees no link and fetches nothing. Header values here are fixed fakes.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };
const FAKE_VALUE = 'fake-header-value-1';
const SAVED_HINT = 'Saved, leave blank to keep';

type Answer = { data?: any; error?: { code: string; message: string } };

async function call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as Answer };
}

async function stored() {
  return (await call('GET', '/otel/settings')).body.data;
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

describe('Settings > OpenTelemetry', () => {
  it('shows the status off and the defaults, and the enable control saves the new state', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    expect(await screen.findByRole('heading', { name: 'OpenTelemetry' }, T)).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(field('Service name').value).toBe('workflow');
    expect(field('Traces path').value).toBe('/v1/traces');
    expect(saveButton().disabled).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'Enable OpenTelemetry' }));
    expect(saveButton().disabled).toBe(false);
    expect(screen.getByText('Enabled')).toBeTruthy();
    // nothing is stored until Save
    expect((await stored()).enabled).toBe(false);
    await user.click(saveButton());
    await waitFor(async () => expect((await stored()).enabled).toBe(true), T);
    await waitFor(() => expect(saveButton().disabled).toBe(true), T);
  });

  it('saves the connection block and the sampling and span options', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    await screen.findByRole('heading', { name: 'OpenTelemetry' }, T);
    await user.type(field('Endpoint'), 'http://collector.example.test:4318');
    await user.clear(field('Service name'));
    await user.type(field('Service name'), 'orders');
    await user.clear(field('Timeout (ms)'));
    await user.type(field('Timeout (ms)'), '3500');
    await user.clear(field('Sampling rate'));
    await user.type(field('Sampling rate'), '0.25');
    await user.click(screen.getByRole('checkbox', { name: 'Include node spans' }));
    await user.click(screen.getByRole('checkbox', { name: 'Emit node start spans' }));
    await user.click(screen.getByRole('checkbox', { name: 'Production executions only' }));
    await user.click(saveButton());
    await waitFor(async () => expect((await stored()).exporterServiceName).toBe('orders'), T);
    expect(await stored()).toMatchObject({
      exporterProtocol: 'http/protobuf',
      exporterEndpoint: 'http://collector.example.test:4318',
      startupConnectivityTimeoutMs: 3500,
      tracesSampleRate: 0.25,
      includeNodeSpans: false,
      emitNodeStartSpan: true,
      productionExecutionsOnly: false,
    });
  });

  it('shows the result text of a test trace, success and failure', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    await screen.findByRole('heading', { name: 'OpenTelemetry' }, T);
    await user.type(field('Endpoint'), 'http://collector.example.test:4318');
    await user.click(screen.getByRole('button', { name: 'Send test trace' }));
    expect(await screen.findByText('Test trace delivered.', {}, T)).toBeTruthy();
    // the test sends what is on the page and saves nothing
    expect((await stored()).exporterEndpoint).toBe('');
    await user.clear(field('Endpoint'));
    await user.type(field('Endpoint'), 'http://down.invalid:4318');
    await user.click(screen.getByRole('button', { name: 'Send test trace' }));
    expect(await screen.findByText(/Test failed: Could not reach down\.invalid/, {}, T)).toBeTruthy();
    expect(screen.queryByText('Test trace delivered.')).toBeNull();
  });

  it('adds and removes header rows; a saved value shows blank and a blank value keeps it', async () => {
    signedIn();
    await call('PUT', '/otel/settings', {
      ...(await stored()),
      exporterEndpoint: 'https://collector.example.test',
      exporterHeaders: `x-token=${FAKE_VALUE},x-team=blue`,
    });
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    await screen.findByRole('heading', { name: 'OpenTelemetry' }, T);
    expect(field('Header name 1').value).toBe('x-token');
    expect(field('Header value 1').value).toBe('');
    expect(field('Header value 1').placeholder).toBe(SAVED_HINT);
    expect(document.body.textContent).not.toContain(FAKE_VALUE);
    // remove the second row, add a new one with a value
    await user.click(screen.getByRole('button', { name: 'Remove header x-team' }));
    await user.click(screen.getByRole('button', { name: 'Add header' }));
    await user.type(field('Header name 2'), 'x-env');
    await user.type(field('Header value 2'), 'prod');
    await user.click(saveButton());
    await waitFor(async () => expect((await stored()).exporterHeaders).toBe('x-token=,x-env='), T);
    // after the save both values are blank again
    await waitFor(() => expect(field('Header value 2').placeholder).toBe(SAVED_HINT), T);
    expect(field('Header value 2').value).toBe('');
    expect(JSON.stringify(await stored())).not.toContain(FAKE_VALUE);
  });

  it('shows the server text when headers are saved with an http:// endpoint', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    await screen.findByRole('heading', { name: 'OpenTelemetry' }, T);
    await user.type(field('Endpoint'), 'http://collector.example.test:4318');
    await user.click(screen.getByRole('button', { name: 'Add header' }));
    await user.type(field('Header name 1'), 'x-token');
    await user.type(field('Header value 1'), FAKE_VALUE);
    expect(screen.getByText(/only sent over https/i)).toBeTruthy();
    await user.click(saveButton());
    expect(await screen.findByText('Could not save the OpenTelemetry settings', {}, T)).toBeTruthy();
    expect((await stored()).exporterHeaders).toBe('');
  });

  it('asks before leaving with unsaved changes: Stay keeps the edit, Leave without saving drops it', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    await screen.findByRole('heading', { name: 'OpenTelemetry' }, T);
    await user.type(field('Service name'), '-edge');
    await user.click(screen.getByRole('link', { name: 'Members' }));
    const dialog = await screen.findByRole('dialog', {}, T);
    expect(within(dialog).getByText('Save changes before leaving?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), T);
    expect(field('Service name').value).toBe('workflow-edge');
    await user.click(screen.getByRole('link', { name: 'Members' }));
    await user.click(await screen.findByRole('button', { name: 'Leave without saving' }, T));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'OpenTelemetry' })).toBeNull(), T);
    expect((await stored()).exporterServiceName).toBe('workflow');
  });

  it('Save and leave stores the edit and then leaves', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    await screen.findByRole('heading', { name: 'OpenTelemetry' }, T);
    await user.type(field('Service name'), '-edge');
    await user.click(screen.getByRole('link', { name: 'Members' }));
    await user.click(await screen.findByRole('button', { name: 'Save and leave' }, T));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'OpenTelemetry' })).toBeNull(), T);
    expect((await stored()).exporterServiceName).toBe('workflow-edge');
  });

  it('a clean page leaves with no dialog', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/opentelemetry');
    await screen.findByRole('heading', { name: 'OpenTelemetry' }, T);
    await user.click(screen.getByRole('link', { name: 'Members' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'OpenTelemetry' })).toBeNull(), T);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a member sees no link, a Callout, and the server refuses the settings', async () => {
    signedIn().setDemoRole('member');
    renderApp('/settings/opentelemetry');
    expect(await screen.findByText('Only admins can manage OpenTelemetry.', {}, T)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'OpenTelemetry' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Enable OpenTelemetry' })).toBeNull();
    expect((await call('GET', '/otel/settings')).status).toBe(403);
  });
});
