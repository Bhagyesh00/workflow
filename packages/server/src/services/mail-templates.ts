/**
 * P6-17 (L1): the ten mail templates as plain functions with HTML escaping (invite, password reset, email
 * change requested and completed, API key revoked, MCP client revoked, workflow, credential and project
 * shared, first production failure). A `UM_EMAIL_TEMPLATES_*` file (config `mail.templates`) replaces its
 * template; its `{{ value }}` placeholders are filled escaped. Texts say "workspace".
 */
import { readFile } from 'node:fs/promises';
import type { MailConfig, MailTemplateName } from '../config';

/** a rendered mail */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/** the largest override file read (a template is a page of HTML) */
const MAX_TEMPLATE_BYTES = 256 * 1024;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** HTML text and attribute escaping for every value that reaches a mail */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPES[ch] ?? ch);
}

/** a header value is one line */
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

type Values = Record<string, string>;

interface Builtin {
  subject: (v: Values) => string;
  /** the paragraphs, then an optional button (`link`) */
  heading: (v: Values) => string;
  lines: (v: Values) => string[];
  action?: { label: string; url: string };
}

const v = (values: Values, key: string): string => values[key] ?? '';

const BUILTIN: Record<MailTemplateName, Builtin> = {
  invite: {
    subject: (x) => `${v(x, 'inviterName')} invited you to ${v(x, 'workspaceName')}`,
    heading: () => 'You have been invited',
    lines: (x) => [
      `${v(x, 'inviterName')} invited you to join the workspace ${v(x, 'workspaceName')} as ${v(x, 'role')}.`,
    ],
    action: { label: 'Accept the invitation', url: 'inviteUrl' },
  },
  passwordReset: {
    subject: () => 'Reset your password',
    heading: () => 'Reset your password',
    lines: (x) => [
      `Hi ${v(x, 'name')}, we got a request to reset your password.`,
      `The link works for ${v(x, 'expiresInMinutes')} minutes and once. If you did not ask for it, ignore this mail.`,
    ],
    action: { label: 'Choose a new password', url: 'resetUrl' },
  },
  emailChangeRequested: {
    subject: () => 'Confirm your new email address',
    heading: () => 'Confirm your new email address',
    lines: (x) => [
      `Hi ${v(x, 'name')}, someone asked to change the email of this account to ${v(x, 'newEmail')}.`,
      'If it was you, confirm it with the button. If not, ignore this mail and nothing changes.',
    ],
    action: { label: 'Confirm the change', url: 'confirmUrl' },
  },
  emailChangeCompleted: {
    subject: () => 'Your email address was changed',
    heading: () => 'Your email address was changed',
    lines: (x) => [
      `Hi ${v(x, 'name')}, the email of your account is now ${v(x, 'newEmail')}.`,
      'If you did not do this, tell an owner of your workspace at once.',
    ],
  },
  apiKeyRevoked: {
    subject: (x) => `Your API key was revoked in ${v(x, 'workspaceName')}`,
    heading: () => 'An API key was revoked',
    lines: (x) => [
      `Your API key "${v(x, 'keyLabel')}" in the workspace ${v(x, 'workspaceName')} was revoked by ${v(x, 'revokedBy')}.`,
      'Calls that use it now fail. Create a new key if you still need one.',
    ],
  },
  mcpClientRevoked: {
    subject: (x) => `Your MCP client was disconnected in ${v(x, 'workspaceName')}`,
    heading: () => 'An MCP client was disconnected',
    lines: (x) => [
      `The access of the MCP client "${v(x, 'clientName')}" in the workspace ${v(x, 'workspaceName')} was revoked by ${v(x, 'revokedBy')}.`,
      'The client must ask for your consent again before it can connect.',
    ],
  },
  workflowShared: {
    subject: (x) => `${v(x, 'actorName')} shared the workflow "${v(x, 'workflowName')}" with you`,
    heading: () => 'A workflow was shared with you',
    lines: (x) => [
      `${v(x, 'actorName')} shared the workflow "${v(x, 'workflowName')}" with you in the workspace ${v(x, 'workspaceName')}.`,
    ],
    action: { label: 'Open the workflow', url: 'workflowUrl' },
  },
  credentialShared: {
    subject: (x) => `${v(x, 'actorName')} shared the credential "${v(x, 'credentialName')}" with you`,
    heading: () => 'A credential was shared with you',
    lines: (x) => [
      `${v(x, 'actorName')} shared the credential "${v(x, 'credentialName')}" with you in the workspace ${v(x, 'workspaceName')}.`,
    ],
    action: { label: 'Open your credentials', url: 'credentialsUrl' },
  },
  projectShared: {
    subject: (x) => `${v(x, 'actorName')} added you to the project "${v(x, 'projectName')}"`,
    heading: () => 'You were added to a project',
    lines: (x) => [
      `${v(x, 'actorName')} added you to the project "${v(x, 'projectName')}" in the workspace ${v(x, 'workspaceName')} as ${v(x, 'role')}.`,
    ],
    action: { label: 'Open the project', url: 'projectUrl' },
  },
  workflowFailure: {
    subject: (x) => `The first production run of "${v(x, 'workflowName')}" failed`,
    heading: () => 'A production run failed',
    lines: (x) => [
      `A production run of the workflow "${v(x, 'workflowName')}" in the workspace ${v(x, 'workspaceName')} failed. This is the first failure of the workspace, so this is the only mail of this kind.`,
      'Set an error workflow in the workflow settings to be told about every failure.',
    ],
    action: { label: 'Open the workflow', url: 'workflowUrl' },
  },
};

function htmlOf(builtin: Builtin, values: Values): string {
  const lines = builtin.lines(values).map((l) => `<p>${escapeHtml(l)}</p>`);
  const action = builtin.action
    ? `<p><a href="${escapeHtml(v(values, builtin.action.url))}">${escapeHtml(builtin.action.label)}</a></p>`
    : '';
  return `<div><h2>${escapeHtml(builtin.heading(values))}</h2>${lines.join('')}${action}</div>`;
}

function textOf(builtin: Builtin, values: Values): string {
  const parts = [builtin.heading(values), ...builtin.lines(values)];
  if (builtin.action) parts.push(`${builtin.action.label}: ${v(values, builtin.action.url)}`);
  return parts.join('\n\n');
}

/** tags go, then the few entities the escaper writes come back, for the text part of an override file */
function stripTags(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** the override file, or undefined when it is not set, too large or unreadable (the built-in then serves) */
async function readOverride(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const buffer = await readFile(path);
    if (buffer.length > MAX_TEMPLATE_BYTES) return undefined;
    return buffer.toString('utf8');
  } catch {
    return undefined;
  }
}

/** the template `name` filled with `values` (each escaped), from the override file when one is set */
export async function renderMail(
  name: MailTemplateName,
  values: Record<string, string>,
  templates: MailConfig['templates'],
): Promise<RenderedMail> {
  const builtin = BUILTIN[name];
  const subject = oneLine(builtin.subject(values));
  const override = await readOverride(templates[name]);
  if (override === undefined) {
    return { subject, html: htmlOf(builtin, values), text: textOf(builtin, values) };
  }
  // `{{ key }}` takes the escaped value; a key the mail does not carry is empty, and the value is never
  // read as a template again (one pass)
  const html = override.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) =>
    escapeHtml(Object.hasOwn(values, key) ? (values[key] ?? '') : ''),
  );
  return { subject, html, text: stripTags(html) };
}
