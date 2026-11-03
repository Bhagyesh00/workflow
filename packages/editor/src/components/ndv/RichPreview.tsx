/**
 * Previews of video, JSON, text, markdown and HTML binaries (P3-14): kind from the base mime type,
 * never fileType; HTML in `<iframe sandbox="" srcdoc referrerpolicy="no-referrer">` with the CSP
 * meta (lib/html-preview.ts). Used by BinaryPreview.
 *
 * C0 STUB: lane L7 writes it; renders nothing until then.
 */
import type { BinaryData } from '@workflow/workflow';

export interface RichPreviewProps {
  binary: BinaryData;
  /** the bytes, typed from the allow-listed mime type */
  blob: Blob;
}

export function RichPreview(_props: RichPreviewProps): null {
  return null;
}
