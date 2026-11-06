/** Scope picker of the API key form. Stub: L7 (P4-18) writes it; shows nothing until then. */
export interface ApiKeyScopesFieldProps {
  /** the picked scopes; empty means every scope */
  value: string[];
  onChange(next: string[]): void;
  disabled?: boolean;
}

export function ApiKeyScopesField(_props: ApiKeyScopesFieldProps) {
  return null;
}
