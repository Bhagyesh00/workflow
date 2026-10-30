/** Tag chips with a popover to attach existing tags or create new ones. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Tag as TagIcon, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { tagsApi } from '../../api/endpoints';
import { queryKeys, useTags } from '../../api/queries';
import type { Tag } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { cx } from '../ui/cx';

export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-ink-2">
      {tag.name}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${tag.name}`}
          onClick={onRemove}
          className="text-ink-3 hover:text-err"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}

export function TagsEditor({
  value,
  onChange,
  readOnly,
}: {
  value: Tag[];
  onChange: (tags: Tag[]) => void;
  readOnly?: boolean;
}) {
  const tags = useTags();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const create = useMutation({
    mutationFn: (name: string) => tagsApi.create(name),
    onSuccess: async (tag) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tags });
      onChange([...value, tag]);
      setQuery('');
    },
    onError: (error) => toast.error('Could not create the tag', errorMessage(error)),
  });

  const selected = new Set(value.map((t) => t.id));
  const q = query.trim().toLowerCase();
  const options = (tags.data ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
  const exact = (tags.data ?? []).some((t) => t.name.toLowerCase() === q);

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {value.map((tag) => (
          <TagChip
            key={tag.id}
            tag={tag}
            onRemove={readOnly ? undefined : () => onChange(value.filter((t) => t.id !== tag.id))}
          />
        ))}
      </div>
      {!readOnly && (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-semibold text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          {value.length ? <Plus size={11} /> : <TagIcon size={11} />}
          {value.length ? '' : 'Add tag'}
          <span className="sr-only">Edit tags</span>
        </button>
      )}
      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-lift">
          <input
            className="wf-field mb-1"
            placeholder="Find or create a tag"
            aria-label="Find or create a tag"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q && !exact) create.mutate(query.trim());
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div role="listbox" aria-multiselectable="true" className="wf-scroll max-h-56 overflow-auto">
            {options.map((tag) => (
              <button
                key={tag.id}
                type="button"
                role="option"
                aria-selected={selected.has(tag.id)}
                onClick={() =>
                  onChange(selected.has(tag.id) ? value.filter((t) => t.id !== tag.id) : [...value, tag])
                }
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3"
              >
                <span
                  className={cx(
                    'grid size-4 place-items-center rounded border',
                    selected.has(tag.id) ? 'border-brand bg-brand text-on-brand' : 'border-line-strong',
                  )}
                >
                  {selected.has(tag.id) && <Check size={10} />}
                </span>
                {tag.name}
              </button>
            ))}
            {q && !exact && (
              <button
                type="button"
                onClick={() => create.mutate(query.trim())}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-semibold text-brand hover:bg-surface-3"
              >
                <Plus size={13} /> Create “{query.trim()}”
              </button>
            )}
            {!options.length && !q && <p className="px-2 py-1.5 text-sm text-ink-3">No tags yet</p>}
          </div>
        </div>
      )}
    </div>
  );
}
