/** P4-29: the Poll Times setting of the RSS Feed Trigger reaches the schedule the server builds. */
import { nodesBasePackage } from '@workflow/nodes-base';
import { describe, expect, it } from 'vitest';
import { pollTimesToCron } from '../src/services/active-workflows';

const rss = () => nodesBasePackage.nodes.find((n) => n.description.name === 'core.rssFeedReadTrigger')!;
const setting = () => rss().description.properties.find((p) => p.name === 'pollTimes')!;

describe('RSS Feed Trigger Poll Times', () => {
  it('the node has the setting and its default is every minute', () => {
    expect(setting().type).toBe('fixedCollection');
    expect(pollTimesToCron(setting().default)).toEqual(['0 * * * * *']);
  });

  it('every mode of the setting turns into the cron expression the poller runs', () => {
    expect(pollTimesToCron({ item: [{ mode: 'everyHour', minute: 15 }] })).toEqual(['0 15 * * * *']);
    expect(pollTimesToCron({ item: [{ mode: 'everyDay', hour: 7, minute: 30 }] })).toEqual(['0 30 7 * * *']);
    expect(pollTimesToCron({ item: [{ mode: 'everyWeek', weekday: '0', hour: 9, minute: 5 }] })).toEqual([
      '0 5 9 * * 0',
    ]);
    expect(pollTimesToCron({ item: [{ mode: 'everyMonth', dayOfMonth: 3, hour: 1, minute: 2 }] })).toEqual([
      '0 2 1 3 * *',
    ]);
    expect(pollTimesToCron({ item: [{ mode: 'everyX', value: 3, unit: 'hours' }] })).toEqual([
      '0 0 */3 * * *',
    ]);
    expect(pollTimesToCron({ item: [{ mode: 'everyX', value: 10, unit: 'minutes' }] })).toEqual([
      '0 */10 * * * *',
    ]);
    expect(pollTimesToCron({ item: [{ mode: 'custom', cronExpression: '0 0 6 * * 1-5' }] })).toEqual([
      '0 0 6 * * 1-5',
    ]);
  });

  it('several items give several schedules', () => {
    expect(
      pollTimesToCron({
        item: [
          { mode: 'everyDay', hour: 8, minute: 0 },
          { mode: 'everyDay', hour: 18, minute: 0 },
        ],
      }),
    ).toEqual(['0 0 8 * * *', '0 0 18 * * *']);
  });
});
