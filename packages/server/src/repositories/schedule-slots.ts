/**
 * Last fired cron slot per Schedule Trigger rule, for missed schedules after a restart.
 *
 * One row per workflow, trigger node and rule (`rule_key` is a hash of cron and timezone). `claim`
 * is a single conditional upsert: of two leaders asking for the same slot exactly one gets true.
 */

import type { ScheduleSlotStore } from '@workflow/workflow';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { scheduleSlots } from '../db/schema';

export class ScheduleSlotRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** the slot store of one trigger node; `graceS` is the instance default misfire grace */
  storeFor(tenantId: string, workflowId: string, nodeName: string, graceS: number): ScheduleSlotStore {
    const db = this.db;
    const where = (ruleKey: string) =>
      and(
        eq(scheduleSlots.tenantId, tenantId),
        eq(scheduleSlots.workflowId, workflowId),
        eq(scheduleSlots.nodeName, nodeName),
        eq(scheduleSlots.ruleKey, ruleKey),
      );
    const target = [scheduleSlots.workflowId, scheduleSlots.nodeName, scheduleSlots.ruleKey];
    return {
      defaultGraceSeconds: graceS,
      async last(ruleKey) {
        const [row] = await db
          .select({ lastSlot: scheduleSlots.lastSlot })
          .from(scheduleSlots)
          .where(where(ruleKey));
        return row?.lastSlot;
      },
      async claim(ruleKey, slot) {
        // inserts the first slot, or moves an older one forward; a slot that is not newer changes nothing
        const rows = await db
          .insert(scheduleSlots)
          .values({ tenantId, workflowId, nodeName, ruleKey, lastSlot: slot })
          .onConflictDoUpdate({
            target,
            set: { lastSlot: slot },
            setWhere: and(eq(scheduleSlots.tenantId, tenantId), lt(scheduleSlots.lastSlot, slot)),
          })
          .returning({ ruleKey: scheduleSlots.ruleKey });
        return rows.length > 0;
      },
      async reset(ruleKey, slot) {
        await db
          .insert(scheduleSlots)
          .values({ tenantId, workflowId, nodeName, ruleKey, lastSlot: slot })
          .onConflictDoUpdate({ target, set: { lastSlot: slot }, setWhere: sql`true` });
      },
    };
  }
}
