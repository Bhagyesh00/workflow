/**
 * P6-15: the credential modal's private (per user) part: the type choice (OAuth types,
 * `credential:createEndUser`, not in a personal project), the caller's connect and disconnect, the
 * connected count.
 */
export interface PrivateCredentialSectionProps {
  /** the saved credential (null until the first save) */
  credentialId: string | null;
  /** the credential type's name */
  typeName: string;
  /** an OAuth1 or OAuth2 type (only those can be private) */
  isOAuth: boolean;
}

export function PrivateCredentialSection(_props: PrivateCredentialSectionProps) {
  // stub (L14)
  return null;
}
