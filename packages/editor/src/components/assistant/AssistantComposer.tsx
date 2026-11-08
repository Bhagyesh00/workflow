/**
 * P5-67 (L2): the message box. Enter sends, Stop while a turn runs, disabled with the reason while a card waits;
 * mounts `AttachmentPicker` (L11) and sends its files through `readAttachments`.
 *
 * The text and files clear when the message goes and come back when the send fails, so nothing typed is lost.
 */
import type { AssistantSendMessage } from '@workflow/workflow';
import { ArrowUp, Square } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { errorMessage } from '../../api/client';
import { readAttachments } from '../../features/assistant/attachments';
import { IconButton } from '../ui/Button';
import { TextArea } from '../ui/Field';
import { AttachmentPicker } from './AttachmentPicker';

export interface AssistantComposerProps {
  running: boolean;
  /** set while the composer cannot send, shown as the reason */
  disabledReason?: string | null;
  onSend: (body: AssistantSendMessage) => void | Promise<void>;
  onStop: () => void;
}

export function AssistantComposer({ running, disabledReason, onSend, onStop }: AssistantComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const blocked = Boolean(disabledReason);
  const canSend = !running && !blocked && !sending && text.trim().length > 0;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const message = text;
    const picked = files;
    setSending(true);
    setFailure(null);
    try {
      const attachments = await readAttachments(picked);
      setText('');
      setFiles([]);
      try {
        await onSend(attachments.length ? { message, attachments } : { message });
      } catch (error) {
        setText(message);
        setFiles(picked);
        setFailure(errorMessage(error));
      }
    } catch (error) {
      // the files could not be read: nothing was sent
      setFailure(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => void submit(event)}
      aria-label="Message the Assistant"
    >
      <TextArea
        aria-label="Message"
        rows={3}
        placeholder={blocked ? (disabledReason ?? undefined) : 'Ask the Assistant'}
        value={text}
        disabled={blocked}
        aria-describedby={blocked ? 'assistant-composer-reason' : undefined}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {blocked && (
        <p id="assistant-composer-reason" className="text-xs text-ink-2" role="status">
          {disabledReason}
        </p>
      )}
      {failure && (
        <p className="text-xs text-err" role="alert">
          {failure}
        </p>
      )}
      <div className="flex items-center gap-2">
        <AttachmentPicker files={files} onChange={setFiles} />
        <span className="flex-1" />
        {running ? (
          <IconButton label="Stop" variant="secondary" onClick={onStop}>
            <Square size={14} />
          </IconButton>
        ) : (
          <IconButton label="Send" variant="secondary" type="submit" disabled={!canSend}>
            <ArrowUp size={16} />
          </IconButton>
        )}
      </div>
    </form>
  );
}
