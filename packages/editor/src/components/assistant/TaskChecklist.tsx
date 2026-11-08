/**
 * P5-69 (L6): the thread's task list (`update_tasks`). Each task shows its state as an icon and as text (screen
 * readers read the text), its description and its optional detail; everything is a text node.
 */
import type { AssistantTask, AssistantTaskStatus } from '@workflow/workflow';
import { Ban, CheckCircle, Circle, Loader2, type LucideIcon, XCircle } from 'lucide-react';

export interface TaskChecklistProps {
  tasks: AssistantTask[];
}

const TASK_STATUS: Record<AssistantTaskStatus, { label: string; Icon: LucideIcon; className: string }> = {
  todo: { label: 'To do', Icon: Circle, className: 'text-ink-3' },
  in_progress: { label: 'In progress', Icon: Loader2, className: 'text-brand motion-safe:animate-spin' },
  done: { label: 'Done', Icon: CheckCircle, className: 'text-ok' },
  failed: { label: 'Failed', Icon: XCircle, className: 'text-err' },
  cancelled: { label: 'Cancelled', Icon: Ban, className: 'text-ink-3' },
};

export function TaskChecklist({ tasks }: TaskChecklistProps) {
  const done = tasks.filter((task) => task.status === 'done').length;
  return (
    <section
      aria-label="Tasks"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
    >
      <p className="text-xs font-semibold text-ink-2">
        Tasks: {done} of {tasks.length} done
      </p>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {tasks.map((task) => {
          const status = TASK_STATUS[task.status] ?? TASK_STATUS.todo;
          const { Icon } = status;
          return (
            <li key={task.id} data-status={task.status} className="flex min-w-0 items-start gap-2 text-sm">
              <Icon size={14} aria-hidden="true" className={`mt-0.5 shrink-0 ${status.className}`} />
              <span className="flex min-w-0 flex-col">
                <span
                  className={
                    task.status === 'cancelled'
                      ? 'break-words text-ink-3 line-through'
                      : 'break-words text-ink'
                  }
                >
                  <span className="sr-only">{status.label}: </span>
                  {task.description}
                </span>
                {task.detail ? <span className="break-words text-xs text-ink-2">{task.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
