import type { DataObject, NodeType, TriggerContext, TriggerResponse } from '@workflow/workflow';
import { DateTime } from 'luxon';

interface Rule {
  field: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'cronExpression';
  secondsInterval?: number;
  minutesInterval?: number;
  hoursInterval?: number;
  daysInterval?: number;
  weeksInterval?: number;
  monthsInterval?: number;
  triggerAtMinute?: number;
  triggerAtHour?: number;
  triggerAtDay?: number[];
  triggerAtDayOfMonth?: number;
  expression?: string;
}

/** Convert an interval rule to a 6-field cron expression (seconds first). */
export function ruleToCron(rule: Rule): string {
  const minute = rule.triggerAtMinute ?? 0;
  const hour = rule.triggerAtHour ?? 0;
  switch (rule.field) {
    case 'seconds':
      return `*/${Math.max(1, rule.secondsInterval ?? 30)} * * * * *`;
    case 'minutes':
      return `0 */${Math.max(1, rule.minutesInterval ?? 5)} * * * *`;
    case 'hours':
      return `0 ${minute} */${Math.max(1, rule.hoursInterval ?? 1)} * * *`;
    case 'days':
      return `0 ${minute} ${hour} */${Math.max(1, rule.daysInterval ?? 1)} * *`;
    case 'weeks': {
      const days = rule.triggerAtDay?.length ? rule.triggerAtDay.join(',') : '1';
      return `0 ${minute} ${hour} * * ${days}`;
    }
    case 'months':
      return `0 ${minute} ${hour} ${rule.triggerAtDayOfMonth ?? 1} */${Math.max(1, rule.monthsInterval ?? 1)} *`;
    case 'cronExpression':
      if (!rule.expression?.trim()) throw new Error('Cron expression is empty');
      return rule.expression.trim();
    default:
      throw new Error(`Unknown schedule rule "${String((rule as Rule).field)}"`);
  }
}

const hourOptions = Array.from({ length: 24 }, (_, h) => ({
  name: `${String(h).padStart(2, '0')}:00`,
  value: h,
}));

export const ScheduleTriggerNode: NodeType = {
  description: {
    name: 'core.scheduleTrigger',
    displayName: 'Schedule Trigger',
    description: 'Start the workflow on a schedule',
    icon: 'lucide:clock',
    group: ['trigger', 'schedule'],
    version: 1,
    defaults: { name: 'Schedule Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Core', 'Triggers'],
    alias: ['cron', 'interval', 'timer', 'every'],
    activationMessage: 'Your schedule trigger will now run on the defined schedule.',
    properties: [
      {
        displayName: 'Trigger Rules',
        name: 'rule',
        type: 'fixedCollection',
        default: { interval: [{ field: 'days' }] },
        typeOptions: { multipleValues: true, multipleValueButtonText: 'Add rule' },
        options: [
          {
            displayName: 'Trigger Interval',
            name: 'interval',
            values: [
              {
                displayName: 'Trigger Interval',
                name: 'field',
                type: 'options',
                default: 'days',
                options: [
                  { name: 'Seconds', value: 'seconds' },
                  { name: 'Minutes', value: 'minutes' },
                  { name: 'Hours', value: 'hours' },
                  { name: 'Days', value: 'days' },
                  { name: 'Weeks', value: 'weeks' },
                  { name: 'Months', value: 'months' },
                  { name: 'Custom (Cron)', value: 'cronExpression' },
                ],
              },
              {
                displayName: 'Seconds Between Triggers',
                name: 'secondsInterval',
                type: 'number',
                default: 30,
                typeOptions: { minValue: 1 },
                displayOptions: { show: { field: ['seconds'] } },
              },
              {
                displayName: 'Minutes Between Triggers',
                name: 'minutesInterval',
                type: 'number',
                default: 5,
                typeOptions: { minValue: 1 },
                displayOptions: { show: { field: ['minutes'] } },
              },
              {
                displayName: 'Hours Between Triggers',
                name: 'hoursInterval',
                type: 'number',
                default: 1,
                typeOptions: { minValue: 1 },
                displayOptions: { show: { field: ['hours'] } },
              },
              {
                displayName: 'Days Between Triggers',
                name: 'daysInterval',
                type: 'number',
                default: 1,
                typeOptions: { minValue: 1 },
                displayOptions: { show: { field: ['days'] } },
              },
              {
                displayName: 'Weeks Between Triggers',
                name: 'weeksInterval',
                type: 'number',
                default: 1,
                typeOptions: { minValue: 1 },
                displayOptions: { show: { field: ['weeks'] } },
              },
              {
                displayName: 'Trigger on Weekdays',
                name: 'triggerAtDay',
                type: 'multiOptions',
                default: [1],
                displayOptions: { show: { field: ['weeks'] } },
                options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                  (d, i) => ({
                    name: d,
                    value: i,
                  }),
                ),
              },
              {
                displayName: 'Months Between Triggers',
                name: 'monthsInterval',
                type: 'number',
                default: 1,
                typeOptions: { minValue: 1 },
                displayOptions: { show: { field: ['months'] } },
              },
              {
                displayName: 'Trigger at Day of Month',
                name: 'triggerAtDayOfMonth',
                type: 'number',
                default: 1,
                typeOptions: { minValue: 1, maxValue: 31 },
                displayOptions: { show: { field: ['months'] } },
              },
              {
                displayName: 'Trigger at Hour',
                name: 'triggerAtHour',
                type: 'options',
                default: 0,
                options: hourOptions,
                displayOptions: { show: { field: ['days', 'weeks', 'months'] } },
              },
              {
                displayName: 'Trigger at Minute',
                name: 'triggerAtMinute',
                type: 'number',
                default: 0,
                typeOptions: { minValue: 0, maxValue: 59 },
                displayOptions: { show: { field: ['hours', 'days', 'weeks', 'months'] } },
              },
              {
                displayName: 'Expression',
                name: 'expression',
                type: 'string',
                default: '0 0 9 * * 1-5',
                placeholder: '0 0 9 * * 1-5',
                description: 'Cron expression (seconds minutes hours day-of-month month day-of-week)',
                displayOptions: { show: { field: ['cronExpression'] } },
              },
            ],
          },
        ],
      },
    ],
  },

  async trigger(ctx: TriggerContext): Promise<TriggerResponse> {
    const rules = ((ctx.getNodeParameter('rule', 0, {}) as DataObject).interval ?? []) as Rule[];
    const timezone = ctx.getTimezone();
    const emit = () => {
      const now = DateTime.now().setZone(timezone);
      ctx.emit([
        [
          {
            json: {
              timestamp: now.toISO(),
              'Readable date': now.toFormat('MMMM d yyyy, h:mm:ss a'),
              'Day of week': now.toFormat('cccc'),
              Year: now.year,
              Month: now.toFormat('MMMM'),
              'Day of month': now.toFormat('dd'),
              Hour: now.toFormat('HH'),
              Minute: now.toFormat('mm'),
              Second: now.toFormat('ss'),
              Timezone: `${timezone} (UTC${now.toFormat('ZZ')})`,
            },
          },
        ],
      ]);
    };

    if (ctx.getMode() === 'manual') {
      return { manualTriggerFunction: async () => emit() };
    }
    const stops = rules.map((rule) => ctx.registerCron(ruleToCron(rule), emit));
    return {
      closeFunction: async () => {
        for (const stop of stops) stop();
      },
    };
  },
};
