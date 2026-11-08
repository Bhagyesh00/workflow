/**
 * P5-65: a browser notification when a builder turn ends while the tab is hidden (L2's `send` calls
 * `notifyBuilderDone` at the end of every turn), and the once-only permission question the banner asks.
 */

/** set once the person has been asked (or declined), so the banner never asks twice */
export const BUILDER_NOTIFY_ASKED_KEY = 'wf.builder.notifications-asked';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

/** localStorage can be blocked or throw (private window, cleared site data): then the banner shows each load */
export function notificationsAsked(): boolean {
  try {
    return window.localStorage.getItem(BUILDER_NOTIFY_ASKED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberNotificationsAsked(): void {
  try {
    window.localStorage.setItem(BUILDER_NOTIFY_ASKED_KEY, '1');
  } catch {
    // nothing to remember into: the banner may show again next time
  }
}

/** asks the browser once and remembers that it was asked; true when the person allowed notifications */
export async function askNotificationPermission(): Promise<boolean> {
  rememberNotificationsAsked();
  if (!notificationsSupported()) return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export function notifyBuilderDone(): void {
  if (!notificationsSupported() || typeof document === 'undefined') return;
  if (document.visibilityState !== 'hidden') return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification('AI builder', { body: 'Your workflow is ready to review.' });
  } catch {
    // some browsers refuse the constructor (mobile): the turn result is still in the panel
  }
}
