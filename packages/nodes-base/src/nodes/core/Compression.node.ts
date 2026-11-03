/**
 * Compress and decompress files (zip, gzip, tar, tar.gz), like n8n's Compression node 1.1.
 *
 * Decompressing is bounded by the instance limits (getInstanceLimits: maxDecompressedBytes per
 * archive, maxArchiveEntries), enforced on the real inflated bytes; there are no node options for
 * them. Entry names become file metadata only (fileName, directory); unsafe names are refused.
 */
import { type BinaryData, type Item, NodeOperationError, type NodeType } from '@workflow/workflow';
import {
  ArchiveError,
  type ArchiveFile,
  ArchiveLimitError,
  type ArchiveLimits,
  gunzipBounded,
  gzipBytes,
  splitEntryName,
  tarFiles,
  untarBounded,
  unzipBounded,
  zipFiles,
} from '../../utils/archive';
import { errorItem } from '../../utils/utilities';

type OutputFormat = 'zip' | 'gzip' | 'tar' | 'targz';
type ArchiveFormat = 'zip' | 'gzip' | 'tar' | 'targz';

const MIME_TYPES: Record<OutputFormat, string> = {
  zip: 'application/zip',
  gzip: 'application/gzip',
  tar: 'application/x-tar',
  targz: 'application/gzip',
};

const DEFAULT_NAMES: Record<Exclude<OutputFormat, 'gzip'>, string> = {
  zip: 'data.zip',
  tar: 'data.tar',
  targz: 'data.tar.gz',
};

const fieldList = (value: unknown) =>
  String(value ?? 'data')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const stripGzipExtension = (name: string) => name.replace(/\.(gz|gzip)$/i, '');

/** the archive format from the file name or extension, as n8n decides it */
function archiveFormat(binary: BinaryData, field: string): ArchiveFormat {
  const name = (binary.fileName ?? '').toLowerCase();
  const fromName = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const extension = (binary.fileExtension || fromName).toLowerCase();
  if (!extension) throw new ArchiveError(`File extension not found for binary data ${field}`);
  if (name.endsWith('.tar.gz') || extension === 'tgz') return 'targz';
  if (extension === 'zip') return 'zip';
  if (extension === 'tar') return 'tar';
  if (extension === 'gz' || extension === 'gzip') return 'gzip';
  throw new ArchiveError(`Unsupported archive format: ${extension}`);
}

export const CompressionNode: NodeType = {
  description: {
    name: 'core.compression',
    displayName: 'Compression',
    description: 'Compress and decompress files (zip, gzip, tar)',
    icon: 'lucide:file-archive',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Compression' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: ['zip', 'unzip', 'gzip', 'gunzip', 'tar', 'compress', 'decompress', 'archive', 'extract'],
    subtitle: '={{ $parameter.operation }}',
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'decompress',
        noDataExpression: true,
        options: [
          { name: 'Compress', value: 'compress', action: 'Compress file(s)' },
          { name: 'Decompress', value: 'decompress', action: 'Decompress file(s)' },
        ],
      },
      {
        displayName: 'Input Binary Field(s)',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        placeholder: 'e.g. data,data2,data3',
        description: 'The binary fields with the files, separated by commas',
      },
      {
        displayName: 'Output Format',
        name: 'outputFormat',
        type: 'options',
        default: 'zip',
        displayOptions: { show: { operation: ['compress'] } },
        options: [
          { name: 'Gzip', value: 'gzip' },
          { name: 'Tar', value: 'tar' },
          { name: 'Tar (Gzip)', value: 'targz' },
          { name: 'Zip', value: 'zip' },
        ],
        description: 'Gzip compresses each file on its own; the other formats put all files in one archive',
      },
      {
        displayName: 'File Name',
        name: 'fileName',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. data.zip',
        description: 'Name of the archive file',
        displayOptions: { show: { operation: ['compress'], outputFormat: ['zip', 'tar', 'targz'] } },
      },
      {
        displayName: 'File Name',
        name: 'fileName',
        type: 'string',
        default: '',
        placeholder: 'e.g. data.txt',
        description: "Name of each gzip file (.gz is added); leave empty to keep each file's own name",
        displayOptions: { show: { operation: ['compress'], outputFormat: ['gzip'] } },
      },
      {
        displayName: 'Put Output File in Field',
        name: 'binaryPropertyOutput',
        type: 'string',
        default: 'data',
        description:
          'Binary field for the output; gzip adds a number for the second file on (data, data1, ...)',
        displayOptions: { show: { operation: ['compress'] } },
      },
      {
        displayName: 'Output File Prefix',
        name: 'outputPrefix',
        type: 'string',
        default: 'file_',
        required: true,
        description: 'Prefix of the binary fields for the extracted files (file_0, file_1, ...)',
        displayOptions: { show: { operation: ['decompress'] } },
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const instance = ctx.helpers.getInstanceLimits();
    const limits: ArchiveLimits = {
      maxBytes: instance.maxDecompressedBytes,
      maxEntries: instance.maxArchiveEntries,
    };
    const out: Item[] = [];

    const store = async (file: ArchiveFile): Promise<BinaryData> => {
      const { fileName, directory } = splitEntryName(file.name);
      const binary = await ctx.helpers.prepareBinaryData(file.data, fileName);
      if (directory) binary.directory = directory;
      return binary;
    };

    for (let i = 0; i < items.length; i++) {
      try {
        const operation = String(ctx.getNodeParameter('operation', i, 'decompress'));
        const fields = fieldList(ctx.getNodeParameter('binaryPropertyName', i, 'data'));
        const binary: Record<string, BinaryData> = {};

        if (operation === 'compress') {
          const format = String(ctx.getNodeParameter('outputFormat', i, 'zip')) as OutputFormat;
          if (!(format in MIME_TYPES)) throw new ArchiveError(`Unsupported output format "${format}"`);
          const output = String(ctx.getNodeParameter('binaryPropertyOutput', i, 'data') || 'data');
          const fileName = String(ctx.getNodeParameter('fileName', i, '') ?? '').trim();

          if (format === 'gzip') {
            for (const [index, field] of fields.entries()) {
              const source = ctx.helpers.assertBinaryData(i, field);
              const data = await gzipBytes(await ctx.helpers.getBinaryDataBuffer(i, field));
              const name = `${stripGzipExtension(fileName || source.fileName || field)}.gz`;
              binary[index === 0 ? output : `${output}${index}`] = await ctx.helpers.prepareBinaryData(
                data,
                name,
                MIME_TYPES.gzip,
              );
            }
          } else {
            // files with the same name overwrite each other, as in n8n
            const files = new Map<string, Uint8Array>();
            for (const field of fields) {
              const source = ctx.helpers.assertBinaryData(i, field);
              files.set(source.fileName || field, await ctx.helpers.getBinaryDataBuffer(i, field));
            }
            const list = [...files].map(([name, data]) => ({ name, data }));
            let archive: Uint8Array;
            if (format === 'zip') archive = await zipFiles(list);
            else if (format === 'tar') archive = await tarFiles(list);
            else archive = await gzipBytes(await tarFiles(list));
            binary[output] = await ctx.helpers.prepareBinaryData(
              archive,
              fileName || DEFAULT_NAMES[format],
              MIME_TYPES[format],
            );
          }
        } else if (operation === 'decompress') {
          const prefix = String(ctx.getNodeParameter('outputPrefix', i, 'file_') ?? 'file_');
          let index = 0;
          for (const field of fields) {
            const source = ctx.helpers.assertBinaryData(i, field);
            const format = archiveFormat(source, field);
            const bytes = await ctx.helpers.getBinaryDataBuffer(i, field);
            let files: ArchiveFile[];
            if (format === 'zip') files = await unzipBounded(bytes, limits);
            else if (format === 'tar') files = untarBounded(bytes, limits);
            else if (format === 'targz') files = untarBounded(await gunzipBounded(bytes, limits), limits);
            else {
              const name = source.fileName ? stripGzipExtension(source.fileName) : '';
              files = [{ name, data: await gunzipBounded(bytes, limits) }];
            }
            for (const file of files) {
              binary[`${prefix}${index++}`] = file.name
                ? await store(file)
                : await ctx.helpers.prepareBinaryData(file.data);
            }
          }
        } else {
          throw new ArchiveError(`Unknown operation "${operation}"`);
        }

        out.push({ json: items[i]!.json, binary, pairedItem: { item: i } });
      } catch (error) {
        const failure =
          error instanceof ArchiveError
            ? new NodeOperationError(ctx.getNode(), error.message, {
                itemIndex: i,
                ...(error instanceof ArchiveLimitError
                  ? {
                      description:
                        'The instance limits NODE_DECOMPRESS_MAX_MB and NODE_ARCHIVE_MAX_ENTRIES set how large an archive may be',
                    }
                  : {}),
              })
            : error;
        if (!ctx.continueOnFail()) throw failure;
        out.push(errorItem(failure, i));
      }
    }
    return [out];
  },
};
