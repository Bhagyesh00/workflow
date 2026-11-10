/**
 * The credential readiness gate of identity triggers (P6-87): before a run that a known user
 * starts, every private credential the trigger reaches must have that user's own connection.
 * When one is missing the trigger answers 428 with `credentialConnectionsRequiredBody`.
 */

export const CREDENTIAL_CONNECTIONS_REQUIRED = 'credential_connections_required';

export interface CredentialConnectionStatus {
  credentialId: string;
  credentialName: string;
  credentialType: string;
  status: 'configured' | 'missing';
}

export interface CredentialGateResult {
  /** true when every private credential the trigger reaches has the user's connection */
  readyToExecute: boolean;
  credentials: CredentialConnectionStatus[];
}

/** given to identity triggers through `WebhookContext.getCredentialGate` */
export interface CredentialGateHelper {
  /** the private credentials this trigger reaches and whether `userId` has connected each */
  check(userId: string): Promise<CredentialGateResult>;
  /** the page where the user connects or disconnects `credentialId`, then goes back to `returnTo` */
  connectPageUrl(credentialId: string, action: 'connect' | 'disconnect', returnTo: string): string;
}

export interface CredentialConnectionsRequiredBody {
  status: typeof CREDENTIAL_CONNECTIONS_REQUIRED;
  readyToExecute: false;
  credentials: Array<{
    credentialId: string;
    credentialName: string;
    credentialType: string;
    credentialStatus: 'configured' | 'missing';
  }>;
}

/**
 * The body of the 428 answer when a run is not ready. It holds no URL: the form page is the
 * author's to script, so the page builds its own connect links.
 */
export function credentialConnectionsRequiredBody(
  result: CredentialGateResult,
): CredentialConnectionsRequiredBody {
  return {
    status: CREDENTIAL_CONNECTIONS_REQUIRED,
    readyToExecute: false,
    credentials: result.credentials.map((c) => ({
      credentialId: c.credentialId,
      credentialName: c.credentialName,
      credentialType: c.credentialType,
      credentialStatus: c.status,
    })),
  };
}
