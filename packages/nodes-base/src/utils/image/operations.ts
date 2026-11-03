/**
 * Edit Image operations: one function per operation, each taking the current canvas and returning the result
 * (a new canvas or the same one changed in place). The field lists here are the node's parameters per
 * operation; the node shows them for its top-level operation and inside every Multi Step step.
 */
import type { Canvas } from '@napi-rs/canvas';
import type { NodeProperty } from '@workflow/workflow';
import { context, cssColor, ImageError, type ImageLimits, newCanvas, parseColor, type Rgba } from './canvas';
import { COMPOSITE_OPERATORS, type CompositeOperator, compositeImage } from './composite';
import { cssFont, DEFAULT_FONT, resolveFont } from './fonts';

export const STEP_OPERATIONS = [
  'blur',
  'border',
  'composite',
  'create',
  'crop',
  'draw',
  'resize',
  'rotate',
  'shear',
  'text',
  'transparent',
] as const;
export type StepOperation = (typeof STEP_OPERATIONS)[number];

export const RESIZE_OPTIONS = [
  'ignoreAspectRatio',
  'maximumArea',
  'minimumArea',
  'onlyIfLarger',
  'onlyIfSmaller',
  'percent',
] as const;
export type ResizeOption = (typeof RESIZE_OPTIONS)[number];

// ---------------------------------------------------------------------------------------------
// parameters

const num = (
  displayName: string,
  name: string,
  value: number,
  extra: Partial<NodeProperty> = {},
): NodeProperty => ({
  displayName,
  name,
  type: 'number',
  default: value,
  ...extra,
});
const color = (displayName: string, name: string, value: string, description?: string): NodeProperty => ({
  displayName,
  name,
  type: 'color',
  default: value,
  ...(description ? { description } : {}),
});

/** the parameters of each operation, with n8n's names and defaults */
export const OPERATION_FIELDS: Record<StepOperation, NodeProperty[]> = {
  blur: [
    num('Blur Radius', 'blurRadius', 5, {
      typeOptions: { minValue: 0, maxValue: 1000 },
      description: 'How strong the blur is, in pixels',
    }),
  ],
  border: [
    num('Border Width', 'borderWidth', 10, {
      typeOptions: { minValue: 0 },
      description: 'Width of the left and right border',
    }),
    num('Border Height', 'borderHeight', 10, {
      typeOptions: { minValue: 0 },
      description: 'Height of the top and bottom border',
    }),
    color('Border Color', 'borderColor', '#000000'),
  ],
  composite: [
    {
      displayName: 'Composite Image Property',
      name: 'dataPropertyNameComposite',
      type: 'string',
      default: '',
      placeholder: 'data2',
      description: 'Name of the binary property that holds the image to composite on top of the image',
    },
    {
      displayName: 'Operator',
      name: 'operator',
      type: 'options',
      default: 'Over',
      description: 'How the composite image is combined with the image',
      options: COMPOSITE_OPERATORS.map((value) => ({ name: value, value })),
    },
    num('Position X', 'positionX', 0, { description: 'X position of the composite image' }),
    num('Position Y', 'positionY', 0, { description: 'Y position of the composite image' }),
  ],
  create: [
    color('Background Color', 'backgroundColor', '#ffffff00', 'Colour of the new image'),
    num('Image Width', 'width', 50, { typeOptions: { minValue: 1 } }),
    num('Image Height', 'height', 50, { typeOptions: { minValue: 1 } }),
  ],
  crop: [
    num('Width', 'width', 500, { typeOptions: { minValue: 1 }, description: 'Width of the cropped area' }),
    num('Height', 'height', 500, { typeOptions: { minValue: 1 }, description: 'Height of the cropped area' }),
    num('Position X', 'positionX', 0, { description: 'X position the crop starts at' }),
    num('Position Y', 'positionY', 0, { description: 'Y position the crop starts at' }),
  ],
  draw: [
    {
      displayName: 'Primitive',
      name: 'primitive',
      type: 'options',
      default: 'rectangle',
      options: [
        { name: 'Circle', value: 'circle' },
        { name: 'Line', value: 'line' },
        { name: 'Rectangle', value: 'rectangle' },
      ],
    },
    color('Color', 'color', '#ff0000', 'Colour of the primitive'),
    num('Start Position X', 'startPositionX', 50, {
      description: 'X of the start point (the centre of a circle)',
    }),
    num('Start Position Y', 'startPositionY', 50, {
      description: 'Y of the start point (the centre of a circle)',
    }),
    num('End Position X', 'endPositionX', 250, { description: 'X of the end point (a point on a circle)' }),
    num('End Position Y', 'endPositionY', 250, { description: 'Y of the end point (a point on a circle)' }),
    num('Corner Radius', 'cornerRadius', 0, {
      typeOptions: { minValue: 0 },
      description: 'Radius of the rectangle corners',
      displayOptions: { show: { primitive: ['rectangle'] } },
    }),
  ],
  resize: [
    num('Width', 'width', 500, { typeOptions: { minValue: 1 }, description: 'New width of the image' }),
    num('Height', 'height', 500, { typeOptions: { minValue: 1 }, description: 'New height of the image' }),
    {
      displayName: 'Option',
      name: 'resizeOption',
      type: 'options',
      default: 'maximumArea',
      description: 'How the width and height are used',
      options: [
        {
          name: 'Ignore Aspect Ratio',
          value: 'ignoreAspectRatio',
          description: 'Resize to exactly the width and height',
        },
        {
          name: 'Maximum Area',
          value: 'maximumArea',
          description: 'At most width x height pixels, aspect ratio kept',
        },
        {
          name: 'Minimum Area',
          value: 'minimumArea',
          description: 'At least the width and the height, aspect ratio kept',
        },
        {
          name: 'Only if Larger',
          value: 'onlyIfLarger',
          description: 'Shrink to fit only if the image is larger',
        },
        {
          name: 'Only if Smaller',
          value: 'onlyIfSmaller',
          description: 'Enlarge to fit only if the image is smaller',
        },
        { name: 'Percent', value: 'percent', description: 'Width and height are percentages of the image' },
      ],
    },
  ],
  rotate: [
    num('Rotate', 'rotate', 0, {
      typeOptions: { minValue: -360, maxValue: 360 },
      description: 'Degrees to rotate the image clockwise',
    }),
    color(
      'Background Color',
      'backgroundColor',
      '#ffffffff',
      'Colour of the corners an angle that is not a multiple of 90 opens',
    ),
  ],
  shear: [
    num('Degrees X', 'degreesX', 0, { description: 'Degrees to shear along the X axis' }),
    num('Degrees Y', 'degreesY', 0, { description: 'Degrees to shear along the Y axis' }),
  ],
  text: [
    {
      displayName: 'Text',
      name: 'text',
      type: 'string',
      default: '',
      typeOptions: { rows: 2 },
      placeholder: 'Text to write',
    },
    num('Font Size', 'fontSize', 18, { typeOptions: { minValue: 1 } }),
    color('Font Color', 'fontColor', '#000000'),
    num('Position X', 'positionX', 50, { description: 'X position of the text' }),
    num('Position Y', 'positionY', 50, { description: 'Y position of the text' }),
    {
      displayName: 'Horizontal Alignment',
      name: 'horizontalAlignment',
      type: 'options',
      default: 'center',
      options: [
        { name: 'Left', value: 'left' },
        { name: 'Center', value: 'center' },
        { name: 'Right', value: 'right' },
      ],
    },
    {
      displayName: 'Vertical Alignment',
      name: 'verticalAlignment',
      type: 'options',
      default: 'middle',
      options: [
        { name: 'Top', value: 'top' },
        { name: 'Middle', value: 'middle' },
        { name: 'Bottom', value: 'bottom' },
      ],
    },
    num('Max Line Length', 'lineLength', 80, {
      typeOptions: { minValue: 1 },
      description: 'Characters per line; longer text wraps at spaces',
    }),
    {
      displayName: 'Font Name or ID',
      name: 'font',
      type: 'options',
      default: DEFAULT_FONT,
      typeOptions: { loadOptionsMethod: 'getFonts' },
      description: 'The bundled Liberation Sans or a font installed on the server',
    },
  ],
  transparent: [color('Color', 'color', '#ff0000', 'The colour to make transparent')],
};

/** reads one operation's parameters, with its defaults, and checks their types */
export class OperationParams {
  constructor(
    readonly operation: StepOperation,
    private readonly read: (name: string, fallback: unknown) => unknown,
  ) {}

  private field(name: string): NodeProperty | undefined {
    return OPERATION_FIELDS[this.operation].find((f) => f.name === name);
  }

  value(name: string): unknown {
    const value = this.read(name, this.field(name)?.default);
    return value === undefined || value === null ? this.field(name)?.default : value;
  }

  number(name: string): number {
    const raw = this.value(name);
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ImageError(
        `The value "${String(raw)}" of "${this.field(name)?.displayName ?? name}" is not a number`,
      );
    }
    return value;
  }

  text(name: string): string {
    const value = this.value(name);
    return value === undefined || value === null ? '' : String(value);
  }

  color(name: string): Rgba {
    return parseColor(this.value(name), this.field(name)?.displayName ?? name);
  }
}

export interface OperationEnv {
  limits: ImageLimits;
  /** the decoded image of another binary property of the same item (checked against the caps) */
  loadImage(property: string): Promise<Canvas>;
}

type Operation = (canvas: Canvas, params: OperationParams, env: OperationEnv) => Canvas | Promise<Canvas>;

// ---------------------------------------------------------------------------------------------
// operations

const BLUR_MAX_PAD = 256;

/**
 * Edge padding for a blur: up to three times the radius (at most 256 px), and never so much that
 * the padded canvas passes the pixel cap (a thin image near the cap gains a lot of area per pixel
 * of padding).
 */
export function blurPad(width: number, height: number, radius: number, limits: ImageLimits): number {
  const wanted = Math.min(Math.ceil(radius * 3), BLUR_MAX_PAD, Math.max(width, height));
  // largest p with (w + 2p)(h + 2p) <= cap: 4p^2 + 2p(w + h) + wh - cap <= 0
  const sum = width + height;
  const spare = limits.maxImagePixels - width * height;
  if (spare <= 0) return 0;
  let fit = Math.floor((-sum + Math.sqrt(sum * sum + 4 * spare)) / 4);
  while (fit > 0 && (width + 2 * fit) * (height + 2 * fit) > limits.maxImagePixels) fit--;
  return Math.max(0, Math.min(wanted, fit));
}

/** gaussian blur; the edges are extended first, so an opaque image stays opaque at its border */
function blur(canvas: Canvas, params: OperationParams, env: OperationEnv): Canvas {
  const radius = Math.min(1000, params.number('blurRadius'));
  if (radius <= 0) return canvas;
  const { width: w, height: h } = canvas;
  const pad = blurPad(w, h, radius, env.limits);
  // temp canvases go through the cap as well
  const padded = newCanvas(w + 2 * pad, h + 2 * pad, env.limits);
  const pg = padded.getContext('2d');
  pg.imageSmoothingEnabled = false;
  pg.drawImage(canvas, pad, pad);
  pg.drawImage(canvas, 0, 0, w, 1, pad, 0, w, pad);
  pg.drawImage(canvas, 0, h - 1, w, 1, pad, pad + h, w, pad);
  pg.drawImage(canvas, 0, 0, 1, h, 0, pad, pad, h);
  pg.drawImage(canvas, w - 1, 0, 1, h, pad + w, pad, pad, h);
  pg.drawImage(canvas, 0, 0, 1, 1, 0, 0, pad, pad);
  pg.drawImage(canvas, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  pg.drawImage(canvas, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  pg.drawImage(canvas, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);

  const blurred = newCanvas(padded.width, padded.height, env.limits);
  const bg = blurred.getContext('2d');
  bg.filter = `blur(${radius}px)`;
  bg.drawImage(padded, 0, 0);

  const out = newCanvas(w, h, env.limits);
  out.getContext('2d').drawImage(blurred, -pad, -pad);
  return out;
}

function border(canvas: Canvas, params: OperationParams, env: OperationEnv): Canvas {
  const bw = Math.max(0, Math.round(params.number('borderWidth')));
  const bh = Math.max(0, Math.round(params.number('borderHeight')));
  const fill = params.color('borderColor');
  const out = newCanvas(canvas.width + 2 * bw, canvas.height + 2 * bh, env.limits);
  const g = context(out);
  g.fillStyle = cssColor(fill);
  g.fillRect(0, 0, out.width, out.height);
  g.clearRect(bw, bh, canvas.width, canvas.height);
  g.drawImage(canvas, bw, bh);
  return out;
}

async function composite(canvas: Canvas, params: OperationParams, env: OperationEnv): Promise<Canvas> {
  const property = params.text('dataPropertyNameComposite').trim();
  if (!property) throw new ImageError('Set the binary property of the composite image');
  const operator = params.text('operator') as CompositeOperator;
  if (!COMPOSITE_OPERATORS.includes(operator))
    throw new ImageError(`Unknown composite operator "${operator}"`);
  const x = Math.round(params.number('positionX'));
  const y = Math.round(params.number('positionY'));
  const source = await env.loadImage(property);
  compositeImage(canvas, source, operator, x, y);
  return canvas;
}

function create(_canvas: Canvas | undefined, params: OperationParams, env: OperationEnv): Canvas {
  const width = params.number('width');
  const height = params.number('height');
  const fill = params.color('backgroundColor');
  const out = newCanvas(width, height, env.limits);
  const g = context(out);
  g.fillStyle = cssColor(fill);
  g.fillRect(0, 0, out.width, out.height);
  return out;
}

function crop(canvas: Canvas, params: OperationParams, env: OperationEnv): Canvas {
  const width = Math.round(params.number('width'));
  const height = Math.round(params.number('height'));
  const x = Math.round(params.number('positionX'));
  const y = Math.round(params.number('positionY'));
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(canvas.width, x + width);
  const bottom = Math.min(canvas.height, y + height);
  if (right <= left || bottom <= top) throw new ImageError('The crop area is outside the image');
  const out = newCanvas(right - left, bottom - top, env.limits);
  context(out).drawImage(canvas, -left, -top);
  return out;
}

function draw(canvas: Canvas, params: OperationParams): Canvas {
  const primitive = params.text('primitive');
  const fill = cssColor(params.color('color'));
  const sx = params.number('startPositionX');
  const sy = params.number('startPositionY');
  const ex = params.number('endPositionX');
  const ey = params.number('endPositionY');
  const g = context(canvas);
  g.save();
  g.fillStyle = fill;
  g.strokeStyle = fill;
  if (primitive === 'rectangle') {
    const radius = Math.max(0, params.number('cornerRadius'));
    const x = Math.min(sx, ex);
    const y = Math.min(sy, ey);
    const w = Math.abs(ex - sx);
    const h = Math.abs(ey - sy);
    g.beginPath();
    if (radius > 0) g.roundRect(x, y, w, h, radius);
    else g.rect(x, y, w, h);
    g.fill();
  } else if (primitive === 'circle') {
    g.beginPath();
    g.arc(sx, sy, Math.hypot(ex - sx, ey - sy), 0, Math.PI * 2);
    g.fill();
  } else if (primitive === 'line') {
    // through the pixel centres, so a 1 px line is crisp
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(sx + 0.5, sy + 0.5);
    g.lineTo(ex + 0.5, ey + 0.5);
    g.stroke();
  } else {
    g.restore();
    throw new ImageError(`Unknown primitive "${primitive}"`);
  }
  g.restore();
  return canvas;
}

/** the size after a resize, with gm's geometry rules for each option */
export function resizeTarget(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  option: ResizeOption,
): [number, number] {
  const scaled = (scale: number): [number, number] => [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
  switch (option) {
    case 'ignoreAspectRatio':
      return [targetWidth, targetHeight];
    case 'percent':
      return [
        Math.max(1, Math.round((width * targetWidth) / 100)),
        Math.max(1, Math.round((height * targetHeight) / 100)),
      ];
    case 'maximumArea':
      return width * height > targetWidth * targetHeight
        ? scaled(Math.sqrt((targetWidth * targetHeight) / (width * height)))
        : [width, height];
    case 'minimumArea':
      return scaled(Math.max(targetWidth / width, targetHeight / height));
    case 'onlyIfLarger':
      return width > targetWidth || height > targetHeight
        ? scaled(Math.min(targetWidth / width, targetHeight / height))
        : [width, height];
    case 'onlyIfSmaller':
      return width < targetWidth && height < targetHeight
        ? scaled(Math.min(targetWidth / width, targetHeight / height))
        : [width, height];
  }
}

function resize(canvas: Canvas, params: OperationParams, env: OperationEnv): Canvas {
  const width = Math.round(params.number('width'));
  const height = Math.round(params.number('height'));
  const option = params.text('resizeOption') as ResizeOption;
  if (!RESIZE_OPTIONS.includes(option)) throw new ImageError(`Unknown resize option "${option}"`);
  if (width < 1 || height < 1) throw new ImageError('Width and height must be at least 1');
  const [tw, th] = resizeTarget(canvas.width, canvas.height, width, height, option);
  if (tw === canvas.width && th === canvas.height) return canvas;
  const out = newCanvas(tw, th, env.limits);
  const g = context(out);
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, tw, th);
  return out;
}

/** a size from a floating point bound, without turning 20.000000001 into 21 */
const span = (value: number) => Math.max(1, Math.ceil(value - 1e-6));

function rotate(canvas: Canvas, params: OperationParams, env: OperationEnv): Canvas {
  const degrees = params.number('rotate');
  const turn = ((degrees % 360) + 360) % 360;
  if (turn === 0) return canvas;
  const { width: w, height: h } = canvas;
  if (turn % 90 === 0) {
    const quarter = turn / 90;
    const out = newCanvas(quarter === 2 ? w : h, quarter === 2 ? h : w, env.limits);
    const g = context(out);
    if (quarter === 1) g.setTransform(0, 1, -1, 0, h, 0);
    else if (quarter === 2) g.setTransform(-1, 0, 0, -1, w, h);
    else g.setTransform(0, -1, 1, 0, 0, w);
    g.drawImage(canvas, 0, 0);
    return out;
  }
  const fill = params.color('backgroundColor');
  const radians = (turn * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const out = newCanvas(span(w * cos + h * sin), span(w * sin + h * cos), env.limits);
  const g = context(out);
  g.fillStyle = cssColor(fill);
  g.fillRect(0, 0, out.width, out.height);
  g.translate(out.width / 2, out.height / 2);
  g.rotate(radians);
  g.drawImage(canvas, -w / 2, -h / 2);
  return out;
}

function shear(canvas: Canvas, params: OperationParams, env: OperationEnv): Canvas {
  const degreesX = params.number('degreesX');
  const degreesY = params.number('degreesY');
  if (Math.abs(degreesX) >= 90 || Math.abs(degreesY) >= 90) {
    throw new ImageError('Shear angles must be between -90 and 90 degrees');
  }
  if (degreesX === 0 && degreesY === 0) return canvas;
  // shear along X, then along Y: x' = x + tx*y, y' = ty*x' + y
  const tx = Math.tan((degreesX * Math.PI) / 180);
  const ty = Math.tan((degreesY * Math.PI) / 180);
  const a = 1;
  const b = ty;
  const c = tx;
  const d = 1 + tx * ty;
  const { width: w, height: h } = canvas;
  const xs = [0, a * w, c * h, a * w + c * h];
  const ys = [0, b * w, d * h, b * w + d * h];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const out = newCanvas(span(Math.max(...xs) - minX), span(Math.max(...ys) - minY), env.limits);
  const g = context(out);
  g.setTransform(a, b, c, d, -minX, -minY);
  g.drawImage(canvas, 0, 0);
  return out;
}

/** splits text into lines of at most `length` characters at spaces; a longer word keeps its own line */
export function wrapText(text: string, length: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= length) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function text(canvas: Canvas, params: OperationParams): Canvas {
  const value = params.text('text');
  if (!value) return canvas;
  const size = params.number('fontSize');
  if (size <= 0) throw new ImageError('The font size must be more than 0');
  const fill = cssColor(params.color('fontColor'));
  const x = params.number('positionX');
  const y = params.number('positionY');
  const lineLength = Math.max(1, Math.round(params.number('lineLength')));
  const family = resolveFont(params.value('font'));
  const horizontal = params.text('horizontalAlignment');
  const vertical = params.text('verticalAlignment');

  const lines = wrapText(value, lineLength);
  const lineHeight = size * 1.2;
  const block = lines.length * lineHeight;
  const top = vertical === 'top' ? y : vertical === 'bottom' ? y - block : y - block / 2;

  const g = context(canvas);
  g.save();
  g.font = cssFont(size, family);
  g.fillStyle = fill;
  g.textAlign = horizontal === 'left' || horizontal === 'right' ? horizontal : 'center';
  g.textBaseline = 'top';
  lines.forEach((line, i) => {
    g.fillText(line, x, top + i * lineHeight + (lineHeight - size) / 2);
  });
  g.restore();
  return canvas;
}

function transparent(canvas: Canvas, params: OperationParams): Canvas {
  const [r, gr, b] = params.color('color');
  const g = context(canvas);
  const image = g.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  let changed = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0 && data[i] === r && data[i + 1] === gr && data[i + 2] === b) {
      data[i + 3] = 0;
      changed = true;
    }
  }
  if (changed) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.putImageData(image, 0, 0);
  }
  return canvas;
}

const OPERATIONS: Record<StepOperation, Operation> = {
  blur,
  border,
  composite,
  create,
  crop,
  draw,
  resize,
  rotate,
  shear,
  text,
  transparent,
};

/** runs one operation; `canvas` is undefined only before a create step */
export async function applyOperation(
  canvas: Canvas | undefined,
  params: OperationParams,
  env: OperationEnv,
): Promise<Canvas> {
  if (params.operation === 'create') return create(canvas, params, env);
  if (!canvas)
    throw new ImageError(`"${params.operation}" needs an image; start with Create or an input image`);
  return OPERATIONS[params.operation](canvas, params, env);
}
