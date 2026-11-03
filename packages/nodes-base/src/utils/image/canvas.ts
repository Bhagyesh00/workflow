/**
 * Edit Image: read image headers, check the instance caps, decode into a canvas and encode the result.
 *
 * Caps are checked from the file header BEFORE anything decodes (a small file can claim a huge size), and every
 * new canvas goes through `newCanvas`, so no operation can allocate more pixels than the instance allows.
 */
import { type Canvas, createCanvas, Image, type SKRSContext2D } from '@napi-rs/canvas';
import { Transformer } from '@napi-rs/image';
import type { InstanceLimits } from '@workflow/workflow';

export const IMAGE_FORMATS = ['bmp', 'gif', 'jpeg', 'png', 'tiff', 'webp'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export type ImageLimits = Pick<InstanceLimits, 'maxImagePixels' | 'maxImageInputBytes'>;

/** an error the node shows as it is (no stack, no internals) */
export class ImageError extends Error {
  override name = 'ImageError';
}

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
}

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${Math.round((bytes / MB) * 10) / 10} MB`;
  return `${bytes} bytes`;
}

function megapixels(pixels: number): string {
  const mp = pixels / 1_000_000;
  return String(mp >= 1 ? Math.round(mp * 10) / 10 : Number(mp.toPrecision(2)));
}

// ---------------------------------------------------------------------------------------------
// header readers: format and size from the first bytes, without decoding pixels

const ascii = (data: Uint8Array, start: number, length: number) =>
  data.length >= start + length
    ? Buffer.from(data.buffer, data.byteOffset + start, length).toString('latin1')
    : '';

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function pngHeader(data: Uint8Array): ImageHeader | undefined {
  if (data.length < 24 || ascii(data, 12, 4) !== 'IHDR') return undefined;
  const v = view(data);
  return { format: 'png', width: v.getUint32(16), height: v.getUint32(20) };
}

/**
 * The size a GIF decodes to: the logical screen, grown to cover every frame (the decoder enlarges
 * the image to a frame that lies outside the screen, so the screen size alone can understate it).
 */
function gifHeader(data: Uint8Array): ImageHeader | undefined {
  if (data.length < 10) return undefined;
  const v = view(data);
  let width = v.getUint16(6, true);
  let height = v.getUint16(8, true);
  const tableSize = (packed: number) => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  /** offset just past the data sub-blocks starting at `at` (a zero length byte ends them) */
  const skipSubBlocks = (at: number) => {
    let offset = at;
    while (offset < data.length && data[offset] !== 0) offset += data[offset] + 1;
    return offset + 1;
  };
  let offset = 13 + tableSize(data[10] ?? 0);
  while (offset < data.length) {
    const block = data[offset];
    if (block === 0x21) {
      offset = skipSubBlocks(offset + 2);
    } else if (block === 0x2c) {
      if (offset + 10 > data.length) break;
      const left = v.getUint16(offset + 1, true);
      const top = v.getUint16(offset + 3, true);
      width = Math.max(width, left + v.getUint16(offset + 5, true));
      height = Math.max(height, top + v.getUint16(offset + 7, true));
      // descriptor, local colour table, LZW code size byte, then the image data sub-blocks
      offset = skipSubBlocks(offset + 10 + tableSize(data[offset + 9]) + 1);
    } else {
      break; // trailer (0x3B) or bytes the decoder would reject anyway
    }
  }
  return { format: 'gif', width, height };
}

function jpegHeader(data: Uint8Array): ImageHeader | undefined {
  const v = view(data);
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return undefined;
    let marker = data[offset + 1];
    // fill bytes
    while (marker === 0xff && offset + 2 < data.length) {
      offset++;
      marker = data[offset + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = v.getUint16(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > data.length) return undefined;
      return { format: 'jpeg', height: v.getUint16(offset + 5), width: v.getUint16(offset + 7) };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function webpHeader(data: Uint8Array): ImageHeader | undefined {
  if (data.length < 30) return undefined;
  const v = view(data);
  const chunk = ascii(data, 12, 4);
  if (chunk === 'VP8 ') {
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return undefined;
    return { format: 'webp', width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (data[20] !== 0x2f) return undefined;
    const bits = v.getUint32(21, true);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const width = (data[24] | (data[25] << 8) | (data[26] << 16)) + 1;
    const height = (data[27] | (data[28] << 8) | (data[29] << 16)) + 1;
    return { format: 'webp', width, height };
  }
  return undefined;
}

function bmpHeader(data: Uint8Array): ImageHeader | undefined {
  if (data.length < 26) return undefined;
  const v = view(data);
  const dibSize = v.getUint32(14, true);
  if (dibSize === 12) return { format: 'bmp', width: v.getUint16(18, true), height: v.getUint16(20, true) };
  if (dibSize < 40) return undefined;
  return { format: 'bmp', width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)) };
}

function tiffHeader(data: Uint8Array): ImageHeader | undefined {
  if (data.length < 8) return undefined;
  const v = view(data);
  const little = data[0] === 0x49;
  const ifd = v.getUint32(4, little);
  if (ifd + 2 > data.length) return undefined;
  const count = v.getUint16(ifd, little);
  let width: number | undefined;
  let height: number | undefined;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > data.length) break;
    const tag = v.getUint16(entry, little);
    if (tag !== 256 && tag !== 257) continue;
    const type = v.getUint16(entry + 2, little);
    const value =
      type === 3 ? v.getUint16(entry + 8, little) : type === 4 ? v.getUint32(entry + 8, little) : undefined;
    if (tag === 256) width = value;
    else height = value;
  }
  return width && height ? { format: 'tiff', width, height } : undefined;
}

/** the format and size an image file declares, or undefined when it is not one of the six formats */
export function readImageHeader(data: Uint8Array): ImageHeader | undefined {
  if (data.length < 8) return undefined;
  if (data[0] === 0x89 && ascii(data, 1, 3) === 'PNG') return pngHeader(data);
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return jpegHeader(data);
  const head = ascii(data, 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return gifHeader(data);
  if (head.startsWith('RIFF') && ascii(data, 8, 4) === 'WEBP') return webpHeader(data);
  if (head.startsWith('BM')) return bmpHeader(data);
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return tiffHeader(data);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// caps

export function assertPixels(width: number, height: number, limits: ImageLimits, what = 'The image'): void {
  const pixels = width * height;
  if (pixels > limits.maxImagePixels) {
    throw new ImageError(
      `${what} is ${width} x ${height} pixels (${megapixels(pixels)} megapixels), more than the limit of ` +
        `${megapixels(limits.maxImagePixels)} megapixels`,
    );
  }
}

export function assertInputBytes(size: number, limits: ImageLimits): void {
  if (size > limits.maxImageInputBytes) {
    throw new ImageError(
      `The image file is ${formatBytes(size)}, larger than the limit of ${formatBytes(limits.maxImageInputBytes)}`,
    );
  }
}

/** checks the byte and pixel caps from the file header; nothing is decoded */
export function checkImageInput(data: Uint8Array, limits: ImageLimits): ImageHeader {
  assertInputBytes(data.byteLength, limits);
  const header = readImageHeader(data);
  if (!header || header.width < 1 || header.height < 1) {
    throw new ImageError(`The file is not a supported image (${IMAGE_FORMATS.join(', ')})`);
  }
  assertPixels(header.width, header.height, limits);
  return header;
}

/** a canvas of the given size, refused above the pixel cap */
export function newCanvas(width: number, height: number, limits: ImageLimits, what = 'The result'): Canvas {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw new ImageError(`${what} would be ${w} x ${h} pixels; width and height must be at least 1`);
  }
  assertPixels(w, h, limits, what);
  return createCanvas(w, h);
}

export function context(canvas: Canvas): SKRSContext2D {
  return canvas.getContext('2d');
}

// ---------------------------------------------------------------------------------------------
// decode and encode

function exifOrientation(data: Uint8Array, format: ImageFormat): number | undefined {
  if (format === 'gif' || format === 'bmp') return undefined;
  try {
    return new Transformer(data).metadataSync(true).orientation;
  } catch {
    return undefined;
  }
}

async function loadImage(data: Uint8Array): Promise<Image> {
  const image = new Image();
  try {
    image.src = data;
    await image.decode();
  } catch {
    throw new ImageError(`The file is not a supported image (${IMAGE_FORMATS.join(', ')})`);
  }
  if (!image.width || !image.height) {
    throw new ImageError(`The file is not a supported image (${IMAGE_FORMATS.join(', ')})`);
  }
  return image;
}

export interface DecodedImage {
  canvas: Canvas;
  format: ImageFormat;
}

/**
 * Decode an image after the caps passed: the canvas decoder reads png, jpeg, gif (first frame), webp and bmp;
 * tiff and any image with an EXIF orientation go through the image library, which turns it upright first.
 */
export async function decodeImage(data: Uint8Array, limits: ImageLimits): Promise<DecodedImage> {
  const header = checkImageInput(data, limits);
  const orientation = exifOrientation(data, header.format);
  let source: Uint8Array = data;
  if (header.format === 'tiff' || (orientation !== undefined && orientation > 1 && orientation <= 8)) {
    try {
      source = await new Transformer(data).rotate().png();
    } catch {
      throw new ImageError(`The file is not a supported image (${IMAGE_FORMATS.join(', ')})`);
    }
  }
  const image = await loadImage(source);
  // the decoded size can differ from the header (rotation); check it again before drawing
  const canvas = newCanvas(image.width, image.height, limits, 'The image');
  context(canvas).drawImage(image, 0, 0);
  return { canvas, format: header.format };
}

/** a copy of `canvas` on an opaque background (JPEG has no alpha) */
function flattened(canvas: Canvas, background: string): Canvas {
  const flat = createCanvas(canvas.width, canvas.height);
  const g = flat.getContext('2d');
  g.fillStyle = background;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(canvas, 0, 0);
  return flat;
}

/** quality 0-100 is used for jpeg and webp only, as in n8n */
export async function encodeImage(canvas: Canvas, format: ImageFormat, quality = 100): Promise<Buffer> {
  const q = Math.min(100, Math.max(0, Math.round(quality)));
  switch (format) {
    case 'png':
      return canvas.encode('png');
    case 'jpeg':
      return flattened(canvas, '#ffffff').encode('jpeg', q);
    case 'webp':
      return canvas.encode('webp', q);
    case 'gif':
      return canvas.encode('gif');
    case 'bmp':
    case 'tiff': {
      const pixels = context(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
      const transformer = Transformer.fromRgbaPixels(pixels, canvas.width, canvas.height);
      return format === 'bmp' ? transformer.bmp() : transformer.tiff();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// colours

export type Rgba = [number, number, number, number];

/** '#rgb', '#rgba', '#rrggbb' or '#rrggbbaa' (the editor's colour picker) to 0-255 channels */
export function parseColor(value: unknown, field: string): Rgba {
  const text = String(value ?? '').trim();
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (!hex) throw new ImageError(`"${text}" in "${field}" is not a colour; use a hex colour such as #ff0000`);
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  const channels = full.match(/../g)!.map((pair) => Number.parseInt(pair, 16));
  return [channels[0], channels[1], channels[2], channels[3] ?? 255];
}

export function cssColor([r, g, b, a]: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}
