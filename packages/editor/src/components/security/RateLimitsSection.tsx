/**
 * P6-83 (L15): Settings > Security, the public API rate limits. Gates itself on
 * `securitySettings:manage`, as WorkflowReviewsSection.
 */
import type { ReactNode } from 'react';
import { usePermissions } from '../../lib/permissions';

/** stub (L15): renders nothing until L15 draws it; the gate is final */
export function RateLimitsSection(): ReactNode {
  const { can } = usePermissions();
  if (!can('securitySettings:manage')) return null;
  return null;
}
