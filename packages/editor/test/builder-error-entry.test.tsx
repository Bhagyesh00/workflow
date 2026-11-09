/**
 * P5-65: "Fix with AI" on a node's error opens the builder with the node and its error (editors and above,
 * builder on), and a browser notification fires when a turn ends only while the tab is hidden.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExecutionErrorShape } from '@workflow/workflow';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../src/api/types';
import { NotificationBanner } from '../src/components/assistant/NotificationBanner';
import { ErrorPanel } from '../src/components/ndv/DataPanes';
import { builderErrorMessage } from '../src/features/builder/error-entry';
import { BUILDER_NOTIFY_ASKED_KEY, notifyBuilderDone } from '../src/features/builder/notify';
import { useBuilderStore } from '../src/stores/builder-store';
import { useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { withProviders } from './utils';

const ERROR: ExecutionErrorShape = {
  message: 'Request failed with status 404',
  node: 'Call API',
} as ExecutionErrorShape;

function serve(enabled = true) {
  server.use(
    http.get('/rest/settings', async () => {
      const res = await backend().handle({ method: 'GET', path: '/settings', query: {}, body: undefined });
      const settings = (res.body as { data: Settings }).data;
      return HttpResponse.json({
        data: { ...settings, features: { ...settings.features, aiBuilder: { enabled, setup: true } } },
      });
    }),
  );
}

function stubSend() {
  const send = vi.fn(async () => undefined);
  useBuilderStore.setState({ send });
  return send;
}

describe('Fix with AI (P5-65)', () => {
  beforeEach(() => {
    signedIn();
    useBuilderStore.getState().reset();
    useUiStore.getState().setSidePanel(null);
  });
  afterEach(() => {
    useBuilderStore.getState().reset();
  });

  it('opens the builder panel with the node and its error', async () => {
    serve();
    const send = stubSend();
    withProviders(<ErrorPanel error={ERROR} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /Fix with AI/ }));
    expect(useBuilderStore.getState().open).toBe(true);
    expect(useUiStore.getState().sidePanel).toBe('builder');
    expect(send).toHaveBeenCalledWith(
      `I'm getting an error on the node "Call API": Request failed with status 404`,
    );
  });

  it('keeps a very long error inside the prompt limit', () => {
    expect(builderErrorMessage('A', 'x'.repeat(9000)).length).toBeLessThan(1100);
  });

  it('is hidden for a viewer', async () => {
    backend().setDemoRole('viewer');
    serve();
    withProviders(<ErrorPanel error={ERROR} />);
    await screen.findByTestId('node-error');
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('button', { name: /Fix with AI/ })).toBeNull();
  });

  it('is hidden when AI is off', async () => {
    serve(false);
    withProviders(<ErrorPanel error={ERROR} />);
    await screen.findByTestId('node-error');
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('button', { name: /Fix with AI/ })).toBeNull();
  });
});

describe('builder notification (P5-65)', () => {
  const made: string[] = [];
  let visibility = 'hidden';
  let permission = 'granted';
  let requestPermission = vi.fn(async () => 'granted');

  beforeEach(() => {
    made.length = 0;
    visibility = 'hidden';
    permission = 'granted';
    requestPermission = vi.fn(async () => 'granted');
    class FakeNotification {
      static get permission() {
        return permission;
      }
      static requestPermission = (...a: []) => requestPermission(...a);
      constructor(title: string) {
        made.push(title);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibility as DocumentVisibilityState,
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('notifies only when the tab is hidden and permission is granted', () => {
    notifyBuilderDone();
    expect(made).toHaveLength(1);
    visibility = 'visible';
    notifyBuilderDone();
    expect(made).toHaveLength(1);
    visibility = 'hidden';
    permission = 'denied';
    notifyBuilderDone();
    expect(made).toHaveLength(1);
  });

  it('the banner asks once and remembers', async () => {
    permission = 'default';
    const user = userEvent.setup();
    const first = withProviders(<NotificationBanner />);
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(BUILDER_NOTIFY_ASKED_KEY)).toBe('1');
    expect(screen.queryByRole('status')).toBeNull();
    first.unmount();
    withProviders(<NotificationBanner />);
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('"Not now" is remembered too, and a blocked localStorage does not break the banner', async () => {
    permission = 'default';
    const user = userEvent.setup();
    withProviders(<NotificationBanner />);
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(BUILDER_NOTIFY_ASKED_KEY)).toBe('1');
    window.localStorage.clear();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { unmount } = withProviders(<NotificationBanner />);
    await user.click(screen.getAllByRole('button', { name: 'Not now' })[0]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull());
    unmount();
  });
});
