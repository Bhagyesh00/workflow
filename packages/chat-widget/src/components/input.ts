import { type BlobTracker, button, el } from '../dom';
import type { ChatStrings } from '../index';
import { createFilePicker, type FilePicker } from './files';

export interface InputOptions {
  strings: ChatStrings;
  allowFileUploads: boolean;
  allowedMimeTypes: string | undefined;
  blobs: BlobTracker;
  /** previous user messages, oldest first, for ArrowUp and ArrowDown */
  history(): string[];
  /** Resolves true when the message was accepted: the input then clears. False keeps the typed text. */
  onSend(text: string, files: File[]): Promise<boolean> | boolean;
}

export interface ChatInput {
  el: HTMLElement;
  textarea: HTMLTextAreaElement;
  files: FilePicker | undefined;
  setDisabled(disabled: boolean): void;
  setValue(value: string): void;
  focus(): void;
  blur(): void;
  submit(): Promise<void>;
}

export function createInput(options: InputOptions): ChatInput {
  const wrap = el('div', 'chat-inputs');
  const textarea = el('textarea', 'chat-input', undefined, {
    rows: '1',
    placeholder: options.strings.inputPlaceholder,
    'aria-label': options.strings.inputPlaceholder,
  });
  const send = button('chat-input-send-button', 'Send', 'Send');
  const picker = options.allowFileUploads
    ? createFilePicker({ allowedMimeTypes: options.allowedMimeTypes, blobs: options.blobs })
    : undefined;
  const attach = picker ? button('chat-input-file-button', '+', 'Attach files') : undefined;

  if (picker) wrap.appendChild(picker.el);
  const row = el('div', 'chat-input-row');
  if (attach && picker) {
    attach.addEventListener('click', () => picker.open());
    row.append(attach, picker.input);
  }
  row.append(textarea, send);
  wrap.appendChild(row);

  let disabled = false;
  let sending = false;
  // position in the walk through earlier messages; -1 when not walking
  let walk = -1;

  function resize(): void {
    textarea.style.height = 'auto';
    if (textarea.scrollHeight > 0) textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function setValue(value: string): void {
    textarea.value = value;
    resize();
  }

  function applyDisabled(): void {
    const off = disabled || sending;
    textarea.disabled = off;
    send.disabled = off;
    if (attach) attach.disabled = off;
    wrap.classList.toggle('chat-inputs-disabled', off);
  }

  async function submit(): Promise<void> {
    if (disabled || sending) return;
    const text = textarea.value.trim();
    const files = picker ? picker.files().slice() : [];
    if (!text && files.length === 0) return;
    sending = true;
    applyDisabled();
    let accepted = false;
    try {
      accepted = await options.onSend(text, files);
    } catch {
      accepted = false;
    } finally {
      sending = false;
      applyDisabled();
    }
    if (accepted) {
      walk = -1;
      setValue('');
      picker?.clear();
    }
    if (!disabled) textarea.focus();
  }

  textarea.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
      return;
    }
    const history = options.history();
    if (event.key === 'ArrowUp' && history.length > 0 && (walk >= 0 || textarea.value === '')) {
      event.preventDefault();
      walk = walk < 0 ? history.length - 1 : Math.max(0, walk - 1);
      setValue(history[walk] ?? '');
    } else if (event.key === 'ArrowDown' && walk >= 0) {
      event.preventDefault();
      walk += 1;
      if (walk >= history.length) {
        walk = -1;
        setValue('');
      } else {
        setValue(history[walk] ?? '');
      }
    }
  });
  textarea.addEventListener('input', () => {
    walk = -1;
    resize();
  });
  send.addEventListener('click', () => void submit());

  return {
    el: wrap,
    textarea,
    files: picker,
    setDisabled(value) {
      disabled = value;
      applyDisabled();
    },
    setValue,
    focus: () => textarea.focus(),
    blur: () => textarea.blur(),
    submit,
  };
}
