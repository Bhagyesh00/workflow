/**
 * P6-58 (S5 C0 stub, L1 fills it): audit rows become `audit.*` events. `AUDIT_EVENT_MAP` maps an audit action to
 * its event name; `AUDIT_ONLY_ACTIONS` are actions that stay in the audit log with no event. The context installs
 * `handleAuditEntry` with `addAuditListener` (repositories/resources.ts).
 */
import type { ServiceDeps } from '../../context';
import type { AuditEntry } from '../../repositories/resources';

/** stub (L1): audit action -> event name (every target is in EVENT_CATALOG) */
export const AUDIT_EVENT_MAP: Readonly<Record<string, string>> = Object.freeze({});

/** stub (L1): audit actions that emit no event */
export const AUDIT_ONLY_ACTIONS: ReadonlySet<string> = new Set<string>();

/** stub (L1): PASSES: does nothing until L1 (called after every audit insert; must never throw) */
export function handleAuditEntry(_deps: ServiceDeps, _tenantId: string, _entry: AuditEntry): void {}
