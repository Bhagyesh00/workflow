/**
 * Review gate before publishing (P3-19): with workflow reviews on for the workspace, Publish asks
 * "Publish" or "Submit for review" (with a "Don't ask again" box), and an open request blocks
 * publishing. features/editor/publish-actions.ts awaits it before the publish dialog.
 *
 * Also holds the small ui store the dialog host (ReviewStatusBanner, mounted in the editor page)
 * reads, and the labels and text checks the review screens share.
 */
import { create } from 'zustand';
import { reviewsApi, settingsApi } from '../../api/endpoints';
import type { WorkflowReviewDTO } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';

/** 'publish': go on with the publish dialog; 'review': the submit dialog opened; 'blocked': stop */
export type ReviewGateResult = 'publish' | 'review' | 'blocked';

export type PublishChoice = 'publish' | 'review';

const CHOICE_KEY = 'wf.reviews.publishChoice';

function rememberedChoice(): PublishChoice | null {
  try {
    const value = window.localStorage.getItem(CHOICE_KEY);
    return value === 'publish' || value === 'review' ? value : null;
  } catch {
    return null;
  }
}

function rememberChoice(choice: PublishChoice): void {
  try {
    window.localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // storage blocked: the question simply shows again next time
  }
}

/** forget "Don't ask again" (the Security settings page offers it) */
export function forgetPublishChoice(): void {
  try {
    window.localStorage.removeItem(CHOICE_KEY);
  } catch {
    // nothing stored
  }
}

export function hasRememberedChoice(): boolean {
  return rememberedChoice() !== null;
}

interface ReviewUiState {
  /** the Publish / Submit for review question, answered through `settle` */
  choice: { settle: (value: PublishChoice | null, remember: boolean) => void } | null;
  submitOpen: boolean;
  updateFor: WorkflowReviewDTO | null;
  askChoice(): Promise<PublishChoice | null>;
  setSubmitOpen(open: boolean): void;
  setUpdateFor(review: WorkflowReviewDTO | null): void;
}

export const useReviewUi = create<ReviewUiState>()((set, get) => ({
  choice: null,
  submitOpen: false,
  updateFor: null,
  askChoice() {
    // a second question while one is open answers the first with "cancel"
    get().choice?.settle(null, false);
    return new Promise<PublishChoice | null>((resolve) => {
      set({
        choice: {
          settle: (value, remember) => {
            if (value && remember) rememberChoice(value);
            set({ choice: null });
            resolve(value);
          },
        },
      });
    });
  },
  setSubmitOpen: (submitOpen) => set({ submitOpen }),
  setUpdateFor: (updateFor) => set({ updateFor }),
}));

/** control characters other than tab, newline and carriage return are refused (as the server does) */
export function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

export function decisionLabel(review: Pick<WorkflowReviewDTO, 'state' | 'decision'>): string {
  if (review.state === 'closed') return review.decision === 'approved' ? 'Approved' : 'Closed';
  return review.decision === 'changes_requested' ? 'Changes requested' : 'Pending review';
}

export function decisionTone(
  review: Pick<WorkflowReviewDTO, 'state' | 'decision'>,
): 'neutral' | 'ok' | 'warn' | 'brand' {
  if (review.state === 'closed') return review.decision === 'approved' ? 'ok' : 'neutral';
  return review.decision === 'changes_requested' ? 'warn' : 'brand';
}

export async function reviewGate(): Promise<ReviewGateResult> {
  const workflowId = useWorkflowStore.getState().meta.id;
  if (!workflowId) return 'publish';
  let enabled = false;
  let open: WorkflowReviewDTO | undefined;
  try {
    enabled = (await settingsApi.get()).workflowReviews?.enabled === true;
    if (enabled) open = (await reviewsApi.list({ workflowId, state: 'open', limit: 1 })).data[0];
  } catch {
    // the server refuses a publish that a review blocks, so a failed lookup does not block here
    return 'publish';
  }
  if (!enabled) return 'publish';
  if (open) {
    const changes = open.decision === 'changes_requested';
    toast.info(
      changes ? 'Changes were requested on this workflow' : 'This workflow is waiting for a review',
      changes
        ? 'Update the review request with a new version before you publish.'
        : 'You can publish once the review is approved.',
    );
    return 'blocked';
  }
  const choice = rememberedChoice() ?? (await useReviewUi.getState().askChoice());
  if (choice === null) return 'blocked';
  if (choice === 'review') {
    useReviewUi.getState().setSubmitOpen(true);
    return 'review';
  }
  return 'publish';
}
