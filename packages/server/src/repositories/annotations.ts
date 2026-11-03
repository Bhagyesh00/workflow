/**
 * Execution annotations (P3-09): vote and annotation tags per execution, and the annotation tag list.
 *
 * C0 STUB: lane L9 writes the bodies (and may add methods).
 */
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';

export type AnnotationVote = 'up' | 'down';

export interface ExecutionAnnotationDTO {
  vote: AnnotationVote | null;
  tags: Array<{ id: string; name: string }>;
}

export interface AnnotationFilter {
  /** annotation tag ids; an execution matches when it has all of them (AND, decisions D2) */
  tags?: string[];
  vote?: AnnotationVote;
}

/** extra WHERE conditions for the execution list (ExecutionRepository.list appends them) */
export function annotationConditions(_tenantId: string, _filter: AnnotationFilter): SQL[] {
  return [];
}

export class AnnotationRepository {
  constructor(readonly db: DbOrTx) {}

  /** annotations of the given executions, keyed by execution id (executions without one are absent) */
  async forExecutions(
    _tenantId: string,
    _executionIds: string[],
  ): Promise<Map<string, ExecutionAnnotationDTO>> {
    return new Map();
  }
}
