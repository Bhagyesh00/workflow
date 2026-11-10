/**
 * The sections of Settings > Security, in order (one slot list; pages/SecuritySettingsPage.tsx renders them).
 * n8n's order: S2 adds MFA first and S3 data redaction after it, each in its own C0; then personal space
 * (P6-33, L12) and workflow reviews (P3-19). Each section gates itself.
 */
import type { ComponentType } from 'react';
import { MfaEnforcementSection } from './MfaEnforcementSection';
import { PersonalSpaceSection } from './PersonalSpaceSection';
import { WorkflowReviewsSection } from './WorkflowReviewsSection';

export interface SecuritySection {
  /** stable key */
  id: string;
  Component: ComponentType;
}

export const SECURITY_SECTIONS: readonly SecuritySection[] = [
  // P6-18 (L2)
  { id: 'mfa', Component: MfaEnforcementSection },
  { id: 'personal-space', Component: PersonalSpaceSection },
  { id: 'workflow-reviews', Component: WorkflowReviewsSection },
];
