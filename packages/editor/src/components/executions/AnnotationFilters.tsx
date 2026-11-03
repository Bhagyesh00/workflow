/**
 * Executions list filters for annotation tags (all must match) and vote (P3-09); the page keeps
 * them in the URL params annotationTags (comma ids) and vote.
 */
import { useAnnotationTags } from '../../api/queries';
import type { AnnotationVote } from '../../api/types';
import { Select } from '../ui/Field';
import { TagChip } from '../workflow/TagsEditor';

/** The most tags one filter may hold: GET /executions answers 400 above 20 annotationTags */
export const MAX_ANNOTATION_FILTER_TAGS = 20;

export interface AnnotationFilterValue {
  tags: string[];
  vote?: AnnotationVote;
}

export function AnnotationFilters({
  value,
  onChange,
}: {
  value: AnnotationFilterValue;
  onChange: (next: AnnotationFilterValue) => void;
}) {
  const known = useAnnotationTags().data ?? [];
  const nameOf = (id: string) => known.find((t) => t.id === id)?.name ?? id.slice(0, 8);
  const addable = known.filter((t) => !value.tags.includes(t.id));
  const full = value.tags.length >= MAX_ANNOTATION_FILTER_TAGS;
  return (
    <>
      <Select
        aria-label="Filter by rating"
        className="w-40"
        value={value.vote ?? ''}
        onChange={(e) =>
          onChange({ ...value, vote: (e.target.value || undefined) as AnnotationVote | undefined })
        }
      >
        <option value="">Any rating</option>
        <option value="up">Good runs</option>
        <option value="down">Bad runs</option>
      </Select>
      {(addable.length > 0 || value.tags.length > 0) && (
        <Select
          aria-label="Filter by tag"
          className="w-44"
          value=""
          disabled={addable.length === 0 || full}
          title={full ? `The filter takes at most ${MAX_ANNOTATION_FILTER_TAGS} tags` : undefined}
          onChange={(e) => {
            if (e.target.value && !full) onChange({ ...value, tags: [...value.tags, e.target.value] });
          }}
        >
          <option value="">{value.tags.length ? 'Add another tag' : 'Any tag'}</option>
          {addable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      )}
      {value.tags.map((id) => (
        <TagChip
          key={id}
          tag={{ id, name: nameOf(id) }}
          onRemove={() => onChange({ ...value, tags: value.tags.filter((t) => t !== id) })}
        />
      ))}
    </>
  );
}
