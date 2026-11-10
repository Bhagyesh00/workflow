/**
 * P6-17 (L1): the ten mail templates as plain functions with HTML escaping (invite, password reset, email
 * change requested and completed, API key revoked, MCP client revoked, workflow, credential and project
 * shared, first production failure). A `UM_EMAIL_TEMPLATES_*` file (config `mail.templates`) replaces its
 * template; its `{{ value }}` placeholders are filled escaped. Texts say "workspace".
 * Stub from C0: `renderMail` throws until L1.
 */
import type { MailConfig, MailTemplateName } from '../config';

/** a rendered mail */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/** the template `name` filled with `values` (each escaped), from the override file when one is set */
export async function renderMail(
  _name: MailTemplateName,
  _values: Record<string, string>,
  _templates: MailConfig['templates'],
): Promise<RenderedMail> {
  throw new Error('not implemented (L1)');
}
