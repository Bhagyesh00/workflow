/** P2-05 Edit Image: operations, formats, composite operators, text, caps and errors. */
import { createCanvas, Image, type SKRSContext2D } from '@napi-rs/canvas';
import { Transformer } from '@napi-rs/image';
import type { BinaryData, DataObject, Item, LoadOptionsContext } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { EditImageNode } from '../src/nodes/core/EditImage.node';
import { readImageHeader } from '../src/utils/image/canvas';
import { blurPad } from '../src/utils/image/operations';
import { runNode } from './harness';

// ---------------------------------------------------------------------------------------------
// helpers

type Rgba = [number, number, number, number];

async function png(
  width: number,
  height: number,
  paint: string | ((g: SKRSContext2D) => void),
): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const g = canvas.getContext('2d');
  if (typeof paint === 'string') {
    g.fillStyle = paint;
    g.fillRect(0, 0, width, height);
  } else paint(g);
  return canvas.encode('png');
}

function imageItem(
  data: Uint8Array,
  fileName = 'photo.png',
  mimeType = 'image/png',
  extra: Item['binary'] = {},
): Item {
  return {
    json: { keep: 1 },
    binary: { data: { data: Buffer.from(data).toString('base64'), mimeType, fileName }, ...extra },
  };
}

function binaryOf(data: Uint8Array, mimeType = 'image/png'): BinaryData {
  return { data: Buffer.from(data).toString('base64'), mimeType };
}

function run(
  parameters: DataObject,
  input: Item[],
  options: { limits?: Record<string, number>; continueOnFail?: boolean } = {},
) {
  return runNode('core.editImage', parameters, input, {
    ...(options.limits ? { services: { nodeLimits: options.limits } } : {}),
    ...(options.continueOnFail ? { node: { onError: 'continueRegularOutput' } } : {}),
  });
}

function output(r: Awaited<ReturnType<typeof run>>, index = 0, property = 'data'): BinaryData {
  expect(r.error?.message).toBeUndefined();
  expect(r.status).toBe('success');
  const binary = r.items[0][index].binary?.[property];
  expect(binary, `binary "${property}" on item ${index}`).toBeDefined();
  return binary!;
}

const bytesOf = (binary: BinaryData) => Buffer.from(binary.data, 'base64');

/** decode any output (tiff through the image library) and read pixels */
async function decoded(data: Buffer) {
  const source =
    data.subarray(0, 4).toString('latin1') === 'II*\0' ? await new Transformer(data).png() : data;
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = createCanvas(image.width, image.height);
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    at: (x: number, y: number): Rgba => Array.from(g.getImageData(x, y, 1, 1).data) as Rgba,
  };
}

function expectColor(actual: Rgba, expected: Rgba, tolerance = 2) {
  for (let c = 0; c < 4; c++) {
    expect(
      Math.abs(actual[c] - expected[c]),
      `channel ${c}: got ${actual} want ${expected}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  bmp: (b) => b.subarray(0, 2).toString('latin1') === 'BM',
  tiff: (b) =>
    b.subarray(0, 4).toString('latin1') === 'II*\0' || b.subarray(0, 4).toString('latin1') === 'MM\0*',
  webp: (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** a JPEG with an EXIF APP1 segment that holds only the orientation tag */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II*\0', 0, 'latin1');
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const marker = Buffer.from([0xff, 0xe1, 0, 0]);
  marker.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, body, jpeg.subarray(2)]);
}

/** a PNG whose header claims a huge size; it has no real pixel data */
function hugePngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr, Buffer.alloc(16)]);
}

// ---------------------------------------------------------------------------------------------

describe('Edit Image: output format and size', () => {
  for (const format of ['bmp', 'gif', 'jpeg', 'png', 'tiff', 'webp']) {
    it(`writes ${format} with the requested size, magic bytes, mime type and extension`, async () => {
      const input = await png(40, 20, '#3366cc');
      const r = await run(
        {
          operation: 'resize',
          width: 10,
          height: 30,
          resizeOption: 'ignoreAspectRatio',
          options: { format },
        },
        [imageItem(input)],
      );
      const binary = output(r);
      const data = bytesOf(binary);
      expect(MAGIC[format](data), `${format} magic ${data.subarray(0, 12).toString('hex')}`).toBe(true);
      expect(binary.mimeType).toBe(`image/${format}`);
      expect(binary.fileExtension).toBe(format);
      expect(binary.fileName).toBe(`photo.${format}`);
      const image = await decoded(data);
      expect([image.width, image.height]).toEqual([10, 30]);
      expect(r.items[0][0].json).toEqual({ keep: 1 });
    });
  }

  it('keeps the input format when no format is set, and create writes png', async () => {
    const canvas = createCanvas(30, 20);
    canvas.getContext('2d').fillRect(0, 0, 30, 20);
    const jpeg = await canvas.encode('jpeg', 90);
    const r = await run({ operation: 'resize', width: 15, height: 10, resizeOption: 'ignoreAspectRatio' }, [
      imageItem(jpeg, 'in.jpg', 'image/jpeg'),
    ]);
    const out = output(r);
    expect(MAGIC.jpeg(bytesOf(out))).toBe(true);
    expect(out.mimeType).toBe('image/jpeg');

    const created = await run({ operation: 'create', width: 40, height: 30, backgroundColor: '#00ff00ff' }, [
      { json: {} },
    ]);
    const createdOut = output(created);
    expect(MAGIC.png(bytesOf(createdOut))).toBe(true);
    const image = await decoded(bytesOf(createdOut));
    expect([image.width, image.height]).toEqual([40, 30]);
    expectColor(image.at(20, 15), [0, 255, 0, 255]);
  });

  it('applies the jpeg quality', async () => {
    const input = await png(120, 120, (g) => {
      for (let i = 0; i < 3000; i++) {
        g.fillStyle = `rgb(${i % 255},${(i * 7) % 255},${(i * 13) % 255})`;
        g.fillRect((i * 37) % 120, (i * 53) % 120, 3, 3);
      }
    });
    const size = async (quality: number) =>
      bytesOf(
        output(
          await run(
            {
              operation: 'resize',
              width: 100,
              height: 100,
              resizeOption: 'percent',
              options: { format: 'jpeg', quality },
            },
            [imageItem(input)],
          ),
        ),
      ).length;
    expect(await size(10)).toBeLessThan((await size(100)) / 2);
  });

  it('writes to the destination key and file name options, keeping other binaries', async () => {
    const input = await png(20, 20, '#ff0000');
    const item = imageItem(input, 'photo.png', 'image/png', {
      other: binaryOf(Buffer.from('x'), 'text/plain'),
    });
    const r = await run(
      {
        operation: 'border',
        borderWidth: 1,
        borderHeight: 1,
        options: { destinationKey: 'framed', fileName: 'framed.png' },
      },
      [item],
    );
    const out = output(r, 0, 'framed');
    expect(out.fileName).toBe('framed.png');
    const binary = r.items[0][0].binary!;
    expect(Object.keys(binary).sort()).toEqual(['data', 'framed', 'other']);
    expect(binary.data.data).toBe(item.binary!.data.data);
  });
});

describe('Edit Image: operations', () => {
  it('resize options follow n8n (gm) geometry flags', async () => {
    const input = await png(200, 100, '#888888');
    const size = async (width: number, height: number, resizeOption: string) => {
      const image = await decoded(
        bytesOf(output(await run({ operation: 'resize', width, height, resizeOption }, [imageItem(input)]))),
      );
      return [image.width, image.height];
    };
    expect(await size(100, 50, 'ignoreAspectRatio')).toEqual([100, 50]);
    expect(await size(50, 50, 'percent')).toEqual([100, 50]);
    expect(await size(100, 100, 'onlyIfLarger')).toEqual([100, 50]);
    expect(await size(500, 500, 'onlyIfLarger')).toEqual([200, 100]);
    expect(await size(400, 400, 'onlyIfSmaller')).toEqual([400, 200]);
    expect(await size(100, 100, 'onlyIfSmaller')).toEqual([200, 100]);
    expect(await size(100, 100, 'minimumArea')).toEqual([200, 100]);
    expect(await size(400, 100, 'minimumArea')).toEqual([400, 200]);
    // maximum area: at most width x height pixels, aspect kept, never enlarged
    expect(await size(100, 100, 'maximumArea')).toEqual([141, 71]);
    expect(await size(500, 500, 'maximumArea')).toEqual([200, 100]);
  });

  it('crops to the requested size and offset', async () => {
    const input = await png(100, 80, (g) => {
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 100, 80);
      g.fillStyle = '#0000ff';
      g.fillRect(10, 10, 20, 20);
    });
    const image = await decoded(
      bytesOf(
        output(
          await run({ operation: 'crop', width: 50, height: 40, positionX: 10, positionY: 10 }, [
            imageItem(input),
          ]),
        ),
      ),
    );
    expect([image.width, image.height]).toEqual([50, 40]);
    expectColor(image.at(5, 5), [0, 0, 255, 255]);
    expectColor(image.at(30, 30), [255, 0, 0, 255]);
    // a crop that runs past the edge is clipped to the image
    const clipped = await decoded(
      bytesOf(
        output(
          await run({ operation: 'crop', width: 500, height: 500, positionX: 60, positionY: 70 }, [
            imageItem(input),
          ]),
        ),
      ),
    );
    expect([clipped.width, clipped.height]).toEqual([40, 10]);
  });

  it('rotates: 90 degrees swaps the sides, 45 degrees fills the corners with the background colour', async () => {
    const input = await png(60, 20, '#ff0000');
    const quarter = await decoded(
      bytesOf(output(await run({ operation: 'rotate', rotate: 90 }, [imageItem(input)]))),
    );
    expect([quarter.width, quarter.height]).toEqual([20, 60]);
    const square = await png(40, 40, '#ff0000');
    const tilted = await decoded(
      bytesOf(
        output(
          await run({ operation: 'rotate', rotate: 45, backgroundColor: '#00ff00ff' }, [imageItem(square)]),
        ),
      ),
    );
    expect(tilted.width).toBeGreaterThanOrEqual(56);
    expect(tilted.width).toBeLessThanOrEqual(58);
    expectColor(tilted.at(1, 1), [0, 255, 0, 255]);
    expectColor(tilted.at(tilted.width >> 1, tilted.height >> 1), [255, 0, 0, 255]);
  });

  it('adds a border of the given width, height and colour', async () => {
    const input = await png(30, 20, '#ffffff');
    const image = await decoded(
      bytesOf(
        output(
          await run({ operation: 'border', borderWidth: 10, borderHeight: 5, borderColor: '#0000ff' }, [
            imageItem(input),
          ]),
        ),
      ),
    );
    expect([image.width, image.height]).toEqual([50, 30]);
    expectColor(image.at(2, 2), [0, 0, 255, 255]);
    expectColor(image.at(25, 15), [255, 255, 255, 255]);
  });

  it('draws a rectangle, a line and a circle', async () => {
    const input = await png(100, 100, '#ffffff');
    const draw = async (parameters: DataObject) =>
      decoded(bytesOf(output(await run({ operation: 'draw', ...parameters }, [imageItem(input)]))));
    const rect = await draw({
      primitive: 'rectangle',
      color: '#ff0000',
      startPositionX: 10,
      startPositionY: 10,
      endPositionX: 40,
      endPositionY: 30,
    });
    expectColor(rect.at(20, 20), [255, 0, 0, 255]);
    expectColor(rect.at(50, 50), [255, 255, 255, 255]);
    const circle = await draw({
      primitive: 'circle',
      color: '#00ff00',
      startPositionX: 50,
      startPositionY: 50,
      endPositionX: 70,
      endPositionY: 50,
    });
    expectColor(circle.at(50, 50), [0, 255, 0, 255]);
    expectColor(circle.at(64, 50), [0, 255, 0, 255]);
    expectColor(circle.at(85, 50), [255, 255, 255, 255]);
    const line = await draw({
      primitive: 'line',
      color: '#0000ff',
      startPositionX: 0,
      startPositionY: 50,
      endPositionX: 100,
      endPositionY: 50,
    });
    const onLine = line.at(50, 50);
    expect(onLine[2]).toBeGreaterThan(200);
    expect(onLine[0]).toBeLessThan(200);
    expectColor(line.at(50, 20), [255, 255, 255, 255]);
  });

  it('makes one colour transparent', async () => {
    const input = await png(20, 10, (g) => {
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 10, 10);
      g.fillStyle = '#00ff00';
      g.fillRect(10, 0, 10, 10);
    });
    const image = await decoded(
      bytesOf(output(await run({ operation: 'transparent', color: '#ff0000' }, [imageItem(input)]))),
    );
    expect(image.at(5, 5)[3]).toBe(0);
    expectColor(image.at(15, 5), [0, 255, 0, 255]);
  });

  it('blurs a sharp edge and keeps opaque edges opaque', async () => {
    const input = await png(40, 20, (g) => {
      g.fillStyle = '#000000';
      g.fillRect(0, 0, 20, 20);
      g.fillStyle = '#ffffff';
      g.fillRect(20, 0, 20, 20);
    });
    const image = await decoded(
      bytesOf(output(await run({ operation: 'blur', blurRadius: 3 }, [imageItem(input)]))),
    );
    const edge = image.at(20, 10);
    expect(edge[0]).toBeGreaterThan(30);
    expect(edge[0]).toBeLessThan(225);
    expect(image.at(0, 0)[3]).toBe(255);
    expectColor(image.at(39, 19), [255, 255, 255, 255], 3);
  });

  it('shears by the given angles', async () => {
    const input = await png(40, 20, '#ff0000');
    const image = await decoded(
      bytesOf(output(await run({ operation: 'shear', degreesX: 45, degreesY: 0 }, [imageItem(input)]))),
    );
    expect(image.width).toBeGreaterThanOrEqual(59);
    expect(image.width).toBeLessThanOrEqual(61);
    expect(image.height).toBe(20);
  });

  it('multiStep applies the steps in order', async () => {
    const input = await png(200, 100, '#ff0000');
    const r = await run(
      {
        operation: 'multiStep',
        operations: {
          operations: [
            { operation: 'resize', width: 100, height: 20, resizeOption: 'ignoreAspectRatio' },
            { operation: 'rotate', rotate: 90 },
            { operation: 'border', borderWidth: 5, borderHeight: 0, borderColor: '#000000' },
          ],
        },
        options: { format: 'png' },
      },
      [imageItem(input)],
    );
    const image = await decoded(bytesOf(output(r)));
    expect([image.width, image.height]).toEqual([30, 100]);
  });

  it('information returns the format and size without changing the binary', async () => {
    const input = await png(64, 32, '#123456');
    const r = await run({ operation: 'information' }, [imageItem(input)]);
    expect(r.status).toBe('success');
    expect(r.items[0][0].json).toMatchObject({
      format: 'PNG',
      mimeType: 'image/png',
      size: { width: 64, height: 32 },
    });
    expect(r.items[0][0].binary?.data.data).toBe(Buffer.from(input).toString('base64'));
  });

  it('turns a JPEG upright from its EXIF orientation', async () => {
    const canvas = createCanvas(40, 20);
    canvas.getContext('2d').fillRect(0, 0, 40, 20);
    const jpeg = withOrientation(await canvas.encode('jpeg', 95), 6);
    const image = await decoded(
      bytesOf(
        output(
          await run(
            {
              operation: 'resize',
              width: 100,
              height: 100,
              resizeOption: 'percent',
              options: { format: 'png' },
            },
            [imageItem(jpeg, 'in.jpg', 'image/jpeg')],
          ),
        ),
      ),
    );
    expect([image.width, image.height]).toEqual([20, 40]);
  });
});

describe('Edit Image: text', () => {
  it('draws text with the bundled font by default', async () => {
    const input = await png(200, 60, '#ffffff');
    const r = await run(
      {
        operation: 'text',
        text: 'Hello world',
        fontSize: 24,
        fontColor: '#000000',
        positionX: 100,
        positionY: 30,
      },
      [imageItem(input)],
    );
    const image = await decoded(bytesOf(output(r)));
    let dark = 0;
    for (let x = 0; x < 200; x += 2) for (let y = 0; y < 60; y += 2) if (image.at(x, y)[0] < 128) dark++;
    expect(dark).toBeGreaterThan(20);
  });

  it('wraps long text at spaces by the line length', async () => {
    const input = await png(300, 200, '#ffffff');
    const rows = async (lineLength: number) => {
      const image = await decoded(
        bytesOf(
          output(
            await run(
              {
                operation: 'text',
                text: 'one two three four five six',
                fontSize: 20,
                positionX: 150,
                positionY: 100,
                lineLength,
              },
              [imageItem(input)],
            ),
          ),
        ),
      );
      let inked = 0;
      for (let y = 0; y < 200; y++) {
        let row = false;
        for (let x = 0; x < 300; x += 1) if (image.at(x, y)[0] < 128) row = true;
        if (row) inked++;
      }
      return inked;
    };
    expect(await rows(5)).toBeGreaterThan((await rows(80)) * 3);
  });

  it('lists the bundled font and system font names, and refuses an unknown font', async () => {
    const fonts = await EditImageNode.methods!.loadOptions!.getFonts({} as LoadOptionsContext);
    const names = fonts.map((f) => f.name);
    expect(names).toContain('Liberation Sans');
    expect(
      fonts.every(
        (f) => f.name === f.value && !String(f.value).includes('/') && !String(f.value).includes('\\'),
      ),
    ).toBe(true);
    const input = await png(50, 50, '#ffffff');
    const r = await run({ operation: 'text', text: 'x', font: 'No Such Font 123' }, [imageItem(input)]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('No Such Font 123');
  });
});

// ---------------------------------------------------------------------------------------------
// composite: dest 4x4 of D, source 2x2 of S at (1,1)

const D: Rgba = [200, 100, 50, 255];
const S: Rgba = [100, 150, 250, 255];
const lumaS = (0.299 * 100 + 0.587 * 150 + 0.114 * 250) / 255;

const OPAQUE_EXPECTED: Record<string, Rgba> = {
  Over: S,
  Atop: S,
  Difference: [100, 50, 200, 255],
  Copy: S,
  In: S,
  Out: [0, 0, 0, 0],
  Xor: [0, 0, 0, 0],
  Plus: [255, 250, 255, 255],
  Add: [44, 250, 44, 255],
  Subtract: [156, 50, 200, 255],
  Minus: [0, 50, 200, 255],
  Multiply: [78, 59, 49, 255],
  Divide: [255, 170, 51, 255],
  Bumpmap: [Math.round(200 * lumaS), Math.round(100 * lumaS), Math.round(50 * lumaS), 255],
  CopyRed: [100, 100, 50, 255],
  CopyGreen: [200, 150, 50, 255],
  CopyBlue: [200, 100, 250, 255],
  CopyOpacity: [200, 100, 50, Math.round(255 * lumaS)],
  CopyCyan: [80, 100, 50, 255],
  CopyMagenta: [200, 120, 50, 255],
  CopyYellow: [200, 100, 200, 255],
  CopyBlack: [250, 125, 62, 255],
};

async function compositeRun(operator: string, dest: Buffer, source: Buffer, x = 1, y = 1) {
  const item = imageItem(dest, 'base.png', 'image/png', { overlay: binaryOf(source) });
  const r = await run(
    { operation: 'composite', dataPropertyNameComposite: 'overlay', operator, positionX: x, positionY: y },
    [item],
  );
  return decoded(bytesOf(output(r)));
}

describe('Edit Image: composite operators', () => {
  it('offers exactly the 22 n8n operators', () => {
    const operator = EditImageNode.description.properties.find((p) => p.name === 'operator');
    const values = (operator?.options ?? []).map((o) => (o as { value: string }).value).sort();
    expect(values).toEqual(Object.keys(OPAQUE_EXPECTED).sort());
  });

  for (const [operator, expected] of Object.entries(OPAQUE_EXPECTED)) {
    it(`${operator} on opaque pixels, only inside the overlap`, async () => {
      const dest = await png(4, 4, `rgb(${D[0]},${D[1]},${D[2]})`);
      const source = await png(2, 2, `rgb(${S[0]},${S[1]},${S[2]})`);
      const image = await compositeRun(operator, dest, source);
      expect([image.width, image.height]).toEqual([4, 4]);
      const got = image.at(1, 1);
      if (expected[3] === 0) expect(got[3]).toBe(0);
      else expectColor(got, expected);
      expectColor(image.at(0, 0), D);
      expectColor(image.at(3, 3), D);
    });
  }

  it('alpha rules: In, Out, Xor, Atop and Over against a transparent destination half', async () => {
    // dest: left half (x < 2) opaque D, right half transparent; source S covers x 1..2
    const dest = await png(4, 4, (g) => {
      g.fillStyle = `rgb(${D[0]},${D[1]},${D[2]})`;
      g.fillRect(0, 0, 2, 4);
    });
    const source = await png(2, 2, `rgb(${S[0]},${S[1]},${S[2]})`);
    const cases: Record<string, [Rgba | 'clear', Rgba | 'clear']> = {
      In: [S, 'clear'],
      Out: ['clear', S],
      Xor: ['clear', S],
      Atop: [S, 'clear'],
      Over: [S, S],
    };
    for (const [operator, [onOpaque, onClear]] of Object.entries(cases)) {
      const image = await compositeRun(operator, dest, source);
      const check = (got: Rgba, want: Rgba | 'clear') =>
        want === 'clear' ? expect(got[3], operator).toBe(0) : expectColor(got, want);
      check(image.at(1, 1), onOpaque);
      check(image.at(2, 1), onClear);
    }
  });

  it('a half transparent source mixes per-pixel operators by its alpha', async () => {
    const dest = await png(4, 4, `rgb(${D[0]},${D[1]},${D[2]})`);
    const source = await png(2, 2, `rgba(${S[0]},${S[1]},${S[2]},0.5)`);
    const image = await compositeRun('CopyRed', dest, source);
    expectColor(image.at(1, 1), [150, 100, 50, 255], 3);
    const opacity = await compositeRun('CopyOpacity', dest, source);
    expectColor(opacity.at(1, 1), [200, 100, 50, 128], 3);
  });

  it('a negative position composites only the overlapping part', async () => {
    const dest = await png(4, 4, `rgb(${D[0]},${D[1]},${D[2]})`);
    const source = await png(2, 2, `rgb(${S[0]},${S[1]},${S[2]})`);
    const image = await compositeRun('Multiply', dest, source, -1, -1);
    expectColor(image.at(0, 0), OPAQUE_EXPECTED.Multiply);
    expectColor(image.at(1, 1), D);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Edit Image: caps and errors', () => {
  it('refuses input above the byte limit before decoding', async () => {
    const input = await png(50, 50, '#ff0000');
    const r = await run({ operation: 'resize', width: 10, height: 10 }, [imageItem(input)], {
      limits: { maxImageInputBytes: 20 },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('larger than the limit');
  });

  it('refuses input above the pixel limit from the header, before decoding', async () => {
    const started = Date.now();
    const r = await run({ operation: 'resize', width: 10, height: 10 }, [
      imageItem(hugePngHeader(100_000, 100_000)),
    ]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('more than the limit');
    expect(r.error?.message).toContain('megapixels');
    expect(Date.now() - started).toBeLessThan(1000);

    const small = await png(200, 100, '#ff0000');
    const limited = await run({ operation: 'blur' }, [imageItem(small)], {
      limits: { maxImagePixels: 10_000 },
    });
    expect(limited.error?.message).toContain('more than the limit');
  });

  it('reads a GIF size from its frames too: a 1 x 1 screen with a 3000 x 3000 frame is refused before decoding', async () => {
    const gif = Buffer.from([
      ...Buffer.from('GIF89a', 'latin1'),
      1,
      0,
      1,
      0,
      0x80,
      0,
      0, // logical screen 1 x 1, global table of 2 colours
      0,
      0,
      0,
      255,
      255,
      255,
      0x21,
      0xf9,
      4,
      0,
      0,
      0,
      0,
      0, // graphic control extension
      0x2c,
      0,
      0,
      0,
      0,
      0xb8,
      0x0b,
      0xb8,
      0x0b,
      0, // frame 3000 x 3000 at 0,0
      2,
      2,
      0x44,
      0x01,
      0, // LZW code size, one data sub-block, end
      0x3b,
    ]);
    expect(readImageHeader(gif)).toEqual({ format: 'gif', width: 3000, height: 3000 });
    const r = await run(
      { operation: 'resize', width: 10, height: 10 },
      [imageItem(gif, 'a.gif', 'image/gif')],
      {
        limits: { maxImagePixels: 1_000_000 },
      },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('more than the limit');
  });

  it('keeps the blur edge padding inside the pixel cap on a thin image', async () => {
    const limits = { maxImagePixels: 50_000_000, maxImageInputBytes: 1 };
    const pad = blurPad(1_000_000, 50, 100, limits);
    expect((1_000_000 + 2 * pad) * (50 + 2 * pad)).toBeLessThanOrEqual(50_000_000);
    expect(blurPad(400, 300, 10, limits)).toBe(30);
    expect(blurPad(400, 300, 1000, limits)).toBe(256);
    expect(blurPad(100, 100, 50, { ...limits, maxImagePixels: 10_000 })).toBe(0);

    const thin = await png(400, 2, '#336699');
    const r = await run({ operation: 'blur', blurRadius: 50 }, [imageItem(thin)], {
      limits: { maxImagePixels: 1_000 },
    });
    expect(r.status).toBe('success');
  });

  it('refuses a composite image above the limits', async () => {
    const dest = await png(10, 10, '#ff0000');
    const item = imageItem(dest, 'a.png', 'image/png', { overlay: binaryOf(hugePngHeader(50_000, 50_000)) });
    const r = await run({ operation: 'composite', dataPropertyNameComposite: 'overlay' }, [item]);
    expect(r.error?.message).toContain('more than the limit');
  });

  it('refuses create, resize, border, rotate and shear outputs above the pixel limit', async () => {
    const limits = { maxImagePixels: 30_000 };
    const input = await png(200, 100, '#ff0000');
    const cases: DataObject[] = [
      { operation: 'create', width: 1000, height: 1000 },
      { operation: 'resize', width: 1000, height: 1000, resizeOption: 'ignoreAspectRatio' },
      { operation: 'border', borderWidth: 500, borderHeight: 500 },
      { operation: 'rotate', rotate: 45 },
      { operation: 'shear', degreesX: 80 },
    ];
    for (const parameters of cases) {
      const r = await run(parameters, [imageItem(input)], { limits });
      expect(r.status, String(parameters.operation)).toBe('error');
      expect(r.error?.message, String(parameters.operation)).toContain('more than the limit');
    }
    const huge = await run({ operation: 'create', width: 10_000, height: 10_000 }, [{ json: {} }]);
    expect(huge.error?.message).toContain('more than the limit');
  });

  it('reports a value that is not a number', async () => {
    const input = await png(20, 20, '#ff0000');
    const r = await run({ operation: 'resize', width: 'abc', height: 10 }, [imageItem(input)]);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('is not a number');
  });

  it('reports a missing binary and data that is not an image', async () => {
    const missing = await run({ operation: 'resize' }, [{ json: {} }]);
    expect(missing.error?.message).toContain('No binary data property "data"');
    const text = await run({ operation: 'resize' }, [
      imageItem(Buffer.from('hello, not an image'), 'a.txt', 'text/plain'),
    ]);
    expect(text.error?.message).toContain('not a supported image');
  });

  it('continueOnFail turns a failing item into an error item and goes on', async () => {
    const input = await png(20, 20, '#ff0000');
    const r = await run(
      { operation: 'resize', width: 10, height: 10, resizeOption: 'ignoreAspectRatio' },
      [imageItem(Buffer.from('junk')), imageItem(input)],
      { continueOnFail: true },
    );
    expect(r.status).toBe('success');
    expect(r.items[0]).toHaveLength(2);
    expect(String(r.items[0][0].json.error)).toContain('not a supported image');
    const image = await decoded(bytesOf(r.items[0][1].binary!.data));
    expect([image.width, image.height]).toEqual([10, 10]);
  });
});
