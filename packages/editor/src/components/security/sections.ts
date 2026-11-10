/**
 * The sections of Settings > Security, in order (one slot list; pages/SecuritySettingsPage.tsx renders them).
 * n8n's order: S2 adds MFA first and S3 data redaction after it, each in its own C0; then personal space
 * (P6-33, L12), workflow reviews (P3-19) and, last, the public API rate limits (S3). Each section gates
 * itself.
 */
import type { ComponentType } from 'react';
import { DataRedactionSection } from './DataRedactionSection';
import { MfaEnforcementSection } from './MfaEnforcementSection';
import { PersonalSpaceSection } from './PersonalSpaceSection';
import { RateLimitsSection } from './RateLimitsSection';
import { WorkflowReviewsSection } from './WorkflowReviewsSection';

export interface SecuritySection {
  /** stable key */
  id: string;
  Component: ComponentType;
}

export const SECURITY_SECTIONS: readonly SecuritySection[] = [
  // P6-18 (L2)
  { id: 'mfa', Component: MfaEnforcementSection },
  // P6-53 (L8)
  { id: 'data-redaction', Component: DataRedactionSection },
  { id: 'personal-space', Component: PersonalSpaceSection },
  { id: 'workflow-reviews', Component: WorkflowReviewsSection },
  // P6-83 (L15)
  { id: 'rate-limits', Component: RateLimitsSection },
];
