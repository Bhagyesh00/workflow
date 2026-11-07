/**
 * Batch processing shared by the agent and the chains: items run in parallel groups with an optional
 * pause between groups, so a provider's rate limit is not hit.
 */
import { type NodeProperty, sleep } from '@workflow/workflow';

export function batchingOption(defaultBatchSize: number): NodeProperty {
  return {
    displayName: 'Batch Processing',
    name: 'batching',
    type: 'collection',
    default: {},
    placeholder: 'Add Batch Processing Option',
    description: 'Run items in groups to stay under a rate limit',
    options: [
      {
        displayName: 'Batch Size',
        name: 'batchSize',
        type: 'number',
        default: defaultBatchSize,
        typeOptions: { minValue: 1 },
        description: 'Items that run at the same time. Above 1, log entries can appear out of order.',
      },
      {
        displayName: 'Delay Between Batches',
        name: 'delayBetweenBatches',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Milliseconds to wait between one batch and the next',
      },
    ],
  };
}

/**
 * Run `run(0)` to `run(count - 1)` in batches. One failed item does not stop the others: its entry is
 * `rejected`. Results are in input order. The delay falls between batches only, never after the last.
 * An abort before a batch or during a delay rejects the whole call; a batch under way runs to its end.
 */
export async function runInBatches<T>(
  count: number,
  options: { batchSize: number; delayMs: number; signal?: AbortSignal },
  run: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const size = Number.isFinite(options.batchSize) ? Math.max(1, Math.floor(options.batchSize)) : 1;
  const results: PromiseSettledResult<T>[] = [];
  for (let start = 0; start < count; start += size) {
    if (start > 0 && options.delayMs > 0) await sleep(options.delayMs, options.signal);
    options.signal?.throwIfAborted();
    const batch: Promise<T>[] = [];
    // async, so a `run` that throws before its first await settles as rejected like any other failure
    for (let index = start; index < Math.min(start + size, count); index++) {
      batch.push((async () => run(index))());
    }
    for (const result of await Promise.allSettled(batch)) results.push(result);
  }
  return results;
}
