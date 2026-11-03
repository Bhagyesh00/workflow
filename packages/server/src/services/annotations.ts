/**
 * Execution annotations (P3-09): PATCH /executions/:id {tags?, vote?}.
 *
 * C0 STUB: lane L9 writes the body.
 */
import type { ServiceDeps } from '../context';
import type { AnnotationVote, ExecutionAnnotationDTO } from '../repositories';
import type { Actor } from './workflows';

export class AnnotationService {
  constructor(readonly deps: ServiceDeps) {}

  /** set the execution's tags and / or vote; returns the annotation (C0: null) */
  async annotate(
    _tenantId: string,
    _executionId: string,
    _patch: { tags?: string[]; vote?: AnnotationVote | null },
    _actor: Actor,
  ): Promise<ExecutionAnnotationDTO | null> {
    return null;
  }
}
