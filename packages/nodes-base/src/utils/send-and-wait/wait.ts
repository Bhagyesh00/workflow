/**
 * The run side of "Send and Wait for Response": what the message holds, and putting the run to wait.
 * The links come from the run's signed resume URL, so nothing else is needed to tell who answers.
 */
import { type DataObject, type ExecuteContext, type Item, NodeOperationError } from '@workflow/workflow';
import { WAIT_INDEFINITELY } from '../../nodes/core/wait-limit';
import { parseDate } from '../filter';
import {
  DEFAULT_APPROVE_LABEL,
  DEFAULT_DECLINE_LABEL,
  DEFAULT_RESPOND_LABEL,
  SEND_AND_WAIT,
} from './descriptions';
import { customFormFields, type ResponseType, type SendAndWaitButton } from './pages';

export interface SendAndWaitMessage {
  message: string;
  responseType: ResponseType;
  /** the links of the message, one per button */
  buttons: SendAndWaitButton[];
}

const RESPONSE_TYPES = new Set<string>(['approval', 'freeText', 'customForm']);
const isResponseType = (value: string): value is ResponseType => RESPONSE_TYPES.has(value);

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const styleOf = (value: unknown, fallback: 'primary' | 'secondary'): 'primary' | 'secondary' =>
  value === 'primary' || value === 'secondary' ? value : fallback;

/** the run's resume URL, signed by the server; the answers come back through it */
function resumeUrl(ctx: ExecuteContext): string {
  const url = ctx.evaluateExpression('={{ $execution.resumeUrl }}', 0);
  if (typeof url !== 'string' || !url) {
    throw new NodeOperationError(ctx.getNode(), 'This run has no URL to wait for an answer on');
  }
  return url;
}

const withQuery = (url: string, name: string, value: string): string => {
  const link = new URL(url);
  link.searchParams.set(name, value);
  return link.toString();
};

/** the message and its buttons; throws before anything is sent when the settings cannot work */
export function planMessage(ctx: ExecuteContext): SendAndWaitMessage {
  const message = String(ctx.getNodeParameter('message', 0, '') ?? '');
  if (!message.trim()) throw new NodeOperationError(ctx.getNode(), 'The message is empty');
  const responseType = String(ctx.getNodeParameter('responseType', 0, 'approval'));
  if (!isResponseType(responseType)) {
    throw new NodeOperationError(ctx.getNode(), `"${responseType}" is not a response type`);
  }
  const url = resumeUrl(ctx);

  if (responseType === 'approval') {
    const approval = (ctx.getNodeParameter('approvalOptions', 0, {}) as { values?: DataObject }).values ?? {};
    const buttons: SendAndWaitButton[] = [
      {
        label: text(approval.approveLabel, DEFAULT_APPROVE_LABEL),
        url: withQuery(url, 'approved', 'true'),
        style: styleOf(approval.buttonApprovalStyle, 'primary'),
      },
    ];
    if (approval.approvalType === 'double') {
      buttons.push({
        label: text(approval.disapproveLabel, DEFAULT_DECLINE_LABEL),
        url: withQuery(url, 'approved', 'false'),
        style: styleOf(approval.buttonDisapprovalStyle, 'secondary'),
      });
    }
    return { message, responseType, buttons };
  }

  // the form is checked now, so a broken one does not send a message nobody can answer
  if (responseType === 'customForm') customFormFields(ctx);
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  return {
    message,
    responseType,
    buttons: [{ label: text(options.messageButtonLabel, DEFAULT_RESPOND_LABEL), url, style: 'primary' }],
  };
}

/** when the run goes on by itself: the Limit Wait Time option, or never */
export function resumeLimit(ctx: ExecuteContext): Date {
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const limit = (options.limitWaitTime as { values?: DataObject } | undefined)?.values;
  if (!limit) return WAIT_INDEFINITELY;
  if (limit.limitType === 'atSpecifiedTime') {
    const date = parseDate(limit.maxDateAndTime, true, ctx.getTimezone());
    if (!date?.isValid) {
      throw new NodeOperationError(ctx.getNode(), `"${String(limit.maxDateAndTime)}" is not a valid date`);
    }
    return date.toJSDate();
  }
  const amount = Number(limit.resumeAmount ?? 45);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new NodeOperationError(ctx.getNode(), 'The wait amount must be a positive number');
  }
  return new Date(Date.now() + amount * (UNIT_MS[String(limit.resumeUnit ?? 'minutes')] ?? 60_000));
}

/**
 * Sends the message of the first item through `deliver`, then waits for the answer. The answer
 * becomes the output of the node when the run resumes.
 */
export async function sendAndWait(
  ctx: ExecuteContext,
  deliver: (message: SendAndWaitMessage) => Promise<void>,
): Promise<Item[][]> {
  if (ctx.getNodeParameter('operation', 0, '') !== SEND_AND_WAIT) {
    throw new NodeOperationError(ctx.getNode(), 'This is not a send and wait operation');
  }
  const message = planMessage(ctx);
  const until = resumeLimit(ctx);
  await deliver(message);
  await ctx.putExecutionToWait(until);
  return [ctx.getInputData()];
}
