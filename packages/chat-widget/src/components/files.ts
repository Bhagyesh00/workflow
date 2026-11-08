import { type BlobTracker, button, clear, el } from '../dom';

/** `allowedFilesMimeTypes`: comma-separated MIME types (`image/*`, `application/pdf`) or extensions (`.csv`); empty or `*` allows any. */
export function mimeAllowed(file: { type: string; name: string }, spec: string | undefined): boolean {
  const entries = (spec ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0 || entries.includes('*') || entries.includes('*/*')) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return entries.some((entry) => {
    if (entry.startsWith('.')) return name.endsWith(entry);
    if (entry.endsWith('/*')) return type.startsWith(entry.slice(0, -1));
    return type === entry;
  });
}

export function filterFiles(files: File[], spec: string | undefined): File[] {
  return files.filter((file) => mimeAllowed(file, spec));
}

/** One chip: the file name, an image preview through a `blob:` URL for images, and a delete button when `onRemove` is given. */
export function fileChip(
  file: File,
  blobs: BlobTracker,
  onRemove?: () => void,
  removeLabel = 'Remove',
): HTMLElement {
  const chip = el('div', 'chat-file');
  let previewUrl: string | undefined;
  if (file.type.startsWith('image/')) {
    previewUrl = blobs.create(file);
    if (previewUrl) {
      const img = el('img', 'chat-file-preview', undefined, { alt: file.name, src: previewUrl });
      chip.appendChild(img);
    }
  }
  chip.appendChild(el('p', 'chat-file-name', [file.name]));
  if (onRemove) {
    const remove = button('chat-file-delete', '×', `${removeLabel} ${file.name}`);
    remove.addEventListener('click', () => {
      if (previewUrl) blobs.revoke(previewUrl);
      onRemove();
    });
    chip.appendChild(remove);
  }
  return chip;
}

export interface FilePicker {
  /** the chips row, shown above the input */
  el: HTMLElement;
  /** the hidden `<input type="file">` */
  input: HTMLInputElement;
  files(): File[];
  add(files: File[]): void;
  clear(): void;
  open(): void;
}

export function createFilePicker(options: {
  allowedMimeTypes: string | undefined;
  blobs: BlobTracker;
  onChange?: (files: File[]) => void;
  removeLabel?: string;
}): FilePicker {
  const row = el('div', 'chat-files');
  row.hidden = true;
  const input = el('input', 'chat-file-input', undefined, { type: 'file', multiple: '' });
  input.hidden = true;
  const spec = options.allowedMimeTypes?.trim();
  if (spec && spec !== '*') input.setAttribute('accept', spec);
  let selected: File[] = [];
  /** preview URLs of the chips now on screen: a re-render and clear() revoke them */
  let previews: string[] = [];
  const previewBlobs: BlobTracker = {
    ...options.blobs,
    create(file) {
      const url = options.blobs.create(file);
      if (url) previews.push(url);
      return url;
    },
  };

  function render(): void {
    for (const url of previews) options.blobs.revoke(url);
    previews = [];
    clear(row);
    row.hidden = selected.length === 0;
    for (const file of selected) {
      row.appendChild(
        fileChip(
          file,
          previewBlobs,
          () => {
            selected = selected.filter((f) => f !== file);
            render();
            options.onChange?.(selected);
          },
          options.removeLabel,
        ),
      );
    }
  }

  const api: FilePicker = {
    el: row,
    input,
    files: () => selected,
    add(files) {
      const accepted = filterFiles(files, options.allowedMimeTypes);
      if (accepted.length === 0) return;
      selected = [...selected, ...accepted];
      render();
      options.onChange?.(selected);
    },
    clear() {
      selected = [];
      render();
      options.onChange?.(selected);
    },
    open() {
      input.click();
    },
  };

  input.addEventListener('change', () => {
    api.add(Array.from(input.files ?? []));
    input.value = '';
  });
  return api;
}
