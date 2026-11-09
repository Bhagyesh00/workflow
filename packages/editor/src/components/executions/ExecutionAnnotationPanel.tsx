/**
 * Tags and the good / bad rating of one execution on its detail page (P3-09); "No annotation
 * provided" when empty. Saves with executionsApi.annotate; a viewer sees it read-only.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { errorMessage } from '../../api/client';
import { executionsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { AnnotationPatchBody, AnnotationVote, ExecutionDetail, Tag } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { cx } from '../ui/cx';
import { AnnotationTagsEditor } from './AnnotationTagsEditor';

export function ExecutionAnnotationPanel({ execution }: { execution: ExecutionDetail }) {
  const queryClient = useQueryClient();
  // the server lets anyone who can read the run rate and tag it (n8n): `execution:read` by the run's own scopes
  const canWrite = usePermissions().can('execution:read', execution);
  const vote = execution.annotation?.vote ?? null;
  const tags: Tag[] = execution.annotation?.tags ?? [];

  const save = useMutation({
    mutationFn: (body: AnnotationPatchBody) => executionsApi.annotate(execution.id, body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.execution(execution.id) }),
        queryClient.invalidateQueries({ queryKey: ['executions'] }),
        queryClient.invalidateQueries({ queryKey: ['annotation-tags'] }),
      ]);
    },
    onError: (error) => toast.error('Couldn’t save the annotation', errorMessage(error)),
  });

  const rate = (next: AnnotationVote) => save.mutate({ vote: vote === next ? null : next });
  const empty = !vote && tags.length === 0;

  return (
    <section
      aria-label="Execution annotation"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2"
    >
      <h2 className="text-xs font-semibold text-ink-3">Annotation</h2>
      <fieldset className="m-0 flex min-w-0 items-center gap-1 border-0 p-0">
        <legend className="sr-only">Rating</legend>
        {(['up', 'down'] as const).map((v) => {
          const Icon = v === 'up' ? ThumbsUp : ThumbsDown;
          const label = v === 'up' ? 'Good run' : 'Bad run';
          const active = vote === v;
          return (
            <button
              key={v}
              type="button"
              aria-label={label}
              aria-pressed={active}
              disabled={!canWrite || save.isPending}
              onClick={() => rate(v)}
              className={cx(
                'grid size-7 place-items-center rounded-md border disabled:cursor-default',
                active
                  ? v === 'up'
                    ? 'border-ok bg-ok/10 text-ok'
                    : 'border-err bg-err/10 text-err'
                  : 'border-line text-ink-3 enabled:hover:bg-surface-3 enabled:hover:text-ink',
              )}
            >
              <Icon size={14} />
            </button>
          );
        })}
      </fieldset>
      <AnnotationTagsEditor
        value={tags}
        readOnly={!canWrite}
        disabled={save.isPending}
        onChange={(next) => save.mutate({ tags: next.map((t) => t.id) })}
      />
      {empty && <p className="text-xs text-ink-3">No annotation provided</p>}
    </section>
  );
}
