/** Date & Time: current date, add/subtract, format, extract a part, round, time between dates (Luxon). */
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { DateTime, type DateTimeUnit, type DurationLikeObject } from 'luxon';
import { parseDate } from '../../utils/filter';
import { ItemList, mapItems, setField } from '../../utils/utilities';

const UNITS = [
  'years',
  'quarters',
  'months',
  'weeks',
  'days',
  'hours',
  'minutes',
  'seconds',
  'milliseconds',
] as const;

const unitOptions = UNITS.map((u) => ({ name: u[0].toUpperCase() + u.slice(1), value: u }));

const partOptions = [
  { name: 'Year', value: 'year' },
  { name: 'Month', value: 'month' },
  { name: 'Week', value: 'week' },
  { name: 'Day', value: 'day' },
  { name: 'Hour', value: 'hour' },
  { name: 'Minute', value: 'minute' },
  { name: 'Second', value: 'second' },
];

function op(operations: string[]): NodeProperty['displayOptions'] {
  return { show: { operation: operations } };
}

function dateField(name: string, displayName: string, operations: string[]): NodeProperty {
  return {
    displayName,
    name,
    type: 'string',
    default: '',
    required: true,
    placeholder: '={{ $json.createdAt }}',
    description: 'ISO 8601, RFC 2822, SQL or HTTP date, a Unix timestamp, or a date from an expression',
    displayOptions: op(operations),
  };
}

function outputField(defaultName: string, operations: string[]): NodeProperty {
  return {
    displayName: 'Output Field Name',
    name: 'outputFieldName',
    type: 'string',
    default: defaultName,
    displayOptions: op(operations),
  };
}

function readDate(
  ctx: ExecuteContext,
  name: string,
  itemIndex: number,
  zone: string,
  fromFormat?: string,
): DateTime {
  const value = ctx.getNodeParameter(name, itemIndex, '');
  let date: DateTime | undefined;
  if (fromFormat && typeof value === 'string') date = DateTime.fromFormat(value, fromFormat, { zone });
  else date = parseDate(value, true, zone);
  if (!date?.isValid) {
    throw new NodeOperationError(ctx.getNode(), `"${String(value)}" is not a date this node can read`, {
      itemIndex,
      parameter: name,
      description: fromFormat
        ? `It does not match the format "${fromFormat}"`
        : 'Use ISO 8601 (2024-05-01T10:00:00Z), a Unix timestamp, or set "From Date Format"',
    });
  }
  return zone ? date.setZone(zone) : date;
}

function output(date: DateTime): string | number {
  return date.toISO() ?? date.toString();
}

export const DateTimeNode: NodeType = {
  description: {
    name: 'core.dateTime',
    displayName: 'Date & Time',
    description: 'Get, shift, format, round and compare dates',
    icon: 'lucide:calendar-clock',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Date & Time' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data transformation'],
    alias: ['date', 'time', 'timestamp', 'timezone', 'format', 'luxon', 'duration', 'difference'],
    subtitle: '={{ $parameter.operation }}',
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'getCurrentDate',
        noDataExpression: true,
        options: [
          { name: 'Get Current Date', value: 'getCurrentDate', action: 'Get the current date' },
          { name: 'Add to a Date', value: 'addToDate', action: 'Add time to a date' },
          { name: 'Subtract From a Date', value: 'subtractFromDate', action: 'Subtract time from a date' },
          { name: 'Format a Date', value: 'formatDate', action: 'Format a date' },
          { name: 'Round a Date', value: 'roundDate', action: 'Round a date' },
          { name: 'Extract Part of a Date', value: 'extractDate', action: 'Extract part of a date' },
          { name: 'Get Time Between Dates', value: 'getTimeBetweenDates', action: 'Get time between dates' },
        ],
      },
      {
        displayName: 'Include Current Time',
        name: 'includeTime',
        type: 'boolean',
        default: true,
        description: 'Whether to include the time, or only the date at midnight',
        displayOptions: op(['getCurrentDate']),
      },
      outputField('currentDate', ['getCurrentDate']),
      dateField('magnitude', 'Date to Add To', ['addToDate']),
      dateField('magnitude', 'Date to Subtract From', ['subtractFromDate']),
      {
        displayName: 'Time Unit',
        name: 'timeUnit',
        type: 'options',
        default: 'days',
        options: unitOptions,
        displayOptions: op(['addToDate', 'subtractFromDate']),
      },
      {
        displayName: 'Duration',
        name: 'duration',
        type: 'number',
        default: 0,
        displayOptions: op(['addToDate', 'subtractFromDate']),
      },
      outputField('newDate', ['addToDate', 'subtractFromDate']),
      dateField('date', 'Date', ['formatDate', 'roundDate', 'extractDate']),
      {
        displayName: 'Format',
        name: 'format',
        type: 'options',
        default: 'MM/dd/yyyy',
        displayOptions: op(['formatDate']),
        options: [
          { name: 'Custom Format', value: 'custom' },
          { name: 'MM/DD/YYYY', value: 'MM/dd/yyyy', description: 'Example: 09/04/1986' },
          { name: 'YYYY/MM/DD', value: 'yyyy/MM/dd', description: 'Example: 1986/04/09' },
          { name: 'MMMM DD YYYY', value: 'MMMM dd yyyy', description: 'Example: April 09 1986' },
          { name: 'MM-DD-YYYY', value: 'MM-dd-yyyy', description: 'Example: 09-04-1986' },
          { name: 'YYYY-MM-DD', value: 'yyyy-MM-dd', description: 'Example: 1986-04-09' },
          { name: 'ISO 8601', value: 'iso' },
          { name: 'Unix Timestamp (Seconds)', value: 'X' },
          { name: 'Unix Timestamp (Milliseconds)', value: 'x' },
        ],
      },
      {
        displayName: 'Custom Format',
        name: 'customFormat',
        type: 'string',
        default: '',
        placeholder: "yyyy-MM-dd'T'HH:mm",
        description: 'Luxon format tokens, e.g. "dd.MM.yyyy HH:mm"',
        displayOptions: { show: { operation: ['formatDate'], format: ['custom'] } },
      },
      outputField('formattedDate', ['formatDate']),
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'roundDown',
        displayOptions: op(['roundDate']),
        options: [
          { name: 'Round Down', value: 'roundDown' },
          { name: 'Round Up', value: 'roundUp' },
        ],
      },
      {
        displayName: 'To Nearest',
        name: 'toNearest',
        type: 'options',
        default: 'day',
        options: partOptions,
        displayOptions: op(['roundDate']),
      },
      outputField('roundedDate', ['roundDate']),
      {
        displayName: 'Part',
        name: 'part',
        type: 'options',
        default: 'month',
        options: partOptions,
        displayOptions: op(['extractDate']),
      },
      outputField('datePart', ['extractDate']),
      dateField('startDate', 'Start Date', ['getTimeBetweenDates']),
      dateField('endDate', 'End Date', ['getTimeBetweenDates']),
      {
        displayName: 'Units',
        name: 'units',
        type: 'multiOptions',
        default: ['days'],
        options: unitOptions,
        displayOptions: op(['getTimeBetweenDates']),
      },
      outputField('timeDifference', ['getTimeBetweenDates']),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Timezone',
            name: 'timezone',
            type: 'string',
            default: '',
            placeholder: 'Europe/Berlin',
            description: 'IANA timezone for reading and writing dates; defaults to the workflow timezone',
          },
          {
            displayName: 'From Date Format',
            name: 'fromFormat',
            type: 'string',
            default: '',
            placeholder: 'dd/MM/yyyy',
            description: 'Luxon format of the input date when it is not a standard format',
          },
          {
            displayName: 'Output as ISO Duration',
            name: 'isoString',
            type: 'boolean',
            default: false,
            description: 'Whether to output the difference as an ISO 8601 duration such as P1DT2H',
            displayOptions: { show: { '/operation': ['getTimeBetweenDates'] } },
          },
          {
            displayName: 'Include Input Fields',
            name: 'includeInputFields',
            type: 'boolean',
            default: true,
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    return [
      await mapItems(ctx, async (i, item) => {
        const operation = ctx.getNodeParameter('operation', i) as string;
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const zone = String(options.timezone || ctx.getTimezone() || 'UTC');
        if (!DateTime.local().setZone(zone).isValid) {
          throw new NodeOperationError(ctx.getNode(), `Unknown timezone "${zone}"`, { itemIndex: i });
        }
        const fromFormat = options.fromFormat ? String(options.fromFormat) : undefined;
        const json: DataObject = options.includeInputFields === false ? {} : deepCopy(item.json);
        const field = String(ctx.getNodeParameter('outputFieldName', i, 'data') || 'data');
        let value: unknown;

        switch (operation) {
          case 'getCurrentDate': {
            const now = DateTime.now().setZone(zone);
            value = output(ctx.getNodeParameter('includeTime', i, true) ? now : now.startOf('day'));
            break;
          }
          case 'addToDate':
          case 'subtractFromDate': {
            const date = readDate(ctx, 'magnitude', i, zone, fromFormat);
            const unit = ctx.getNodeParameter('timeUnit', i, 'days') as keyof DurationLikeObject;
            const amount = Number(ctx.getNodeParameter('duration', i, 0));
            if (!Number.isFinite(amount))
              throw new NodeOperationError(ctx.getNode(), 'Duration must be a number', { itemIndex: i });
            const duration = { [unit]: amount } as DurationLikeObject;
            value = output(operation === 'addToDate' ? date.plus(duration) : date.minus(duration));
            break;
          }
          case 'formatDate': {
            const date = readDate(ctx, 'date', i, zone, fromFormat);
            const format = ctx.getNodeParameter('format', i, 'MM/dd/yyyy') as string;
            if (format === 'iso') value = output(date);
            else if (format === 'X') value = Math.floor(date.toSeconds());
            else if (format === 'x') value = date.toMillis();
            else {
              const pattern =
                format === 'custom' ? String(ctx.getNodeParameter('customFormat', i, '')) : format;
              if (!pattern)
                throw new NodeOperationError(ctx.getNode(), 'Enter a custom format', { itemIndex: i });
              value = date.toFormat(pattern);
            }
            break;
          }
          case 'roundDate': {
            const date = readDate(ctx, 'date', i, zone, fromFormat);
            const unit = ctx.getNodeParameter('toNearest', i, 'day') as DateTimeUnit;
            const down = date.startOf(unit);
            value = output(
              ctx.getNodeParameter('mode', i, 'roundDown') === 'roundUp' && !down.equals(date)
                ? down.plus({ [unit]: 1 })
                : down,
            );
            break;
          }
          case 'extractDate': {
            const date = readDate(ctx, 'date', i, zone, fromFormat);
            const part = ctx.getNodeParameter('part', i, 'month') as string;
            value = part === 'week' ? date.weekNumber : date.get(part as 'year');
            break;
          }
          case 'getTimeBetweenDates': {
            const start = readDate(ctx, 'startDate', i, zone, fromFormat);
            const end = readDate(ctx, 'endDate', i, zone, fromFormat);
            let units = ctx.getNodeParameter('units', i, ['days']) as string[];
            if (!Array.isArray(units) || !units.length) units = ['days'];
            const ordered = UNITS.filter((u) => units.includes(u));
            const diff = end.diff(start, ordered);
            value = options.isoString ? diff.toISO() : diff.toObject();
            break;
          }
          default:
            throw new NodeOperationError(ctx.getNode(), `Unknown operation "${operation}"`, { itemIndex: i });
        }
        setField(json, field, value);
        return new ItemList([{ json, ...(item.binary ? { binary: item.binary } : {}) }]);
      }),
    ];
  },
};
