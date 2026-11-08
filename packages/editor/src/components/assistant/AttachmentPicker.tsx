/**
 * P5-74 (L11): pick files for the next message: chips, remove, size warning before send. Controlled: the
 * composer holds the list and clears it after a send.
 */
import { ASSISTANT_ATTACHMENT_TYPES } from '@workflow/workflow';
import { Paperclip, X } from 'lucide-react';
import { useRef } from 'react';
import {
  ATTACHMENT_FILE_BYTES,
  attachmentMimeType,
  attachmentProblem,
} from '../../features/assistant/attachments';
import { IconButton } from '../ui/Button';

export interface AttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
}

const ACCEPT = Object.values(ASSISTANT_ATTACHMENT_TYPES).flat().join(',');

/** a stable key per picked file (a file picked twice is two `File` objects, so two keys) */
const fileKeys = new WeakMap<File, string>();
let nextFileKey = 0;
function fileKey(file: File): string {
  let key = fileKeys.get(file);
  if (!key) {
    nextFileKey += 1;
    key = `file-${nextFileKey}`;
    fileKeys.set(file, key);
  }
  return key;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

export function AttachmentPicker({ files, onChange }: AttachmentPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const problem = attachmentProblem(files);

  const add = (picked: FileList | null) => {
    if (picked && picked.length > 0) onChange([...files, ...Array.from(picked)]);
    // the same file can be picked again after it is removed
    if (input.current) input.current.value = '';
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        aria-label="Choose files"
        data-testid="assistant-file-input"
        onChange={(event) => add(event.target.files)}
      />
      <IconButton label="Attach files" variant="secondary" onClick={() => input.current?.click()}>
        <Paperclip size={16} />
      </IconButton>
      {files.length > 0 && (
        <ul className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0" aria-label="Attached files">
          {files.map((file, index) => {
            const bad = !attachmentMimeType(file) || file.size > ATTACHMENT_FILE_BYTES;
            return (
              <li
                key={fileKey(file)}
                className={`flex max-w-56 items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                  bad ? 'border-err text-err' : 'border-line bg-surface-2 text-ink-2'
                }`}
              >
                <span className="truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-ink-3">{sizeText(file.size)}</span>
                <button
                  type="button"
                  className="grid shrink-0 place-items-center rounded-full hover:text-ink"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onChange(files.filter((_, i) => i !== index))}
                >
                  <X size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {problem && (
        <p className="basis-full text-xs text-err" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
