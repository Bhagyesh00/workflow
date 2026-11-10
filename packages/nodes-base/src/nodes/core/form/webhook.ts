/**
 * The hooks of the form nodes: GET shows a page, POST turns the answers into an item. The Form Trigger
 * starts a run with it; the Form and Wait nodes resume theirs.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  isExpression,
  NodeOperationError,
  type WebhookContext,
  type WebhookResponse,
  type WebhookResponseData,
} from '@workflow/workflow';
import { DateTime } from 'luxon';
import { loadConnectPanel } from '../../../utils/connect-panel';
import { checkBasicAuth, ipAllowed, isIgnoredBot, WWW_AUTHENTICATE } from './access';
import {
  FORM_DEFAULT_BUTTON_LABEL,
  FORM_DEFAULT_SUBMITTED_TEXT,
  type FormField,
  parseFormFields,
} from './fields';
import {
  type FormEndingFile,
  type FormPageField,
  renderCompletionPage,
  renderFormPage,
  renderMessagePage,
} from './render';
import { safeRedirectUrl, sanitizeHtml } from './sanitize';
import { checkFormUserAuth, type FormUserAuthParams } from './user-auth';

export const FORM_TRIGGER_TYPE = 'core.formTrigger';

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
const PROBLEM_LOADING = 'Problem loading form';
const FINISHED_TITLE = 'Form Submitted';

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

/** an HTML parameter: its own `{{ }}` resolved once from its text; a `=` one is resolved as it is read */
function htmlParameter(ctx: WebhookContext, name: string): string {
  const raw = ctx.getNodeParameter(name, 0, '', { rawExpressions: true });
  if (typeof raw === 'string' && !raw.startsWith('=')) return resolveOnce(ctx, raw);
  return String(ctx.getNodeParameter(name, 0, '') ?? '');
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
export function prefilled(field: FormField, query: DataObject): FormPageField {
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

interface FormAccess {
  /** the reply instead of the form */
  denied?: WebhookResponseData;
  authToken?: string;
  replyHeaders: Record<string, string>;
  user?: DataObject;
  /** the signed-in user's id (user auth): the run starts as them, whether or not Include User is on (P6-87) */
  userId?: string;
}

async function checkAccess(
  ctx: WebhookContext,
  authentication: string,
  isPage: boolean,
  userAuth: FormUserAuthParams,
): Promise<FormAccess> {
  if (authentication === 'basicAuth') {
    const auth = await checkBasicAuth(ctx, { allowToken: !isPage });
    if (!auth.allowed) return { denied: unauthorized('Authorization is required!'), replyHeaders: {} };
    return { authToken: auth.token, replyHeaders: {} };
  }
  if (authentication !== 'n8nUserAuth') return { replyHeaders: {} };
  const auth = await checkFormUserAuth(ctx, userAuth);
  if (!auth.allowed) {
    const { response } = auth;
    return {
      replyHeaders: {},
      denied: {
        webhookResponse: {
          statusCode: response?.statusCode ?? 403,
          body: response?.body,
          headers: { ...auth.headers, ...response?.headers },
        },
      },
    };
  }
  return {
    replyHeaders: auth.headers,
    authToken: tokenOfCookie(auth.headers['set-cookie']),
    user: auth.user ? { ...auth.user } : undefined,
    userId: auth.user?.id,
  };
}

/** a page or an answer that says what is wrong with the workflow; the run stays as it is */
function refused(
  isPage: boolean,
  statusCode: number,
  message: string,
  description: string,
  headers: Record<string, string> = {},
): WebhookResponseData {
  if (isPage) {
    const page = renderMessagePage({ title: PROBLEM_LOADING, message, detail: description });
    return { webhookResponse: htmlReply(statusCode, page, headers) };
  }
  return { webhookResponse: { statusCode, headers, body: { message, description } } };
}

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
  const access = await checkAccess(ctx, authentication, isPage, {
    scope: 'trigger',
    requireExecuteAccess: Boolean(ctx.getNodeParameter('requireExecuteAccess', 0, false)),
  });
  if (access.denied) return access.denied;
  const { authToken, replyHeaders } = access;
  const user = options.includeUserInOutput !== false ? access.user : undefined;

  if (ctx.getChildNodes().some((child) => child.type === RESPOND_TO_WEBHOOK)) {
    return refused(isPage, 409, RESPOND_TO_WEBHOOK_TEXT, RESPOND_TO_WEBHOOK_DESCRIPTION, replyHeaders);
  }

  const query = { ...ctx.getQueryData() };
  if (authentication === 'n8nUserAuth') delete query[USER_AUTH_CODE];
  const fields = formFields(ctx);
  const ending = completion(options);

  if (isPage) {
    // P6-87: a signed-in visitor sees which private accounts the run needs and which they have connected
    const connectPanel =
      authentication === 'n8nUserAuth' && access.userId
        ? await loadConnectPanel(ctx, access.userId, ctx.getRequestObject().url?.split('?')[0] ?? '')
        : undefined;
    const page = renderFormPage({
      title: String(ctx.getNodeParameter('formTitle', 0, '')),
      description: String(ctx.getNodeParameter('formDescription', 0, '')),
      fields: fields.map((field) => prefilled(field, query)),
      buttonLabel: String(options.buttonLabel || FORM_DEFAULT_BUTTON_LABEL),
      connectPanel,
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
    // P6-87: the person the sign-in identified, also with Include User off
    ...(access.userId ? { triggerUserId: access.userId } : {}),
    webhookResponse: {
      statusCode: 200,
      headers: replyHeaders,
      body: ending.redirectUrl
        ? { redirectURL: ending.redirectUrl }
        : { formSubmittedText: ending.submittedText },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// later pages
// ---------------------------------------------------------------------------------------------

/**
 * A page node is waiting: tells the editor where its form is. `sendNext` also answers the request
 * that holds the previous page; the server turns the 307 into `{ redirectURL }` for that page.
 */
export function announceFormPage(ctx: ExecuteContext, sendNext: boolean): void {
  const url = ctx.evaluateExpression('={{ $execution.resumeFormUrl }}', 0);
  if (typeof url !== 'string' || !url) return;
  ctx.setMetadata({ resumeFormUrl: url });
  if (sendNext) ctx.sendResponse({ statusCode: 307, headers: { location: url } });
}

/** the raw parameters of the Form Trigger this page comes after */
function triggerParameters(ctx: WebhookContext): DataObject | undefined {
  const trigger = ctx.getParentNodes().find((node) => node.type === FORM_TRIGGER_TYPE);
  if (!trigger) return undefined;
  const expression = `={{ $(${JSON.stringify(trigger.name)}).params }}`;
  return ctx.evaluateExpression(expression, 0) as DataObject;
}

const optionsOf = (parameters: DataObject | undefined) => (parameters?.options ?? {}) as DataObject;

/** a parameter of the trigger, resolved once from its own text */
function triggerText(ctx: WebhookContext, value: unknown): string {
  if (isExpression(value)) return String(ctx.evaluateExpression(value, 0) ?? '');
  return value === undefined || value === null ? '' : String(value);
}

/** a raw parameter of the trigger as the trigger's own page reads it; `whenFailed` if its expression fails */
function triggerValue(ctx: WebhookContext, value: unknown, whenFailed: unknown): unknown {
  if (!isExpression(value)) return value;
  try {
    return ctx.evaluateExpression(value, 0);
  } catch {
    return whenFailed;
  }
}

/** Include User in Output of the trigger; a later page that cannot tell leaves the user out */
const includesUser = (ctx: WebhookContext, trigger: DataObject | undefined) =>
  triggerValue(ctx, optionsOf(trigger).includeUserInOutput, false) !== false;

/** a later page keeps the access of the trigger, with the cookie of this execution */
function triggerAccess(ctx: WebhookContext, trigger: DataObject | undefined, isPage: boolean) {
  return checkAccess(ctx, String(trigger?.authentication ?? 'none'), isPage, {
    scope: 'waiting',
    // a failed expression asks for the permission rather than letting everyone in
    requireExecuteAccess: Boolean(triggerValue(ctx, trigger?.requireExecuteAccess, true)),
  });
}

/** what a later page prefills from and its answers go with */
const pageQuery = (ctx: WebhookContext, trigger: DataObject | undefined) => {
  const query = { ...ctx.getQueryData() };
  if (trigger?.authentication === 'n8nUserAuth') delete query[USER_AUTH_CODE];
  return query;
};

function pageFields(ctx: WebhookContext): FormField[] {
  if (ctx.getNodeParameter('defineForm', 0, 'fields') !== 'json') return formFields(ctx);
  // a value in the definition is data, its HTML is not read for `{{ }}`
  const fields = parseFormFields(ctx.getNodeParameter('jsonOutput', 0, '[]'));
  if (!fields) throw new NodeOperationError(ctx.getNode(), 'The form fields JSON is not valid');
  return fields;
}

const inputItems = (ctx: WebhookContext): Item[] =>
  JSON.parse(JSON.stringify(ctx.evaluateExpression('={{ $input.all() }}', 0) ?? []));

async function endingFiles(ctx: WebhookContext, items: Item[]): Promise<FormEndingFile[]> {
  const files: FormEndingFile[] = [];
  const names = String(ctx.getNodeParameter('inputDataFieldName', 0, 'data'))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    const found = items.flatMap((item) => (item.binary?.[name] ? [item.binary[name]] : []));
    if (!found.length) {
      throw new NodeOperationError(ctx.getNode(), `No binary data property "${name}" was found`);
    }
    for (const binary of found) {
      files.push({
        fileName: binary.fileName || name,
        mimeType: binary.mimeType,
        data: Buffer.from(await ctx.getBinaryBuffer(binary)).toString('base64'),
      });
    }
  }
  return files;
}

/** the Form node's ending: GET shows it, and its script's one POST lets the run finish */
async function endingWebhook(
  ctx: WebhookContext,
  trigger: DataObject | undefined,
  access: FormAccess,
  isPage: boolean,
): Promise<WebhookResponseData> {
  const items = inputItems(ctx);
  if (!isPage) {
    return {
      workflowData: [items],
      webhookResponse: { statusCode: 200, headers: access.replyHeaders },
    };
  }
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const respondWith = String(ctx.getNodeParameter('respondWith', 0, 'text'));
  const redirectUrl =
    respondWith === 'redirect'
      ? safeRedirectUrl(String(ctx.getNodeParameter('redirectUrl', 0, '')))
      : undefined;
  const noUrl = respondWith === 'redirect' && !redirectUrl;
  const page = renderCompletionPage({
    pageTitle: String(options.formTitle || triggerText(ctx, trigger?.formTitle) || FINISHED_TITLE),
    title: noUrl ? FINISHED_TITLE : String(ctx.getNodeParameter('completionTitle', 0, '') || FINISHED_TITLE),
    message: noUrl ? FORM_DEFAULT_SUBMITTED_TEXT : String(ctx.getNodeParameter('completionMessage', 0, '')),
    html: respondWith === 'showText' ? htmlParameter(ctx, 'responseText') : undefined,
    redirectUrl,
    files: respondWith === 'returnBinary' ? await endingFiles(ctx, items) : undefined,
    customCss: options.customCss ? String(options.customCss) : undefined,
    attribution: (options.appendAttribution ?? optionsOf(trigger).appendAttribution) !== false,
    authToken: access.authToken,
  });
  return { webhookResponse: htmlReply(200, page, access.replyHeaders) };
}

/** the Form node's `webhook()` */
export async function formNodeWebhook(ctx: WebhookContext): Promise<WebhookResponseData> {
  const isPage = ctx.getRequestObject().method !== 'POST';
  const trigger = triggerParameters(ctx);
  const access = await triggerAccess(ctx, trigger, isPage);
  if (access.denied) return access.denied;
  if (ctx.getNodeParameter('operation', 0, 'page') === 'completion') {
    return endingWebhook(ctx, trigger, access, isPage);
  }

  const triggerOptions = optionsOf(trigger);
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const query = pageQuery(ctx, trigger);
  const fields = pageFields(ctx);

  if (isPage) {
    const page = renderFormPage({
      title: String(options.formTitle || triggerText(ctx, trigger?.formTitle)),
      description: String(options.formDescription ?? ''),
      fields: fields.map((field) => prefilled(field, query)),
      buttonLabel: String(
        options.buttonLabel || triggerText(ctx, triggerOptions.buttonLabel) || FORM_DEFAULT_BUTTON_LABEL,
      ),
      customCss: options.customCss ? String(options.customCss) : undefined,
      testMode: ctx.getMode() === 'manual',
      attribution: triggerOptions.appendAttribution !== false,
      authToken: access.authToken,
      submittedText: FORM_DEFAULT_SUBMITTED_TEXT,
    });
    return { webhookResponse: htmlReply(200, page, access.replyHeaders) };
  }

  const item = await outputItem(
    ctx,
    fields,
    { useWorkflowTimezone: triggerOptions.useWorkflowTimezone } as DataObject,
    query,
  );
  if (access.user && includesUser(ctx, trigger)) item.json.user = access.user;
  return {
    workflowData: [[item]],
    webhookResponse: { statusCode: 200, headers: access.replyHeaders },
  };
}

/** Respond When and the Respond to Webhook nodes after this Wait have to agree (n8n's texts) */
function responseModeProblem(ctx: WebhookContext, isPage: boolean): WebhookResponseData | undefined {
  const usesNode = ctx.getNodeParameter('responseMode', 0, 'onReceived') === 'responseNode';
  const hasNode = ctx.getChildNodes().some((child) => child.type === RESPOND_TO_WEBHOOK);
  if (usesNode && !hasNode) {
    return refused(
      isPage,
      500,
      'No Respond to Webhook node found in the workflow',
      'Insert a Respond to Webhook node to your workflow to respond to the form submission or choose another option for the "Respond When" parameter.',
    );
  }
  if (!usesNode && hasNode) {
    return refused(
      isPage,
      500,
      `${ctx.getNode().name} node not correctly configured`,
      'Set the "Respond When" parameter to "Using Respond to Webhook Node" or remove the Respond to Webhook node',
    );
  }
  return undefined;
}

/** the Wait node's `webhook()` for "On Form Submitted" */
export async function waitFormWebhook(ctx: WebhookContext): Promise<WebhookResponseData> {
  const isPage = ctx.getRequestObject().method !== 'POST';
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  if (options.ignoreBots && isIgnoredBot(ctx)) return unauthorized();

  const trigger = triggerParameters(ctx);
  const own = String(ctx.getNodeParameter('authentication', 0, 'none'));
  const access =
    own === 'none'
      ? await triggerAccess(ctx, trigger, isPage)
      : await checkAccess(ctx, own, isPage, { scope: 'waiting', requireExecuteAccess: false });
  if (access.denied) return access.denied;

  const problem = responseModeProblem(ctx, isPage);
  if (problem) return problem;

  const query = pageQuery(ctx, trigger);
  const fields = formFields(ctx);
  const ending = completion(options);

  if (isPage) {
    const page = renderFormPage({
      title: String(ctx.getNodeParameter('formTitle', 0, '')),
      description: String(ctx.getNodeParameter('formDescription', 0, '')),
      fields: fields.map((field) => prefilled(field, query)),
      buttonLabel: FORM_DEFAULT_BUTTON_LABEL,
      testMode: ctx.getMode() === 'manual',
      attribution: options.appendAttribution !== false,
      authToken: access.authToken,
      ...ending,
    });
    return { webhookResponse: htmlReply(200, page, access.replyHeaders) };
  }

  const item = await outputItem(ctx, fields, options, query);
  if (access.user && includesUser(ctx, trigger)) item.json.user = access.user;
  return {
    workflowData: [[item]],
    webhookResponse: {
      statusCode: 200,
      headers: access.replyHeaders,
      body: ending.redirectUrl
        ? { redirectURL: ending.redirectUrl }
        : { formSubmittedText: ending.submittedText },
    },
  };
}
