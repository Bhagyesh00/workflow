/** P6-65 (S5 C0 stub, L9 fills it): one test span with the given settings, for the settings page's test button. */
import type { OtelTestResult } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { EffectiveOtelSettings } from './settings';

/** stub (L9): `{ success, error }`, the error text redacted */
export function sendTestTrace(_deps: ServiceDeps, _settings: EffectiveOtelSettings): Promise<OtelTestResult> {
  throw new Error('not implemented (L9)');
}
