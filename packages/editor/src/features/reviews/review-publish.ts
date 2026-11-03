/**
 * Review gate before publishing (P3-19): with workflow reviews on for the workspace, Publish asks
 * "Publish" or "Submit for review" (don't show again), and an open request blocks publishing.
 * features/editor/publish-actions.ts awaits it before the publish dialog.
 *
 * C0 STUB: lane L15 writes it; always 'publish' until then.
 */

/** 'publish': go on with the publish dialog; 'review': open the submit dialog; 'blocked': stop */
export type ReviewGateResult = 'publish' | 'review' | 'blocked';

export async function reviewGate(): Promise<ReviewGateResult> {
  return 'publish';
}
