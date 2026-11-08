/**
 * P5-67 (L2): the caller's threads, newest first: open one, new, rename, delete (with a confirm).
 */
import type { AssistantThreadDTO } from '@workflow/workflow';
import { MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { formatRelative } from '../../lib/format';
import { Button, IconButton } from '../ui/Button';
import { cx } from '../ui/cx';
import { confirmDialog } from '../ui/Dialog';
import { TextInput } from '../ui/Field';

export interface AssistantThreadListProps {
  threads: AssistantThreadDTO[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
}

function RenameForm({
  thread,
  onDone,
  onRename,
}: {
  thread: AssistantThreadDTO;
  onDone: () => void;
  onRename: (title: string) => void;
}) {
  const [title, setTitle] = useState(thread.title);
  const closed = useRef(false);
  const commit = () => {
    if (closed.current) return;
    closed.current = true;
    const next = title.trim();
    if (next && next !== thread.title) onRename(next);
    onDone();
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    commit();
  };
  return (
    <form className="flex items-center gap-1 px-1 py-1" onSubmit={save}>
      <TextInput
        aria-label="Chat name"
        value={title}
        maxLength={200}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closed.current = true;
            onDone();
          }
        }}
        onBlur={commit}
        className="h-8 text-sm"
      />
    </form>
  );
}

export function AssistantThreadList({
  threads,
  activeThreadId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: AssistantThreadListProps) {
  const [renaming, setRenaming] = useState<string | null>(null);

  const remove = async (thread: AssistantThreadDTO) => {
    const ok = await confirmDialog({
      title: 'Delete this chat?',
      description: `"${thread.title}" and its messages are deleted. This can't be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) onDelete(thread.id);
  };

  return (
    <nav className="flex min-h-0 flex-col gap-2" aria-label="Chats">
      <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={onCreate}>
        New chat
      </Button>
      {threads.length === 0 ? (
        <p className="px-1 py-2 text-xs text-ink-2">No chats yet</p>
      ) : (
        <ul className="wf-scroll -mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1">
          {threads.map((thread) => {
            const active = thread.id === activeThreadId;
            if (renaming === thread.id) {
              return (
                <li key={thread.id}>
                  <RenameForm
                    thread={thread}
                    onDone={() => setRenaming(null)}
                    onRename={(title) => onRename(thread.id, title)}
                  />
                </li>
              );
            }
            return (
              <li
                key={thread.id}
                className={cx(
                  'group flex items-center gap-1 rounded-lg pr-1',
                  active ? 'bg-brand-soft' : 'hover:bg-surface-3',
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onSelect(thread.id)}
                >
                  <MessageSquare size={14} className="shrink-0 text-ink-2" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{thread.title}</span>
                    <span className="block text-xs text-ink-2">{formatRelative(thread.updatedAt)}</span>
                  </span>
                </button>
                <IconButton
                  label={`Rename ${thread.title}`}
                  size="sm"
                  className="opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => setRenaming(thread.id)}
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  label={`Delete ${thread.title}`}
                  size="sm"
                  className="opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => void remove(thread)}
                >
                  <Trash2 size={13} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
