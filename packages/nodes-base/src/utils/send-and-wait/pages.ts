/**
 * What the person sees: the buttons in the message, and the pages the buttons open. Every value
 * is escaped for the place it goes to; nothing from an answer is written into a page.
 */
import { type BaseContext, type DataObject, NodeOperationError } from '@workflow/workflow';
import { type FormField, parseFormFields } from '../../nodes/core/form/fields';
import { renderFormPage, renderMessagePage } from '../../nodes/core/form/render';
import { DEFAULT_SUBMIT_LABEL } from './descriptions';

export type ResponseType = 'approval' | 'freeText' | 'customForm';

export interface SendAndWaitButton {
  label: string;
  url: string;
  style: 'primary' | 'secondary';
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** text for an HTML body or attribute */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** a message as HTML: escaped, with its line breaks kept */
const messageAsHtml = (message: string): string =>
  message
    .split(/\r?\n/)
    .map((line) => escapeHtml(line))
    .join('<br>');

const BUTTON_STYLES = {
  primary: 'background:#5b4fd6;color:#ffffff;border:1px solid #5b4fd6',
  secondary: 'background:#ffffff;color:#5b4fd6;border:1px solid #5b4fd6',
} as const;

/** an email body: the message, then the buttons as links */
export function emailHtml(message: string, buttons: SendAndWaitButton[]): string {
  const links = buttons
    .map(
      (button) =>
        `<a href="${escapeHtml(button.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;${BUTTON_STYLES[button.style]}">${escapeHtml(button.label)}</a>`,
    )
    .join('');
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5"><p>${messageAsHtml(message)}</p><p>${links}</p></div>`;
}

/** the same for a reader without HTML */
export function emailText(message: string, buttons: SendAndWaitButton[]): string {
  return [message, ...buttons.map((button) => `${button.label}: ${button.url}`)].join('\n\n');
}

/** Slack reads these three characters as markup of its own */
const slackText = (text: string): string =>
  text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** Block Kit: the message, then one link button each */
export function slackBlocks(message: string, buttons: SendAndWaitButton[]): DataObject[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: slackText(message) } },
    {
      type: 'actions',
      elements: buttons.map((button) => ({
        type: 'button',
        text: { type: 'plain_text', text: button.label.slice(0, 75) },
        url: button.url,
        ...(button.style === 'primary' ? { style: 'primary' } : {}),
      })),
    },
  ];
}

/** Telegram: one row of link buttons under the message */
export function telegramKeyboard(buttons: SendAndWaitButton[]): DataObject {
  return { inline_keyboard: [buttons.map((button) => ({ text: button.label, url: button.url }))] };
}

// ---------------------------------------------------------------------------------------------
// pages

type ParameterContext = Pick<BaseContext, 'getNodeParameter' | 'getNode'>;

/** The Form Elements of a Custom Form, from the fields below or from JSON */
export function customFormFields(ctx: ParameterContext): FormField[] {
  const source = ctx.getNodeParameter('defineForm', 0, 'fields');
  let fields: FormField[] | undefined;
  if (source === 'json') {
    fields = parseFormFields(ctx.getNodeParameter('jsonOutput', 0, '[]'));
    if (!fields) throw new NodeOperationError(ctx.getNode(), 'The form fields JSON is not valid');
  } else {
    const values = (ctx.getNodeParameter('formFields', 0, {}) as { values?: unknown }).values;
    fields = Array.isArray(values) ? (values as FormField[]) : [];
  }
  if (!fields.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one form element to the custom form');
  }
  return fields;
}

export const FREE_TEXT_FIELD: FormField = {
  fieldType: 'textarea',
  fieldLabel: 'Response',
  requiredField: true,
};

export const RECORDED_TEXT = 'Your response has been recorded';
export const DEFAULT_PAGE_TITLE = 'Your response';

/** a page with no form: a refusal, or the word that the answer was taken */
export function messagePage(title: string, message: string): string {
  return renderMessagePage({ title, message });
}

export interface ResponsePageInput {
  message: string;
  fields: FormField[];
  options: DataObject;
  testMode: boolean;
}

/** the page of Free Text and Custom Form: the message on top, the elements below */
export function responsePage(input: ResponsePageInput): string {
  const { options } = input;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const extra = text(options.responseFormDescription);
  return renderFormPage({
    title: text(options.responseFormTitle) || DEFAULT_PAGE_TITLE,
    // the message is text, so it is escaped here; the description option may carry HTML
    description: `<p>${messageAsHtml(input.message)}</p>${extra}`,
    fields: input.fields,
    buttonLabel: text(options.responseFormButtonLabel) || DEFAULT_SUBMIT_LABEL,
    customCss: text(options.responseFormCustomCss) || undefined,
    testMode: input.testMode,
    attribution: false,
    submittedText: RECORDED_TEXT,
  });
}
