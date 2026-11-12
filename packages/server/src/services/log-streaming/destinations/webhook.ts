/**
 * P6-60 (S5 C0 stub, L4 fills it): the webhook destination type: an HTTP request per event (n8n's webhook destination), through `deps.http`.
 * `createWebhookSender` never throws (the manager's constructor registers it); its sender's `send` throws until L4.
 */
import type { DestinationFactory, DestinationSender } from '../types';

export const createWebhookSender: DestinationFactory = (_deps, _destination): DestinationSender => ({
  async send() {
    throw new Error('not implemented (L4)');
  },
});

/** null when the settings are valid, else the 400 text. PASSES until L4: every settings object is valid. */
export function validateWebhookSettings(_settings: unknown): string | null {
  return null; // stub (L4)
}
