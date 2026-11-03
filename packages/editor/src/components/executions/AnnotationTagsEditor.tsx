/** Annotation tag chips with a popover to attach existing tags or create new ones (P3-09). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Tag as TagIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { annotationTagsApi } from '../../api/endpoints';
import { useAnnotationTags } from '../../api/queries';
import type { Tag } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { TagChip } from '../workflow/TagsEditor';
import { cx } from '../ui/cx';

export const ANNOTATION_TAG_MAX = 24;

export function AnnotationTagsEditor({
  value,
  onChange,
  readOnly,
  disabled,
}: {
  value: Tag[];
  onChange: (tags: Tag[]) => void;
  readOnly?: boolean;
  /** true while a save is running */
  disabled?: boolean;
}) {
  const tags = useAnnotationTags();
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
    mutationFn: (name: string) => annotationTagsApi.create(name),
    onSuccess: async (tag) => {
      await queryClient.invalidateQueries({ queryKey: ['annotation-tags'] });
      onChange([...value, { id: tag.id, name: tag.name }]);
      setQuery('');
    },
    onError: (error) => toast.error('Couldn’t create the tag', errorMessage(error)),
  });

  const selected = new Set(value.map((t) => t.id));
  const q = query.trim().toLowerCase();
  const all = tags.data ?? [];
  const options = all.filter((t) => !q || t.name.toLowerCase().includes(q));
  const exact = all.some((t) => t.name.toLowerCase() === q);

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {value.map((tag) => (
          <TagChip
            key={tag.id}
            tag={tag}
            onRemove={readOnly || disabled ? undefined : () => onChange(value.filter((t) => t.id !== tag.id))}
          />
        ))}
      </div>
      {!readOnly && (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-semibold text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-50"
        >
          {value.length ? <Plus size={11} /> : <TagIcon size={11} />}
          {value.length ? '' : 'Add tag'}
          <span className="sr-only">Edit annotation tags</span>
        </button>
      )}
      {open && !readOnly && (
        <div className="absolute top-full left-0 z-40 mt-1 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-lift">
          <input
            className="wf-field mb-1"
            placeholder="Find or create a tag"
            aria-label="Find or create an annotation tag"
            maxLength={ANNOTATION_TAG_MAX}
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
                  onChange(
                    selected.has(tag.id)
                      ? value.filter((t) => t.id !== tag.id)
                      : [...value, { id: tag.id, name: tag.name }],
                  )
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
                <Plus size={13} /> Create &ldquo;{query.trim()}&rdquo;
              </button>
            )}
            {!options.length && !q && <p className="px-2 py-1.5 text-sm text-ink-3">No tags yet</p>}
          </div>
        </div>
      )}
    </div>
  );
}
