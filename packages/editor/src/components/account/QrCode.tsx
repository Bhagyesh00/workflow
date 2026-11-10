/** P6-18: a QR code drawn as SVG rects from uqr's bit matrix (no innerHTML). */
import { useMemo } from 'react';
import { encode } from 'uqr';

export interface QrCodeProps {
  /** the text to encode (the otpauth:// URI) */
  value: string;
  /** accessible name of the image */
  label: string;
  /** pixels per side; default 192 */
  size?: number;
}

/** quiet zone around the code, in modules (the QR standard asks for four) */
const QUIET = 4;

/** one rect per horizontal run of dark modules */
function runs(matrix: boolean[][]): Array<{ x: number; y: number; width: number }> {
  const out: Array<{ x: number; y: number; width: number }> = [];
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x++) {
      const dark = x < row.length && row[x];
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        out.push({ x: start, y, width: x - start });
        start = -1;
      }
    }
  });
  return out;
}

export function QrCode({ value, label, size = 192 }: QrCodeProps) {
  const code = useMemo(() => {
    try {
      const { data, size: modules } = encode(value, { ecc: 'M', border: 0 });
      return { modules, rects: runs(data) };
    } catch {
      return null;
    }
  }, [value]);
  if (!code) return null;
  const side = code.modules + QUIET * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md border border-line"
    >
      {/* a QR code is dark on light in both themes, so scanners read it */}
      <rect width={side} height={side} fill="#ffffff" />
      {code.rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}`}
          x={r.x + QUIET}
          y={r.y + QUIET}
          width={r.width}
          height={1}
          fill="#000000"
        />
      ))}
    </svg>
  );
}
