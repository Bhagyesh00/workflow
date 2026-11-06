/**
 * The answer: the resume URL of the waiting run opens a page (GET) and takes the answer (GET with
 * `approved`, or POST). The server has checked the signature of the URL before this runs.
 */
import type {
  DataObject,
  Item,
  WebhookContext,
  WebhookResponse,
  WebhookResponseData,
} from '@workflow/workflow';
import { headerValue } from '../../nodes/core/form/access';
import type { FormField } from '../../nodes/core/form/fields';
import { isBotUserAgent } from '../bots';
import { SEND_AND_WAIT } from './descriptions';
import { customFormFields, FREE_TEXT_FIELD, messagePage, RECORDED_TEXT, responsePage } from './pages';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const htmlReply = (statusCode: number, body: string): WebhookResponse => ({
  statusCode,
  headers: HTML_HEADERS,
  body,
});

const pageReply = (statusCode: number, title: string, message: string): WebhookResponseData => ({
  webhookResponse: htmlReply(statusCode, messagePage(title, message)),
});

const problem = (statusCode: number, message: string): WebhookResponseData => ({
  webhookResponse: { statusCode, body: { message } },
});

const firstString = (value: unknown): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === null ? undefined : String(first);
};

function asList(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.map(String);
  const textValue = String(value);
  if (textValue.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(textValue);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* a plain answer that starts with a bracket */
    }
  }
  return [textValue];
}

function answerOf(field: FormField, value: unknown): unknown {
  switch (field.fieldType ?? 'text') {
    case 'checkbox':
      return asList(value);
    case 'radio':
      return asList(value)?.[0] ?? null;
    case 'number': {
      const textValue = firstString(value);
      return textValue === undefined || textValue === '' ? null : Number(textValue);
    }
    case 'text':
    case 'email':
      return firstString(value)?.trim() ?? null;
    default:
      return firstString(value) ?? null;
  }
}

const keyOf = (field: FormField) => String(field.fieldName || field.fieldLabel || '');
const isEmpty = (answer: unknown) =>
  answer === null || answer === undefined || answer === '' || (Array.isArray(answer) && !answer.length);

/** the answers of a Custom Form; a required element left empty is a refusal */
async function formAnswers(
  ctx: WebhookContext,
  fields: FormField[],
): Promise<{ data: DataObject; binary: NonNullable<Item['binary']> } | string> {
  const body = ctx.getBodyData();
  const request = ctx.getRequestObject();
  const data: DataObject = {};
  const binary: NonNullable<Item['binary']> = {};
  for (const [index, field] of fields.entries()) {
    const type = field.fieldType ?? 'text';
    if (type === 'html') continue;
    const key = keyOf(field);
    if (!key || BLOCKED_KEYS.has(key)) continue;
    const name = `field-${index}`;
    if (type === 'file') {
      // an empty file input still sends a nameless part
      const files = (request.files ?? []).filter(
        (file) => file.fieldName === name && (file.fileName || file.data.length),
      );
      if (field.requiredField && !files.length) return `${key} is required`;
      const stored = [];
      for (const [position, file] of files.entries()) {
        const property = key.replace(/\W/g, () => '_');
        const binaryName = files.length > 1 ? `${property}_${position}` : property;
        binary[binaryName] = await ctx.helpers.prepareBinaryData(file.data, file.fileName, file.mimeType);
        stored.push({ filename: file.fileName, mimetype: file.mimeType, size: file.data.length });
      }
      data[key] = files.length ? stored : null;
      continue;
    }
    const answer =
      type === 'hiddenField'
        ? (field.fieldValue ?? null)
        : Object.hasOwn(body, name)
          ? answerOf(field, body[name])
          : null;
    if (field.requiredField && type !== 'hiddenField' && isEmpty(answer)) return `${key} is required`;
    data[key] = answer as DataObject[string];
  }
  return { data, binary };
}

/** the `webhook()` of the nodes that offer Send and Wait for Response */
export async function sendAndWaitWebhook(ctx: WebhookContext): Promise<WebhookResponseData> {
  if (ctx.getNodeParameter('operation', 0, '') !== SEND_AND_WAIT) {
    return problem(404, 'This execution is not waiting for a response');
  }
  const method = ctx.getRequestObject().method;
  const isPost = method === 'POST';
  const responseType = String(ctx.getNodeParameter('responseType', 0, 'approval'));

  if (responseType === 'approval') {
    if (isPost) return pageReply(400, 'Response not taken', 'Use the buttons in the message to respond.');
    const approved = firstString(ctx.getQueryData().approved);
    if (approved !== 'true' && approved !== 'false') {
      return pageReply(400, 'Response not taken', 'This link is incomplete. Use the buttons in the message.');
    }
    // a mail scanner or a link preview opens the link without a person: it must not answer
    if (isBotUserAgent(headerValue(ctx, 'user-agent'))) {
      return pageReply(
        200,
        'Open this link in a browser',
        'The response is taken when a person opens the link.',
      );
    }
    return {
      workflowData: [[{ json: { data: { approved: approved === 'true' } } }]],
      webhookResponse: htmlReply(200, messagePage('Thank you', RECORDED_TEXT)),
    };
  }

  const isCustom = responseType === 'customForm';
  const fields = isCustom ? customFormFields(ctx) : [FREE_TEXT_FIELD];
  if (!isPost) {
    const page = responsePage({
      message: String(ctx.getNodeParameter('message', 0, '') ?? ''),
      fields,
      options: ctx.getNodeParameter('options', 0, {}) as DataObject,
      testMode: false,
    });
    return { webhookResponse: htmlReply(200, page) };
  }

  const answered = { webhookResponse: { statusCode: 200, body: { formSubmittedText: RECORDED_TEXT } } };
  if (!isCustom) {
    const response = firstString(ctx.getBodyData()['field-0'])?.trim();
    if (!response) return problem(400, 'Response is required');
    return { workflowData: [[{ json: { data: { text: response } } }]], ...answered };
  }
  const result = await formAnswers(ctx, fields);
  if (typeof result === 'string') return problem(400, result);
  const item: Item = { json: { data: result.data } };
  if (Object.keys(result.binary).length) item.binary = result.binary;
  return { workflowData: [[item]], ...answered };
}
