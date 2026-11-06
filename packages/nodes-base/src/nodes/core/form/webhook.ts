/** The Form Trigger's two hooks: GET shows the form, POST turns the answers into the run's first item. */
import type {
  DataObject,
  Item,
  WebhookContext,
  WebhookResponse,
  WebhookResponseData,
} from '@workflow/workflow';
import { DateTime } from 'luxon';
import { checkBasicAuth, ipAllowed, isIgnoredBot, WWW_AUTHENTICATE } from './access';
import { FORM_DEFAULT_BUTTON_LABEL, FORM_DEFAULT_SUBMITTED_TEXT, type FormField } from './fields';
import { type FormPageField, renderFormPage, renderMessagePage } from './render';
import { safeRedirectUrl, sanitizeHtml } from './sanitize';
import { checkFormUserAuth } from './user-auth';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

/** never in the `headers` output */
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-auth-token']);
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** the sign-in's one-time code: never a prefill, never output */
const USER_AUTH_CODE = 'code';
const RESPOND_TO_WEBHOOK = 'core.respondToWebhook';
const RESPOND_TO_WEBHOOK_TEXT =
  'The "Respond to Webhook" node is not supported in workflows initiated by the "Form Trigger"';
const RESPOND_TO_WEBHOOK_DESCRIPTION =
  'To configure your response, add a "Form" node and set the "Page Type" to "Form Ending"';

const htmlReply = (
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): WebhookResponse => ({
  statusCode,
  headers: { ...HTML_HEADERS, ...headers },
  body,
});

const unauthorized = (body?: string): WebhookResponseData => ({
  webhookResponse: {
    statusCode: 401,
    headers: {
      'www-authenticate': WWW_AUTHENTICATE,
      ...(body ? { 'content-type': 'text/plain; charset=utf-8' } : {}),
    },
    body,
  },
});

const fieldsOf = (values: unknown) => (Array.isArray(values) ? (values as FormField[]) : []);

const firstString = (value: unknown): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === null ? undefined : String(first);
};

/**
 * Each `{{ }}` of a parameter text, resolved once by the expression engine, which keeps the text
 * around it as it is and does not read what comes back. A text that cannot be resolved stays as written.
 */
function resolveOnce(ctx: WebhookContext, text: string): string {
  if (!text.includes('{{')) return text;
  try {
    const value = ctx.evaluateExpression(`=${text}`, 0);
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return text;
  }
}

/**
 * The Form Elements with HTML fields ready to sanitize. A plain HTML parameter gets its `{{ }}`
 * resolved here, from the node's own text; a `=` one was resolved when it was read and is never
 * read again, whatever it now holds.
 */
function formFields(ctx: WebhookContext): FormField[] {
  const fields = fieldsOf(ctx.getNodeParameter('formFields.values', 0, []));
  const raw = fieldsOf(ctx.getNodeParameter('formFields.values', 0, [], { rawExpressions: true }));
  return fields.map((field, index) => {
    if (field.fieldType !== 'html') return field;
    const text = raw[index]?.html;
    const isPlainText = typeof text === 'string' && !text.startsWith('=');
    return { ...field, html: isPlainText ? resolveOnce(ctx, text) : String(field.html ?? '') };
  });
}

const outputKey = (field: FormField) => String(field.fieldName || field.fieldLabel || '');

/** what a field holds when the page opens: the query wins over the default */
function prefilled(field: FormField, query: DataObject): FormPageField {
  const type = field.fieldType ?? 'text';
  if (type === 'password' || type === 'file' || type === 'html') return field;
  const key = outputKey(field);
  const fromQuery = key && Object.hasOwn(query, key) ? firstString(query[key]) : undefined;
  const fallback = type === 'hiddenField' ? field.fieldValue : field.defaultValue;
  const value = fromQuery ?? (fallback === undefined || fallback === null ? '' : String(fallback));
  if (type !== 'checkbox') return { ...field, value };
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return { ...field, values };
}

function completion(options: DataObject): { submittedText: string; redirectUrl?: string } {
  const response = (options.respondWithOptions as { values?: DataObject } | undefined)?.values;
  const text = response?.formSubmittedText;
  const submittedText = typeof text === 'string' && text ? text : FORM_DEFAULT_SUBMITTED_TEXT;
  if (response?.respondWith !== 'redirect') return { submittedText };
  return { submittedText, redirectUrl: safeRedirectUrl(String(response.redirectUrl ?? '')) };
}

function asList(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.map(String);
  const text = String(value);
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* a plain answer that starts with a bracket */
    }
  }
  return [text];
}

function answerOf(field: FormField, value: unknown): unknown {
  switch (field.fieldType ?? 'text') {
    case 'checkbox':
      return asList(value);
    case 'radio':
      return asList(value)?.[0] ?? null;
    case 'number': {
      const text = firstString(value);
      return text === undefined || text === '' ? null : Number(text);
    }
    case 'text':
    case 'email':
      return firstString(value)?.trim() ?? null;
    default:
      return firstString(value) ?? null;
  }
}

const submittedAt = (ctx: WebhookContext, useWorkflowTimezone: boolean) => {
  if (!useWorkflowTimezone) return new Date().toISOString();
  const now = DateTime.now().setZone(ctx.getTimezone());
  return now.isValid ? now.toISO() : new Date().toISOString();
};

async function outputItem(
  ctx: WebhookContext,
  fields: FormField[],
  options: DataObject,
  query: DataObject,
): Promise<Item> {
  const request = ctx.getRequestObject();
  const body = ctx.getBodyData();
  const json: DataObject = {};
  const binary: NonNullable<Item['binary']> = {};
  for (const [index, field] of fields.entries()) {
    const name = `field-${index}`;
    if (field.fieldType === 'html') {
      if (field.elementName && !BLOCKED_KEYS.has(field.elementName)) {
        json[field.elementName] = sanitizeHtml(field.html ?? '');
      }
      continue;
    }
    const key = outputKey(field);
    if (!key || BLOCKED_KEYS.has(key)) continue;
    if (field.fieldType === 'file') {
      // an empty file input still sends a nameless part
      const files = (request.files ?? []).filter(
        (file) => file.fieldName === name && (file.fileName || file.data.length),
      );
      if (!files.length) {
        json[key] = null;
        continue;
      }
      const property = key.replace(/\W/g, () => '_');
      const stored = [];
      for (const [position, file] of files.entries()) {
        const binaryName = files.length > 1 ? `${property}_${position}` : property;
        binary[binaryName] = await ctx.helpers.prepareBinaryData(file.data, file.fileName, file.mimeType);
        stored.push({ filename: file.fileName, mimetype: file.mimeType, size: file.data.length });
      }
      json[key] = stored;
      continue;
    }
    json[key] = (Object.hasOwn(body, name) ? answerOf(field, body[name]) : null) as DataObject[string];
  }
  json.submittedAt = submittedAt(ctx, options.useWorkflowTimezone !== false);
  json.formMode = ctx.getMode() === 'manual' ? 'test' : 'production';
  if (options.showHeaders) {
    json.headers = Object.fromEntries(
      Object.entries(ctx.getHeaderData()).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())),
    ) as DataObject;
  }
  if (Object.keys(query).length) json.formQueryParameters = query;
  return Object.keys(binary).length ? { json, binary } : { json };
}

/** the sign-in's cookie holds the same token the page sends as `x-auth-token` */
const tokenOfCookie = (cookie: string | undefined) =>
  cookie ? /^ncb-form-auth-(?:wf|ex)-[^=;]+=([^;]+)/.exec(cookie)?.[1] : undefined;

/** the Form Trigger's `webhook()` */
export async function formTriggerWebhook(ctx: WebhookContext): Promise<WebhookResponseData> {
  const isPage = ctx.getRequestObject().method !== 'POST';
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;

  if (!ipAllowed(ctx.getRequestObject().ip, String(options.ipWhitelist ?? ''))) {
    return {
      webhookResponse: {
        statusCode: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'IP is not allowed to access this form!',
      },
    };
  }
  if (options.ignoreBots && isIgnoredBot(ctx)) return unauthorized();

  const authentication = String(ctx.getNodeParameter('authentication', 0, 'none'));
  let authToken: string | undefined;
  let replyHeaders: Record<string, string> = {};
  let user: DataObject | undefined;
  if (authentication === 'basicAuth') {
    const auth = await checkBasicAuth(ctx, { allowToken: !isPage });
    if (!auth.allowed) return unauthorized('Authorization is required!');
    authToken = auth.token;
  } else if (authentication === 'n8nUserAuth') {
    const auth = await checkFormUserAuth(ctx, {
      scope: 'trigger',
      requireExecuteAccess: Boolean(ctx.getNodeParameter('requireExecuteAccess', 0, false)),
    });
    if (!auth.allowed) {
      const { response } = auth;
      return {
        webhookResponse: {
          statusCode: response?.statusCode ?? 403,
          body: response?.body,
          headers: { ...auth.headers, ...response?.headers },
        },
      };
    }
    replyHeaders = auth.headers;
    authToken = tokenOfCookie(auth.headers['set-cookie']);
    if (auth.user && options.includeUserInOutput !== false) user = { ...auth.user };
  }

  if (ctx.getChildNodes().some((child) => child.type === RESPOND_TO_WEBHOOK)) {
    if (isPage) {
      const page = renderMessagePage({
        title: 'Problem loading form',
        message: RESPOND_TO_WEBHOOK_TEXT,
        detail: RESPOND_TO_WEBHOOK_DESCRIPTION,
      });
      return { webhookResponse: htmlReply(409, page, replyHeaders) };
    }
    return {
      webhookResponse: {
        statusCode: 409,
        headers: replyHeaders,
        body: { message: RESPOND_TO_WEBHOOK_TEXT, description: RESPOND_TO_WEBHOOK_DESCRIPTION },
      },
    };
  }

  const query = { ...ctx.getQueryData() };
  if (authentication === 'n8nUserAuth') delete query[USER_AUTH_CODE];
  const fields = formFields(ctx);
  const ending = completion(options);

  if (isPage) {
    const page = renderFormPage({
      title: String(ctx.getNodeParameter('formTitle', 0, '')),
      description: String(ctx.getNodeParameter('formDescription', 0, '')),
      fields: fields.map((field) => prefilled(field, query)),
      buttonLabel: String(options.buttonLabel || FORM_DEFAULT_BUTTON_LABEL),
      customCss: options.customCss ? String(options.customCss) : undefined,
      testMode: ctx.getMode() === 'manual',
      attribution: options.appendAttribution !== false,
      authToken,
      ...ending,
    });
    return { webhookResponse: htmlReply(200, page, replyHeaders) };
  }

  const item = await outputItem(ctx, fields, options, query);
  if (user) item.json.user = user;
  return {
    workflowData: [[item]],
    webhookResponse: {
      statusCode: 200,
      headers: replyHeaders,
      body: ending.redirectUrl
        ? { redirectURL: ending.redirectUrl }
        : { formSubmittedText: ending.submittedText },
    },
  };
}
