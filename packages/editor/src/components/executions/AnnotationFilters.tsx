/**
 * Executions list filters for annotation tags (all must match) and vote (P3-09); the page keeps
 * them in the URL params annotationTags (comma ids) and vote.
 *
 * C0 STUB: lane L9 writes it; renders nothing until then.
 */
import type { AnnotationVote } from '../../api/types';

export interface AnnotationFilterValue {
  tags: string[];
  vote?: AnnotationVote;
}

export function AnnotationFilters(_props: {
  value: AnnotationFilterValue;
  onChange: (next: AnnotationFilterValue) => void;
}): null {
  return null;
}
