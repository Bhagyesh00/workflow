/**
 * P5-62: one chat message of the builder. Text renders through `Markdown` (lib/markdown.tsx), which builds
 * React elements and never raw HTML, so a model's `<img onerror>` stays text.
 */
import type { BuilderMessage as BuilderMessageData } from '@workflow/workflow';
import { Markdown } from '../../lib/markdown';
import { cx } from '../ui/cx';

export interface BuilderMessageProps {
  message: BuilderMessageData;
}

export function BuilderMessage({ message }: BuilderMessageProps) {
  const fromUser = message.role === 'user';
  // an assistant message that only carries a plan or questions shows them elsewhere (plan and questions rows)
  if (!message.text.trim()) return null;
  return (
    <div className={cx('flex', fromUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'max-w-[88%] min-w-0 rounded-xl px-3 py-2 text-sm break-words',
          fromUser ? 'bg-brand-soft text-ink' : 'border border-line bg-surface text-ink',
        )}
        data-role={message.role}
      >
        <span className="sr-only">{fromUser ? 'You: ' : 'AI builder: '}</span>
        <Markdown source={message.text} />
      </div>
    </div>
  );
}
