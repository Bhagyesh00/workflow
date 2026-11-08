/**
 * P5-62: the canvas part of a stream chunk. A `workflow-updated` chunk goes through `applyGraph`
 * (one undo step) and then the tidy-up on `deps.flow`. Stub until L2.
 */
import type { BuilderChunk } from '@workflow/workflow';
import type { BuilderDeps } from '../../stores/builder-store';

export function applyBuilderChunk(_chunk: BuilderChunk, _deps: BuilderDeps | null): void {
  throw new Error('not implemented (L2)');
}
