/** Wait amounts and dates, and the Limit Wait Time parameters that Wait and Form share. */
import { type ExecuteContext, NodeOperationError, type NodeProperty } from '@workflow/workflow';
import { parseDate } from '../../utils/filter';

/** "wait forever" for resumes without a time limit */
export const WAIT_INDEFINITELY = new Date('3000-01-01T00:00:00.000Z');

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export function intervalMs(ctx: ExecuteContext, amountParam: string, unitParam: string): number {
  const amount = Number(ctx.getNodeParameter(amountParam, 0, 1));
  const unit = ctx.getNodeParameter(unitParam, 0, 'seconds') as string;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new NodeOperationError(ctx.getNode(), 'The wait amount must be a positive number', {
      parameter: amountParam,
    });
  }
  return amount * (UNIT_MS[unit] ?? 1000);
}

export function waitDate(ctx: ExecuteContext, param: string): Date {
  const value = ctx.getNodeParameter(param, 0, '');
  const date = parseDate(value, true, ctx.getTimezone());
  if (!date?.isValid) {
    throw new NodeOperationError(ctx.getNode(), `"${String(value)}" is not a valid date`, {
      parameter: param,
    });
  }
  return date.toJSDate();
}

export const timeUnitOptions = [
  { name: 'Seconds', value: 'seconds' },
  { name: 'Minutes', value: 'minutes' },
  { name: 'Hours', value: 'hours' },
  { name: 'Days', value: 'days' },
];

/** the Limit Wait Time parameters; `show` adds what must hold for all of them to appear */
export function limitWaitProperties(show: Record<string, unknown[]> = {}): NodeProperty[] {
  const limited = { ...show, limitWaitTime: [true] };
  const afterInterval = { ...limited, limitType: ['afterTimeInterval'] };
  return [
    {
      displayName: 'Limit Wait Time',
      name: 'limitWaitTime',
      type: 'boolean',
      default: false,
      description: 'Whether the workflow resumes automatically after a time limit without a call',
      ...(Object.keys(show).length ? { displayOptions: { show } } : {}),
    },
    {
      displayName: 'Limit Type',
      name: 'limitType',
      type: 'options',
      default: 'afterTimeInterval',
      displayOptions: { show: limited },
      options: [
        { name: 'After Time Interval', value: 'afterTimeInterval' },
        { name: 'At Specified Time', value: 'atSpecifiedTime' },
      ],
    },
    {
      displayName: 'Amount',
      name: 'resumeAmount',
      type: 'number',
      default: 1,
      typeOptions: { minValue: 0, numberPrecision: 2 },
      displayOptions: { show: afterInterval },
    },
    {
      displayName: 'Unit',
      name: 'resumeUnit',
      type: 'options',
      default: 'hours',
      options: timeUnitOptions,
      displayOptions: { show: afterInterval },
    },
    {
      displayName: 'Max Date and Time',
      name: 'maxDateAndTime',
      type: 'dateTime',
      default: '',
      displayOptions: { show: { ...limited, limitType: ['atSpecifiedTime'] } },
    },
  ];
}

/** when a wait with these parameters ends by itself */
export function limitedWaitUntil(ctx: ExecuteContext): Date {
  if (!ctx.getNodeParameter('limitWaitTime', 0, false)) return WAIT_INDEFINITELY;
  if (ctx.getNodeParameter('limitType', 0, 'afterTimeInterval') === 'atSpecifiedTime') {
    return waitDate(ctx, 'maxDateAndTime');
  }
  return new Date(Date.now() + intervalMs(ctx, 'resumeAmount', 'resumeUnit'));
}
