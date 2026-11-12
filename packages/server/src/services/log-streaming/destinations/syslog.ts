/**
 * P6-61 (S5 C0 stub, L5 fills it): the syslog destination type: RFC 5424 lines over UDP, TCP or TLS, every socket through `resolveAllowedHost`.
 * `createSyslogSender` never throws (the manager's constructor registers it); its sender's `send` throws until L5.
 */
import type { DestinationFactory, DestinationSender } from '../types';

export const createSyslogSender: DestinationFactory = (_deps, _destination): DestinationSender => ({
  async send() {
    throw new Error('not implemented (L5)');
  },
});

/** null when the settings are valid, else the 400 text. PASSES until L5: every settings object is valid. */
export function validateSyslogSettings(_settings: unknown): string | null {
  return null; // stub (L5)
}
