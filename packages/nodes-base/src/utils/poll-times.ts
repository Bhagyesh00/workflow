/**
 * The "Poll Times" setting of a polling node (n8n adds it to every node with `polling: true`). The
 * value is read by the server's `pollTimesToCron`: `{ item: [{ mode, hour, minute, weekday, dayOfMonth,
 * value, unit, cronExpression }] }`. Without a value the node is polled every minute.
 */
import type { NodeProperty } from '@workflow/workflow';

const mode = (...modes: string[]) => ({ show: { mode: modes } });

export const pollTimesProperty: NodeProperty = {
  displayName: 'Poll Times',
  name: 'pollTimes',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  placeholder: 'Add Time',
  default: { item: [{ mode: 'everyMinute' }] },
  description: 'Time at which polling should occur',
  options: [
    {
      name: 'item',
      displayName: 'Item',
      values: [
        {
          displayName: 'Mode',
          name: 'mode',
          type: 'options',
          default: 'everyMinute',
          options: [
            { name: 'Every Minute', value: 'everyMinute' },
            { name: 'Every Hour', value: 'everyHour' },
            { name: 'Every Day', value: 'everyDay' },
            { name: 'Every Week', value: 'everyWeek' },
            { name: 'Every Month', value: 'everyMonth' },
            { name: 'Every X', value: 'everyX' },
            { name: 'Custom', value: 'custom' },
          ],
        },
        {
          displayName: 'Hour',
          name: 'hour',
          type: 'number',
          typeOptions: { minValue: 0, maxValue: 23 },
          default: 14,
          displayOptions: mode('everyDay', 'everyWeek', 'everyMonth'),
          description: 'The hour of the day to poll at (0 to 23)',
        },
        {
          displayName: 'Minute',
          name: 'minute',
          type: 'number',
          typeOptions: { minValue: 0, maxValue: 59 },
          default: 0,
          displayOptions: mode('everyHour', 'everyDay', 'everyWeek', 'everyMonth'),
          description: 'The minute of the hour to poll at (0 to 59)',
        },
        {
          displayName: 'Day of Month',
          name: 'dayOfMonth',
          type: 'number',
          typeOptions: { minValue: 1, maxValue: 31 },
          default: 1,
          displayOptions: mode('everyMonth'),
          description: 'The day of the month to poll on (1 to 31)',
        },
        {
          displayName: 'Weekday',
          name: 'weekday',
          type: 'options',
          default: '1',
          displayOptions: mode('everyWeek'),
          options: [
            { name: 'Monday', value: '1' },
            { name: 'Tuesday', value: '2' },
            { name: 'Wednesday', value: '3' },
            { name: 'Thursday', value: '4' },
            { name: 'Friday', value: '5' },
            { name: 'Saturday', value: '6' },
            { name: 'Sunday', value: '0' },
          ],
          description: 'The weekday to poll on',
        },
        {
          displayName: 'Cron Expression',
          name: 'cronExpression',
          type: 'string',
          default: '0 * * * * *',
          displayOptions: mode('custom'),
          description:
            'Six fields: seconds, minutes, hours, day of month, month and weekday, for example 0 */15 * * * * for every 15 minutes',
        },
        {
          displayName: 'Value',
          name: 'value',
          type: 'number',
          typeOptions: { minValue: 1 },
          default: 2,
          displayOptions: mode('everyX'),
          description: 'Poll every this many units',
        },
        {
          displayName: 'Unit',
          name: 'unit',
          type: 'options',
          default: 'hours',
          displayOptions: mode('everyX'),
          options: [
            { name: 'Minutes', value: 'minutes' },
            { name: 'Hours', value: 'hours' },
          ],
        },
      ],
    },
  ],
};
