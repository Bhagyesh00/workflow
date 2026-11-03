/**
 * Edit Image composite: the 22 operators of n8n's Edit Image node (GraphicsMagick's names).
 *
 * Over, Atop and Difference use the canvas compositing modes; the other 19 are computed per pixel here, only
 * inside the area where the composite image overlaps the image (GraphicsMagick composites that area only).
 * Pixels are straight (not premultiplied) RGBA, 0-255. The meaning of each operator follows GraphicsMagick's
 * composite documentation; results are close to gm, not byte-identical.
 */
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import { context } from './canvas';

export const COMPOSITE_OPERATORS = [
  'Add',
  'Atop',
  'Bumpmap',
  'Copy',
  'CopyBlack',
  'CopyBlue',
  'CopyCyan',
  'CopyGreen',
  'CopyMagenta',
  'CopyOpacity',
  'CopyRed',
  'CopyYellow',
  'Difference',
  'Divide',
  'In',
  'Minus',
  'Multiply',
  'Out',
  'Over',
  'Plus',
  'Subtract',
  'Xor',
] as const;
export type CompositeOperator = (typeof COMPOSITE_OPERATORS)[number];

const CANVAS_MODES: Partial<Record<CompositeOperator, SKRSContext2D['globalCompositeOperation']>> = {
  Over: 'source-over',
  Atop: 'source-atop',
  Difference: 'difference',
};

type Pixel = [number, number, number, number];
/** writes the result for source s over destination d into out (all straight RGBA 0-255) */
type PixelOp = (s: Pixel, d: Pixel, out: Pixel) => void;

const clamp = (v: number) => Math.min(255, Math.max(0, v));
const luma = (p: Pixel) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

/**
 * The separable blend form (W3C compositing): inside both shapes the colour is blend(d, s), where only the source
 * covers it is s, where only the destination covers it is d; alpha is source-over alpha.
 */
function blend(fn: (s: number, d: number) => number): PixelOp {
  return (s, d, out) => {
    const sa = s[3] / 255;
    const da = d[3] / 255;
    const a = sa + da * (1 - sa);
    if (a <= 0) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return;
    }
    for (let c = 0; c < 3; c++) {
      const mixed = sa * (1 - da) * s[c] + sa * da * clamp(fn(s[c], d[c])) + (1 - sa) * da * d[c];
      out[c] = clamp(mixed / a);
    }
    out[3] = clamp(a * 255);
  };
}

/** colour from the source with the given alpha (0-1) */
function sourceWithAlpha(alpha: (sa: number, da: number) => number): PixelOp {
  return (s, d, out) => {
    const a = alpha(s[3] / 255, d[3] / 255);
    out[0] = s[0];
    out[1] = s[1];
    out[2] = s[2];
    out[3] = clamp(a * 255);
  };
}

/** the destination with some channels replaced, mixed in by the source's alpha; destination alpha stays */
function replaceChannels(replace: (s: Pixel, d: Pixel) => [number, number, number]): PixelOp {
  return (s, d, out) => {
    const sa = s[3] / 255;
    const replaced = replace(s, d);
    for (let c = 0; c < 3; c++) out[c] = clamp(sa * replaced[c] + (1 - sa) * d[c]);
    out[3] = d[3];
  };
}

type Cmyk = [number, number, number, number];

function toCmyk(p: Pixel): Cmyk {
  const r = p[0] / 255;
  const g = p[1] / 255;
  const b = p[2] / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}

function fromCmyk([c, m, y, k]: Cmyk): [number, number, number] {
  return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
}

function copyCmyk(channel: 0 | 1 | 2 | 3): PixelOp {
  return replaceChannels((s, d) => {
    const target = toCmyk(d);
    target[channel] = toCmyk(s)[channel];
    return fromCmyk(target);
  });
}

function copyRgb(channel: 0 | 1 | 2): PixelOp {
  return replaceChannels((s, d) => {
    const rgb: [number, number, number] = [d[0], d[1], d[2]];
    rgb[channel] = s[channel];
    return rgb;
  });
}

function pixelOp(operator: CompositeOperator, sourceHasAlpha: boolean): PixelOp {
  switch (operator) {
    // Porter-Duff
    case 'Copy':
      return (s, _d, out) => {
        out[0] = s[0];
        out[1] = s[1];
        out[2] = s[2];
        out[3] = s[3];
      };
    case 'In':
      return sourceWithAlpha((sa, da) => sa * da);
    case 'Out':
      return sourceWithAlpha((sa, da) => sa * (1 - da));
    case 'Xor':
      return (s, d, out) => {
        const sa = s[3] / 255;
        const da = d[3] / 255;
        const ws = sa * (1 - da);
        const wd = da * (1 - sa);
        const a = ws + wd;
        for (let c = 0; c < 3; c++) out[c] = a > 0 ? clamp((ws * s[c] + wd * d[c]) / a) : 0;
        out[3] = clamp(a * 255);
      };
    case 'Plus':
      // sum of the (premultiplied) image data, cropped; independent of which shape is on top
      return (s, d, out) => {
        const sa = s[3] / 255;
        const da = d[3] / 255;
        const a = Math.min(1, sa + da);
        for (let c = 0; c < 3; c++) out[c] = a > 0 ? clamp(Math.min(255, sa * s[c] + da * d[c]) / a) : 0;
        out[3] = clamp(a * 255);
      };
    // arithmetic on the colour channels (source op destination, as gm documents them)
    case 'Add':
      return blend((s, d) => (s + d) % 256);
    case 'Subtract':
      return blend((s, d) => (((s - d) % 256) + 256) % 256);
    case 'Minus':
      return blend((s, d) => Math.max(0, s - d));
    case 'Multiply':
      return blend((s, d) => (s * d) / 255);
    case 'Divide':
      // the image divided by the composite image (removes uneven lighting with a blurred copy)
      return blend((s, d) => (s === 0 ? (d === 0 ? 0 : 255) : (d / s) * 255));
    case 'Bumpmap':
      return (s, d, out) => {
        const shade = luma(s) / 255;
        blend((_s, dc) => dc * shade)(s, d, out);
      };
    // channel copies: the destination keeps its other channels
    case 'CopyRed':
      return copyRgb(0);
    case 'CopyGreen':
      return copyRgb(1);
    case 'CopyBlue':
      return copyRgb(2);
    case 'CopyCyan':
      return copyCmyk(0);
    case 'CopyMagenta':
      return copyCmyk(1);
    case 'CopyYellow':
      return copyCmyk(2);
    case 'CopyBlack':
      return copyCmyk(3);
    case 'CopyOpacity':
      // a composite image without transparency gives its brightness as the opacity (as gm does)
      return (s, d, out) => {
        out[0] = d[0];
        out[1] = d[1];
        out[2] = d[2];
        out[3] = clamp(sourceHasAlpha ? s[3] : luma(s));
      };
    default:
      throw new Error(`No per-pixel rule for ${operator}`);
  }
}

/** composite `source` onto `target` at (x, y) in place */
export function compositeImage(
  target: Canvas,
  source: Canvas,
  operator: CompositeOperator,
  x: number,
  y: number,
): void {
  const g = context(target);
  const mode = CANVAS_MODES[operator];
  if (mode) {
    g.save();
    g.globalCompositeOperation = mode;
    g.drawImage(source, x, y);
    g.restore();
    return;
  }

  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(target.width, x + source.width);
  const bottom = Math.min(target.height, y + source.height);
  if (right <= left || bottom <= top) return;
  const width = right - left;
  const height = bottom - top;

  const dest = g.getImageData(left, top, width, height);
  const src = context(source).getImageData(left - x, top - y, width, height).data;
  const sourceHasAlpha = hasTransparency(source);
  const op = pixelOp(operator, sourceHasAlpha);
  const s: Pixel = [0, 0, 0, 0];
  const d: Pixel = [0, 0, 0, 0];
  const out: Pixel = [0, 0, 0, 0];
  const data = dest.data;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      s[c] = src[i + c];
      d[c] = data[i + c];
    }
    op(s, d, out);
    for (let c = 0; c < 4; c++) data[i + c] = Math.round(out[c]);
  }
  g.putImageData(dest, left, top);
}

function hasTransparency(canvas: Canvas): boolean {
  const data = context(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}
