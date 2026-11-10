/**
 * P6-13: the Members page's Invite button: disabled while SSO or workspace role provisioning manages
 * members, with the tooltip text as `reason`.
 */
export interface InviteGate {
  disabled: boolean;
  reason?: string;
}

export function useInviteGate(): InviteGate {
  // stub (L11)
  return { disabled: false };
}
