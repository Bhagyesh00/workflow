/**
 * P6-62 (S5 C0 stub, L6 fills it): the sentry destination type: Sentry envelopes to the DSN's store, through `deps.http` (no SDK).
 * `createSentrySender` never throws (the manager's constructor registers it); its sender's `send` throws until L6.
 */
import type { DestinationFactory, DestinationSender } from '../types';

export const createSentrySender: DestinationFactory = (_deps, _destination): DestinationSender => ({
  async send() {
    throw new Error('not implemented (L6)');
  },
});

/** null when the settings are valid, else the 400 text. PASSES until L6: every settings object is valid. */
export function validateSentrySettings(_settings: unknown): string | null {
  return null; // stub (L6)
}
