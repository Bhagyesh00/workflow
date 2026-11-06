/**
 * Swaps untouched default code when a Code node's language or mode changes. Stub: L8 (P4-06) writes
 * it; answers `next` unchanged until then, because every parameter change goes through it.
 */
import type { NodeParameters } from '@workflow/workflow';

/** @returns the node's parameters to keep, given the parameters before and after the change */
export function applyCodeDefaults(
  _type: string,
  _prev: NodeParameters,
  next: NodeParameters,
): NodeParameters {
  return next;
}
