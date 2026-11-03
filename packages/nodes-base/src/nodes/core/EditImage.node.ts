/**
 * Edit Image: resize, crop, rotate, draw on, write text on, composite and convert images (n8n Edit Image v2:
 * @napi-rs/canvas for drawing and encoding, @napi-rs/image for bmp/tiff and EXIF orientation).
 *
 * The instance caps (megapixels, input bytes) are checked from the file header before anything decodes, and for
 * every image an operation creates. The node has no options for them.
 */
import type { Canvas } from '@napi-rs/canvas';
import {
  type DataObject,
  deepCopy,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import {
  assertInputBytes,
  decodeImage,
  encodeImage,
  IMAGE_FORMATS,
  ImageError,
  type ImageFormat,
  readImageHeader,
} from '../../utils/image/canvas';
import { fontFamilies } from '../../utils/image/fonts';
import {
  applyOperation,
  OPERATION_FIELDS,
  OperationParams,
  STEP_OPERATIONS,
  type StepOperation,
} from '../../utils/image/operations';
import { ItemList, mapItems } from '../../utils/utilities';

const OPERATION_OPTIONS = [
  { name: 'Blur', value: 'blur', description: 'Blur the image', action: 'Blur an image' },
  {
    name: 'Border',
    value: 'border',
    description: 'Add a border to the image',
    action: 'Add a border to an image',
  },
  {
    name: 'Composite',
    value: 'composite',
    description: 'Combine the image with another image',
    action: 'Composite an image',
  },
  { name: 'Create', value: 'create', description: 'Create a new image', action: 'Create an image' },
  { name: 'Crop', value: 'crop', description: 'Crop the image', action: 'Crop an image' },
  {
    name: 'Draw',
    value: 'draw',
    description: 'Draw a circle, line or rectangle',
    action: 'Draw on an image',
  },
  {
    name: 'Get Information',
    value: 'information',
    description: 'Get the format and size of the image',
    action: 'Get information about an image',
  },
  {
    name: 'Multi Step',
    value: 'multiStep',
    description: 'Run several operations one after the other',
    action: 'Run several operations on an image',
  },
  { name: 'Resize', value: 'resize', description: 'Change the size of the image', action: 'Resize an image' },
  { name: 'Rotate', value: 'rotate', description: 'Rotate the image', action: 'Rotate an image' },
  {
    name: 'Shear',
    value: 'shear',
    description: 'Shear the image along the X or Y axis',
    action: 'Shear an image',
  },
  { name: 'Text', value: 'text', description: 'Write text on the image', action: 'Write text on an image' },
  {
    name: 'Transparent',
    value: 'transparent',
    description: 'Make a colour in the image transparent',
    action: 'Make a colour transparent',
  },
];

/** an operation's fields, shown only for that operation (inside a step or at the top level) */
function fieldsFor(operation: StepOperation): NodeProperty[] {
  return OPERATION_FIELDS[operation].map((field) => ({
    ...field,
    displayOptions: { show: { ...field.displayOptions?.show, operation: [operation] } },
  }));
}

const stepFields: NodeProperty[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    default: 'resize',
    noDataExpression: true,
    options: OPERATION_OPTIONS.filter((o) => (STEP_OPERATIONS as readonly string[]).includes(o.value)).map(
      ({ name, value, description }) => ({ name, value, description }),
    ),
  },
  ...STEP_OPERATIONS.flatMap(fieldsFor),
];

const FORMAT_OPTIONS = IMAGE_FORMATS.map((value) => ({ name: value.toUpperCase(), value }));

export const EditImageNode: NodeType = {
  description: {
    name: 'core.editImage',
    displayName: 'Edit Image',
    description: 'Resize, crop, rotate, draw on and convert images',
    icon: 'lucide:image',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Edit Image' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: ['image', 'resize', 'crop', 'rotate', 'watermark', 'convert image', 'png', 'jpeg'],
    subtitle: '={{ $parameter.operation }}',
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'border',
        noDataExpression: true,
        options: OPERATION_OPTIONS,
      },
      {
        displayName: 'Property Name',
        name: 'dataPropertyName',
        type: 'string',
        default: 'data',
        description: 'Name of the binary property that holds the image (Create writes to it)',
      },
      {
        displayName: 'Operations',
        name: 'operations',
        type: 'fixedCollection',
        default: {},
        placeholder: 'Add step',
        typeOptions: { multipleValues: true, sortable: true },
        description: 'The operations to run, in order',
        displayOptions: { show: { operation: ['multiStep'] } },
        options: [{ displayName: 'Operations', name: 'operations', values: stepFields }],
      },
      ...STEP_OPERATIONS.flatMap(fieldsFor),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { hide: { operation: ['information'] } },
        options: [
          {
            displayName: 'Destination Output Field',
            name: 'destinationKey',
            type: 'string',
            default: 'data',
            description: 'Binary property the result is written to (by default the input property)',
          },
          {
            displayName: 'File Name',
            name: 'fileName',
            type: 'string',
            default: '',
            description: 'File name of the result',
          },
          {
            displayName: 'Format',
            name: 'format',
            type: 'options',
            default: 'jpeg',
            options: FORMAT_OPTIONS,
            description: 'Format of the result (by default the format of the input, PNG for Create)',
          },
          {
            displayName: 'Quality',
            name: 'quality',
            type: 'number',
            default: 100,
            typeOptions: { minValue: 0, maxValue: 100 },
            description: 'Quality of a JPEG or WebP result, 0 to 100',
            displayOptions: { show: { format: ['jpeg', 'webp'] } },
          },
        ],
      },
    ],
  },

  methods: {
    loadOptions: {
      async getFonts() {
        return fontFamilies().map((name) => ({ name, value: name }));
      },
    },
  },

  async execute(ctx) {
    const limits = ctx.helpers.getInstanceLimits();

    /** the bytes of one binary property, refused above the byte cap before they are read */
    const readBinary = async (itemIndex: number, property: string): Promise<Uint8Array> => {
      const meta = ctx.helpers.assertBinaryData(itemIndex, property);
      if (typeof meta.fileSize === 'number') assertInputBytes(meta.fileSize, limits);
      const data = await ctx.helpers.getBinaryDataBuffer(itemIndex, property);
      assertInputBytes(data.byteLength, limits);
      return data;
    };

    const handle = async (i: number, item: Item) => {
      const operation = ctx.getNodeParameter('operation', i, 'border') as string;
      const property = String(ctx.getNodeParameter('dataPropertyName', i, 'data') || 'data');

      if (operation === 'information') {
        const data = await readBinary(i, property);
        const header = readImageHeader(data);
        if (!header) throw new ImageError(`The file is not a supported image (${IMAGE_FORMATS.join(', ')})`);
        const json: DataObject = {
          format: header.format.toUpperCase(),
          mimeType: `image/${header.format}`,
          size: { width: header.width, height: header.height },
          fileSize: data.byteLength,
        };
        return new ItemList([{ json, ...(item.binary ? { binary: item.binary } : {}) }]);
      }

      const options = (ctx.getNodeParameter('options', i, {}) ?? {}) as DataObject;
      let steps: OperationParams[];
      if (operation === 'multiStep') {
        const collection = (ctx.getNodeParameter('operations', i, {}) ?? {}) as { operations?: DataObject[] };
        steps = (collection.operations ?? []).map((step) => {
          const name = String(step.operation ?? '');
          if (!(STEP_OPERATIONS as readonly string[]).includes(name)) {
            throw new ImageError(`Unknown operation "${name}" in a Multi Step step`);
          }
          return new OperationParams(name as StepOperation, (field, fallback) => step[field] ?? fallback);
        });
      } else if ((STEP_OPERATIONS as readonly string[]).includes(operation)) {
        steps = [
          new OperationParams(operation as StepOperation, (field, fallback) =>
            ctx.getNodeParameter(field, i, fallback),
          ),
        ];
      } else {
        throw new ImageError(`Unknown operation "${operation}"`);
      }

      const env = {
        limits,
        loadImage: async (name: string) => (await decodeImage(await readBinary(i, name), limits)).canvas,
      };

      let canvas: Canvas | undefined;
      let inputFormat: ImageFormat | undefined;
      if (steps[0]?.operation !== 'create') {
        const decoded = await decodeImage(await readBinary(i, property), limits);
        canvas = decoded.canvas;
        inputFormat = decoded.format;
      }
      for (const step of steps) canvas = await applyOperation(canvas, step, env);
      if (!canvas) throw new ImageError('There is no image to write');

      const format = (options.format ? String(options.format) : (inputFormat ?? 'png')) as ImageFormat;
      if (!IMAGE_FORMATS.includes(format)) throw new ImageError(`Unknown format "${format}"`);
      const quality = options.quality === undefined || options.quality === '' ? 100 : Number(options.quality);
      if (!Number.isFinite(quality))
        throw new ImageError(`The value "${String(options.quality)}" of "Quality" is not a number`);
      const data = await encodeImage(canvas, format, quality);

      const inputName = item.binary?.[property]?.fileName;
      const fileName =
        (options.fileName ? String(options.fileName) : undefined) ??
        (inputName ? `${inputName.replace(/\.[^./\\]*$/, '')}.${format}` : undefined);
      const binary = await ctx.helpers.prepareBinaryData(data, fileName, `image/${format}`);
      binary.fileExtension = format;

      const destination = String(options.destinationKey || property);
      return new ItemList([{ json: deepCopy(item.json), binary: { ...item.binary, [destination]: binary } }]);
    };

    return [
      await mapItems(ctx, async (i, item) => {
        try {
          return await handle(i, item);
        } catch (error) {
          if (error instanceof ImageError)
            throw new NodeOperationError(ctx.getNode(), error.message, { itemIndex: i });
          throw error;
        }
      }),
    ];
  },
};
