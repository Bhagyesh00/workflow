/**
 * P6-17 (L1): the workspace mailer. `EMAIL_MODE=smtp` with a host makes it configured (`features.mail`);
 * the transport is nodes-base `createSmtpTransport` on `ctx.http`'s guard, so a private SMTP host is
 * refused unless `SSRF_ALLOW` names it. Each `send*` renders its template (services/mail-templates.ts,
 * overridden by `UM_EMAIL_TEMPLATES_*`) and answers `{ sent }`; a log line holds the recipient, never a link.
 * Stub from C0: `isConfigured` PASSES (false, so nothing sends and no answer changes); the sends throw
 * until L1.
 */
import type { ServiceDeps } from '../context';

/** what every send answers: false when mail is not set up (the caller then shows the link itself) */
export interface MailResult {
  sent: boolean;
}

export interface InviteMailData {
  workspaceName: string;
  inviterName: string;
  role: string;
  inviteUrl: string;
}

export interface PasswordResetMailData {
  name: string;
  resetUrl: string;
  /** minutes until the link stops working (20) */
  expiresInMinutes: number;
}

export interface EmailChangeRequestedMailData {
  name: string;
  newEmail: string;
  confirmUrl: string;
}

export interface EmailChangeCompletedMailData {
  name: string;
  newEmail: string;
}

export interface ApiKeyRevokedMailData {
  workspaceName: string;
  keyLabel: string;
  revokedBy: string;
}

export interface McpClientRevokedMailData {
  workspaceName: string;
  clientName: string;
  revokedBy: string;
}

export interface WorkflowSharedMailData {
  workspaceName: string;
  actorName: string;
  workflowName: string;
  workflowUrl: string;
}

export interface CredentialSharedMailData {
  workspaceName: string;
  actorName: string;
  credentialName: string;
  credentialsUrl: string;
}

export interface ProjectSharedMailData {
  workspaceName: string;
  actorName: string;
  projectName: string;
  role: string;
  projectUrl: string;
}

export interface FirstProductionFailureMailData {
  workspaceName: string;
  workflowName: string;
  workflowUrl: string;
}

export class Mailer {
  constructor(readonly deps: ServiceDeps) {}

  /** mail is set up (`EMAIL_MODE=smtp` and `SMTP_HOST`); stub (L1) PASSES: false */
  isConfigured(): boolean {
    return false;
  }

  async sendInvite(_to: string, _data: InviteMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendPasswordReset(_to: string, _data: PasswordResetMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendEmailChangeRequested(_to: string, _data: EmailChangeRequestedMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendEmailChangeCompleted(_to: string, _data: EmailChangeCompletedMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendApiKeyRevoked(_to: string, _data: ApiKeyRevokedMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendMcpClientRevoked(_to: string, _data: McpClientRevokedMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendWorkflowShared(_to: string, _data: WorkflowSharedMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendCredentialShared(_to: string, _data: CredentialSharedMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendProjectShared(_to: string, _data: ProjectSharedMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }

  async sendFirstProductionFailure(_to: string, _data: FirstProductionFailureMailData): Promise<MailResult> {
    throw new Error('not implemented (L1)');
  }
}
