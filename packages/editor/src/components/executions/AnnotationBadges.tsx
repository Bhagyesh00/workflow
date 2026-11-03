/** Annotation tags and vote of one execution row in the list (P3-09). */
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { ExecutionAnnotation } from '../../api/types';
import { TagChip } from '../workflow/TagsEditor';

export function AnnotationBadges({ annotation }: { annotation: ExecutionAnnotation | null }) {
  if (!annotation || (!annotation.vote && annotation.tags.length === 0)) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" aria-label="Annotation">
      {annotation.vote === 'up' && (
        <span role="img" aria-label="Rated good" className="text-ok">
          <ThumbsUp size={12} />
        </span>
      )}
      {annotation.vote === 'down' && (
        <span role="img" aria-label="Rated bad" className="text-err">
          <ThumbsDown size={12} />
        </span>
      )}
      {annotation.tags.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
    </div>
  );
}
