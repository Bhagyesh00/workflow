/**
 * P6-17 (L1): the workspace mailer. `EMAIL_MODE=smtp` with a host makes it configured (`features.mail`);
 * the transport is nodes-base `createSmtpTransport` on `ctx.http`'s guard, so a private SMTP host is
 * refused unless `SSRF_ALLOW` names it. Each `send*` renders its template (services/mail-templates.ts,
 * overridden by `UM_EMAIL_TEMPLATES_*`) and answers `{ sent }`; a log line holds the recipient, never a link.
 * A send that fails throws an error whose text passes `redactSecrets`.
 */
import { createHash } from 'node:crypto';
import {
  GOOGLE_TOKEN_URL,
  googleJwtAssertion,
  jwtBearerRequest,
  parseAccessToken,
  sharedTokenCache,
} from '@workflow/core';
import { createSmtpTransport } from '@workflow/nodes-base';
import { redactSecrets } from '@workflow/workflow';
import type { MailTemplateName } from '../config';
import type { ServiceDeps } from '../context';
import { renderMail } from './mail-templates';

/** what Google's SMTP server accepts with a service account token */
const SMTP_OAUTH_SCOPE = 'https://mail.google.com/';

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

export interface MailerOptions {
  /** test seam: the token URL of the service account grant (default Google's) */
  tokenUrl?: string;
}

export class Mailer {
  private readonly tokenUrl: string;

  constructor(
    readonly deps: ServiceDeps,
    options: MailerOptions = {},
  ) {
    this.tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
  }

  /** mail is set up (`EMAIL_MODE=smtp` and `SMTP_HOST`) */
  isConfigured(): boolean {
    const { mail } = this.deps.config;
    return mail.mode === 'smtp' && mail.smtp.host.trim() !== '';
  }

  async sendInvite(to: string, data: InviteMailData): Promise<MailResult> {
    return this.send('invite', to, { ...data });
  }

  async sendPasswordReset(to: string, data: PasswordResetMailData): Promise<MailResult> {
    return this.send('passwordReset', to, { ...data, expiresInMinutes: String(data.expiresInMinutes) });
  }

  async sendEmailChangeRequested(to: string, data: EmailChangeRequestedMailData): Promise<MailResult> {
    return this.send('emailChangeRequested', to, { ...data });
  }

  async sendEmailChangeCompleted(to: string, data: EmailChangeCompletedMailData): Promise<MailResult> {
    return this.send('emailChangeCompleted', to, { ...data });
  }

  async sendApiKeyRevoked(to: string, data: ApiKeyRevokedMailData): Promise<MailResult> {
    return this.send('apiKeyRevoked', to, { ...data });
  }

  async sendMcpClientRevoked(to: string, data: McpClientRevokedMailData): Promise<MailResult> {
    return this.send('mcpClientRevoked', to, { ...data });
  }

  async sendWorkflowShared(to: string, data: WorkflowSharedMailData): Promise<MailResult> {
    return this.send('workflowShared', to, { ...data });
  }

  async sendCredentialShared(to: string, data: CredentialSharedMailData): Promise<MailResult> {
    return this.send('credentialShared', to, { ...data });
  }

  async sendProjectShared(to: string, data: ProjectSharedMailData): Promise<MailResult> {
    return this.send('projectShared', to, { ...data });
  }

  async sendFirstProductionFailure(to: string, data: FirstProductionFailureMailData): Promise<MailResult> {
    return this.send('workflowFailure', to, { ...data });
  }

  private async send(
    template: MailTemplateName,
    to: string,
    values: Record<string, string>,
  ): Promise<MailResult> {
    if (!this.isConfigured()) return { sent: false };
    const { config, logger } = this.deps;
    const { smtp, templates } = config.mail;
    const rendered = await renderMail(template, values, templates);
    // the log names the template and a short digest of the recipient: never the address or a link
    const recipient = createHash('sha256').update(to.trim().toLowerCase()).digest('hex').slice(0, 12);
    try {
      const transport = await createSmtpTransport(
        { helpers: { resolveAllowedHost: (host) => this.deps.context().http.resolveAllowedHost(host) } },
        {
          host: smtp.host,
          port: smtp.port,
          secure: smtp.ssl,
          disableStartTls: !smtp.startTls,
          user: smtp.user || undefined,
          password: smtp.pass || undefined,
          accessToken: await this.serviceAccountToken(),
        },
      );
      try {
        await transport.sendMail({
          from: smtp.sender || smtp.user || `no-reply@${hostOf(config.baseUrl)}`,
          to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
      } finally {
        transport.close();
      }
    } catch (error) {
      logger.warn({ template, recipient }, 'Mail could not be sent');
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`Couldn't send the mail: ${redactSecrets(reason)}`);
    }
    logger.info({ template, recipient }, 'Mail sent');
    return { sent: true };
  }

  /**
   * The service account's access token for the SMTP login (`SMTP_OAUTH_SERVICE_CLIENT` and
   * `SMTP_OAUTH_PRIVATE_KEY`), fetched on `ctx.http` so the SSRF guard covers the token call, and kept
   * until it nears its end. nodemailer gets it as `accessToken`: nodemailer's own service account fetch would skip
   * the guard.
   */
  private async serviceAccountToken(): Promise<string | undefined> {
    const { smtp } = this.deps.config.mail;
    if (!smtp.oauthServiceClient || !smtp.oauthPrivateKey) return undefined;
    const http = this.deps.context().http;
    const tokenUrl = this.tokenUrl;
    return sharedTokenCache.get(
      `${smtp.oauthServiceClient}:${smtp.user}:${smtp.oauthPrivateKey}`,
      `smtp:${tokenUrl}`,
      async () => {
        const assertion = googleJwtAssertion({
          email: smtp.oauthServiceClient,
          privateKey: smtp.oauthPrivateKey,
          scopes: [SMTP_OAUTH_SCOPE],
          tokenUrl,
          ...(smtp.user ? { subject: smtp.user } : {}),
        });
        const answer = (await http.request({
          ...jwtBearerRequest(assertion, tokenUrl),
          responseType: 'auto',
          returnFullResponse: true,
          ignoreHttpStatusErrors: true,
        })) as { body: unknown; statusCode: number };
        if (answer.statusCode < 200 || answer.statusCode >= 300) {
          throw new Error(`The mail token service answered ${answer.statusCode}`);
        }
        return parseAccessToken(answer.body);
      },
    );
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}
