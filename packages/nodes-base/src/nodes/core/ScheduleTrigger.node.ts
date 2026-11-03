import { createHash } from 'node:crypto';
import type {
  DataObject,
  NodeType,
  ScheduleSlotStore,
  TriggerContext,
  TriggerResponse,
} from '@workflow/workflow';
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

const MAX_GRACE_S = 30 * 86_400;
const SLOT_PAGE = 100;
const MAX_SLOT_PAGES = 20;

/** days from 1970-01-01 to the first Monday (1970-01-05), the anchor week of every multi-week schedule */
const EPOCH_MONDAY_DAYS = 4;

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
      {
        displayName: 'Missed Schedules',
        name: 'misfirePolicy',
        type: 'options',
        default: 'skip',
        noDataExpression: true,
        isNodeSetting: true,
        description: 'What to do with the runs that were due while the server was down',
        options: [
          { name: 'Skip', value: 'skip', description: 'Run nothing for missed runs' },
          {
            name: 'Run Once For The Whole Trigger',
            value: 'coalesce_owner',
            description: 'Run the newest missed run once across all rules',
          },
          {
            name: 'Run Once Per Rule',
            value: 'coalesce',
            description: 'Run the newest missed run of each rule once',
          },
        ],
      },
      {
        displayName: 'Missed Run Grace (Seconds)',
        name: 'misfireGraceSeconds',
        type: 'number',
        default: 0,
        noDataExpression: true,
        isNodeSetting: true,
        typeOptions: { minValue: 0, maxValue: MAX_GRACE_S },
        description: 'A run later than this counts as missed. 0 uses the instance default. At most 30 days.',
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

    const store = ctx.scheduleSlots;
    const policy = misfirePolicyOf(ctx.getNodeParameter('misfirePolicy', 0, 'skip'));
    const graceMs = graceSeconds(ctx.getNodeParameter('misfireGraceSeconds', 0, 0), store) * 1000;
    let stopped = false;

    const jobs = rules.map((rule, index) => {
      const cron = ruleToCron(rule);
      const weeks = rule.field === 'weeks' ? Math.floor(Number(rule.weeksInterval ?? 1)) : 1;
      // cron has no "every N weeks": the weekly schedule fires only on weeks that are a multiple of N
      // since the epoch, so it stays the same after a restart or reactivation
      const fires = (slot: Date) => {
        if (!(weeks > 1)) return true;
        const week = DateTime.fromJSDate(slot).setZone(timezone).startOf('week');
        const days = Date.UTC(week.year, week.month - 1, week.day) / 86_400_000;
        return ((days - EPOCH_MONDAY_DAYS) / 7) % weeks === 0;
      };
      return { cron, fires, key: ruleKey(index, cron, timezone, weeks) };
    });

    /** missed schedules: runs once, before any live tick is let through */
    const catchUp = async () => {
      if (!store) return;
      const now = Date.now();
      const keys = jobs.map((job) => job.key);
      if (ctx.getActivationMode() !== 'init') {
        // only a restart or a new leader catches up; any other activation starts from now
        for (const key of keys) await store.reset(key, new Date(now));
        return;
      }
      const cutoff = now - graceMs;
      const plans: Array<{ key: string; fresh: Date[]; missed?: Date; pointer?: Date }> = [];
      for (const job of jobs) {
        const last = await store.last(job.key);
        if (!last) {
          await store.reset(job.key, new Date(now));
          continue;
        }
        if (last.getTime() >= now) continue;
        // late by no more than the grace: still runs, one run per slot
        const fresh = slotsIn(
          ctx,
          job.cron,
          new Date(Math.max(last.getTime(), cutoff - 1)),
          new Date(now),
        ).filter(job.fires);
        // older than the grace: missed; the policy decides what is left of them
        const missed =
          policy === 'skip' ? undefined : newestIn(ctx, job.cron, last, new Date(cutoff), job.fires);
        const pointer = newestIn(ctx, job.cron, last, new Date(now), () => true);
        plans.push({ key: job.key, fresh, missed, pointer });
      }
      if (policy === 'coalesce_owner') {
        let best: (typeof plans)[number] | undefined;
        for (const plan of plans) {
          if (plan.missed && (!best || plan.missed.getTime() > (best.missed as Date).getTime())) best = plan;
        }
        for (const plan of plans) if (plan !== best) plan.missed = undefined;
      }
      for (const plan of plans) {
        for (const slot of [...(plan.missed ? [plan.missed] : []), ...plan.fresh]) {
          if (stopped) return;
          // the claim is what keeps two leaders from both running the slot
          if (await store.claim(plan.key, slot)) emit();
        }
        // dropped slots are never looked at again
        if (plan.pointer && !stopped) await store.claim(plan.key, plan.pointer);
      }
    };

    const stops = jobs.map((job) =>
      ctx.registerCron(job.cron, (slot) => {
        // without a slot store there is no catch-up and no claim: a tick runs at once, in the same call
        if (!store) {
          if (!stopped && job.fires(slot)) emit();
          return;
        }
        void ready.then(async () => {
          if (stopped || !job.fires(slot)) return;
          try {
            if (!(await store.claim(job.key, slot))) return;
          } catch (error) {
            // a store that is down must not stop the schedule
            ctx.logger.warn('Schedule slot claim failed, running anyway', { error: String(error) });
          }
          emit();
        });
      }),
    );
    const ready: Promise<void> = catchUp().catch((error) =>
      ctx.logger.warn('Missed schedules could not be checked', { error: String(error) }),
    );
    return {
      closeFunction: async () => {
        stopped = true;
        for (const stop of stops) stop();
      },
    };
  },
};

type MisfirePolicy = 'skip' | 'coalesce_owner' | 'coalesce';

function misfirePolicyOf(value: unknown): MisfirePolicy {
  return value === 'coalesce' || value === 'coalesce_owner' ? value : 'skip';
}

/** a node value of 1 or more replaces the instance default; the result is clamped to 30 days */
function graceSeconds(value: unknown, store: ScheduleSlotStore | undefined): number {
  const own = Math.floor(Number(value));
  const seconds = own >= 1 ? own : (store?.defaultGraceSeconds ?? 0);
  return Math.min(MAX_GRACE_S, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
}

/**
 * One key per rule, by its place in the list: as in n8n every rule is its own schedule, so two
 * identical rules both run, and rules that differ only in their week interval never share slots.
 */
function ruleKey(index: number, cron: string, timezone: string, weeksInterval: number): string {
  return createHash('sha256').update(`${index}|${cron}|${timezone}|${weeksInterval}`).digest('hex');
}

/** every slot between `after` and `before` (both excluded), oldest first, at most 2000 */
function slotsIn(ctx: TriggerContext, cron: string, after: Date, before: Date): Date[] {
  const out: Date[] = [];
  let from = after;
  for (let page = 0; page < MAX_SLOT_PAGES; page++) {
    const got = ctx.getCronSlots(cron, from, before, SLOT_PAGE);
    out.push(...got);
    if (got.length < SLOT_PAGE) break;
    from = got[got.length - 1];
  }
  return out;
}

/**
 * The newest slot after `lower` and before `upper` that passes `ok`. It looks back from `upper` in
 * windows that grow, so a long outage of a busy schedule is not walked slot by slot.
 */
function newestIn(
  ctx: TriggerContext,
  cron: string,
  lower: Date,
  upper: Date,
  ok: (slot: Date) => boolean,
): Date | undefined {
  let hi = upper.getTime() - 1; // inclusive end of the window
  let width = 1000;
  while (hi > lower.getTime()) {
    const lo = Math.max(lower.getTime(), hi - width);
    const found = slotsIn(ctx, cron, new Date(lo), new Date(hi + 1)).filter(ok);
    if (found.length) return found[found.length - 1];
    hi = lo;
    width *= 4;
  }
  return undefined;
}
