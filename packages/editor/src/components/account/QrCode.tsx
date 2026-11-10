/** P6-18: a QR code drawn as SVG rects from uqr's bit matrix (no innerHTML). */
export interface QrCodeProps {
  /** the text to encode (the otpauth:// URI) */
  value: string;
  /** accessible name of the image */
  label: string;
  /** pixels per side; default 192 */
  size?: number;
}

export function QrCode(_props: QrCodeProps) {
  // stub (L2)
  return null;
}
