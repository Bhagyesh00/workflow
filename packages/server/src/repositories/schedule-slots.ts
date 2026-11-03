/**
 * Last fired cron slot per Schedule Trigger rule, for missed schedules after a restart.
 *
 * STUB from the Phase 2 contract step (C0a): no slot is stored, every claim succeeds (today's
 * behaviour: no catch-up, no dedupe). Lane L10 adds the schedule_slots table and the real store.
 */
import type { ScheduleSlotStore } from '@workflow/workflow';
import type { DbOrTx } from '../db/client';

export class ScheduleSlotRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** the slot store of one trigger node; `graceS` is the instance default misfire grace */
  storeFor(_tenantId: string, _workflowId: string, _nodeName: string, graceS: number): ScheduleSlotStore {
    return {
      last: async () => undefined,
      claim: async () => true,
      reset: async () => {},
      defaultGraceSeconds: graceS,
    };
  }
}
