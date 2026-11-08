/**
 * P5-74 (L11): pick files for the next message: chips, remove, size warning before send. Controlled: the
 * composer holds the list and clears it after a send.
 */

export interface AttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
}

export function AttachmentPicker(_props: AttachmentPickerProps) {
  // L11 renders it
  return null;
}
