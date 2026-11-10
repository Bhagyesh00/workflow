/**
 * P6-53 (L8): Settings > Security, the workspace redaction floor (off, production, all). Gates itself
 * on `securitySettings:manage`, as WorkflowReviewsSection.
 */
import type { ReactNode } from 'react';
import { usePermissions } from '../../lib/permissions';

/** stub (L8): renders nothing until L8 draws it; the gate is final */
export function DataRedactionSection(): ReactNode {
  const { can } = usePermissions();
  if (!can('securitySettings:manage')) return null;
  return null;
}
