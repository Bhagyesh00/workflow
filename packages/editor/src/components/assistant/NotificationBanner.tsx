/** P5-65: asks once for permission to notify when a builder turn ends while the tab is hidden. */
import { useState } from 'react';
import {
  askNotificationPermission,
  notificationsAsked,
  notificationsSupported,
  rememberNotificationsAsked,
} from '../../features/builder/notify';
import { Button } from '../ui/Button';

export function NotificationBanner() {
  const [visible, setVisible] = useState(
    () => notificationsSupported() && Notification.permission === 'default' && !notificationsAsked(),
  );
  if (!visible) return null;
  return (
    <div
      className="flex items-center gap-2 border-b border-line bg-brand-soft px-3 py-2 text-xs text-ink-2"
      role="status"
    >
      <span className="min-w-0 flex-1">
        Get a notification when the builder finishes while this tab is hidden.
      </span>
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          setVisible(false);
          void askNotificationPermission();
        }}
      >
        Allow
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          rememberNotificationsAsked();
          setVisible(false);
        }}
      >
        Not now
      </Button>
    </div>
  );
}
