/**
 * FTP: list, download, upload, rename and delete files over FTP or SFTP, as n8n's FTP node (version
 * 1.1 output: list dates as ISO strings). One connection per run, through the SSRF guard
 * (utils/file-transfer.ts). Downloads are capped by the instance remote file limit.
 */
import {
  type DataObject,
  deepCopy,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { assertSafePath, type FileTransfer, openFtp, openSftp } from '../../utils/file-transfer';
import { remoteBaseName } from '../../utils/remote-connect';
import { errorItem, ItemList, mapItems } from '../../utils/utilities';

const DEFAULT_TIMEOUT_MS = 10_000;

const show = (operation: string, extra: Record<string, unknown[]> = {}) => ({
  show: { operation: [operation], ...extra },
});

const timeoutOption: NodeProperty = {
  displayName: 'Timeout',
  name: 'timeout',
  type: 'number',
  default: DEFAULT_TIMEOUT_MS,
  typeOptions: { minValue: 1 },
  description: 'How long to wait for the connection and sign-in, in milliseconds',
};

export const FtpNode: NodeType = {
  description: {
    name: 'core.ftp',
    displayName: 'FTP',
    description: 'Transfer files over FTP or SFTP',
    icon: 'lucide:server',
    group: ['input'],
    version: 1,
    defaults: { name: 'FTP' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Files'],
    alias: ['ftp', 'sftp', 'upload', 'download', 'file transfer'],
    credentials: [
      { name: 'ftp', required: true, displayOptions: { show: { protocol: ['ftp'] } } },
      { name: 'sftp', required: true, displayOptions: { show: { protocol: ['sftp'] } } },
    ],
    properties: [
      {
        displayName: 'Protocol',
        name: 'protocol',
        type: 'options',
        default: 'ftp',
        noDataExpression: true,
        options: [
          { name: 'FTP', value: 'ftp' },
          { name: 'SFTP', value: 'sftp' },
        ],
        description: 'File transfer protocol',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'download',
        noDataExpression: true,
        options: [
          { name: 'Delete', value: 'delete', action: 'Delete a file or folder' },
          { name: 'Download', value: 'download', action: 'Download a file' },
          { name: 'List', value: 'list', action: 'List folder content' },
          { name: 'Rename', value: 'rename', action: 'Rename or move a file or folder' },
          { name: 'Upload', value: 'upload', action: 'Upload a file' },
        ],
      },
      // delete
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/public/documents/file-to-delete.txt',
        displayOptions: show('delete'),
        description: 'The full path of the file or folder to delete',
      },
      // download
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/public/documents/file-to-download.txt',
        displayOptions: show('download'),
        description: 'The full path of the file to download',
      },
      {
        displayName: 'Put Output File in Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: show('download'),
        description: 'The binary field to put the downloaded file in',
      },
      // rename
      {
        displayName: 'Old Path',
        name: 'oldPath',
        type: 'string',
        default: '',
        required: true,
        displayOptions: show('rename'),
      },
      {
        displayName: 'New Path',
        name: 'newPath',
        type: 'string',
        default: '',
        required: true,
        displayOptions: show('rename'),
      },
      // upload
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/public/documents/file-to-upload.txt',
        displayOptions: show('upload'),
        description: 'The full path the file is uploaded to',
      },
      {
        displayName: 'Binary File',
        name: 'binaryData',
        type: 'boolean',
        default: true,
        displayOptions: show('upload'),
        description: 'Whether the data to upload is a binary field; off uploads text',
      },
      {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: show('upload', { binaryData: [true] }),
        description: 'The binary field of the input item that holds the file to upload',
      },
      {
        displayName: 'File Content',
        name: 'fileContent',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: show('upload', { binaryData: [false] }),
        description: 'The text content of the file to upload',
      },
      // list
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '/',
        displayOptions: show('list'),
        description: 'The folder to list',
      },
      {
        displayName: 'Recursive',
        name: 'recursive',
        type: 'boolean',
        default: false,
        displayOptions: show('list'),
        description: 'Whether to list every sub folder too: files and folders, level by level',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Folder',
            name: 'folder',
            type: 'boolean',
            default: false,
            displayOptions: { show: { '/operation': ['delete'] } },
            description: 'Whether the path is a folder',
          },
          {
            displayName: 'Recursive',
            name: 'recursive',
            type: 'boolean',
            default: false,
            displayOptions: { show: { '/operation': ['delete'], folder: [true] } },
            description: 'Whether to delete the folder with everything in it',
          },
          {
            displayName: 'Create Directories',
            name: 'createDirectories',
            type: 'boolean',
            default: false,
            displayOptions: { show: { '/operation': ['rename'] } },
            description: 'Whether to create the destination folder (recursively) when it is missing',
          },
          timeoutOption,
        ],
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    // as n8n: protocol, operation and the connection timeout come from the first item
    const protocol = ctx.getNodeParameter('protocol', 0, 'ftp') as string;
    const operation = ctx.getNodeParameter('operation', 0, 'download') as string;
    const timeout =
      Number(ctx.getNodeParameter('options.timeout', 0, DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS;
    const creds = await ctx.getCredentials(protocol === 'sftp' ? 'sftp' : 'ftp');

    let transfer: FileTransfer;
    try {
      transfer =
        protocol === 'sftp' ? await openSftp(ctx, creds, timeout) : await openFtp(ctx, creds, timeout);
    } catch (error) {
      // as n8n: a failed connection fails every item
      if (ctx.continueOnFail()) return [items.map((_, i) => errorItem(error, i))];
      if (error instanceof NodeOperationError) throw error;
      throw new NodeOperationError(
        ctx.getNode(),
        `Couldn't connect over ${protocol.toUpperCase()}: ${(error as Error).message}`,
        { cause: error },
      );
    }

    const pathParameter = (name: string, i: number) =>
      assertSafePath(String(ctx.getNodeParameter(name, i, '') ?? ''));

    try {
      return [
        await mapItems(ctx, async (i, item) => {
          const options = ctx.getNodeParameter('options', i, {}) as DataObject;
          switch (operation) {
            case 'list': {
              const dir = pathParameter('path', i) || '/';
              const recursive = Boolean(ctx.getNodeParameter('recursive', i, false));
              return transfer.list(dir, recursive);
            }
            case 'download': {
              const remotePath = pathParameter('path', i);
              const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data'));
              const data = await transfer.download(remotePath);
              return new ItemList([
                {
                  json: deepCopy(item.json),
                  binary: {
                    ...(item.binary ?? {}),
                    [property]: await ctx.helpers.prepareBinaryData(data, remoteBaseName(remotePath)),
                  },
                },
              ]);
            }
            case 'upload': {
              const remotePath = pathParameter('path', i);
              const data = ctx.getNodeParameter('binaryData', i, true)
                ? await ctx.helpers.getBinaryDataBuffer(
                    i,
                    String(ctx.getNodeParameter('binaryPropertyName', i, 'data')),
                  )
                : Buffer.from(String(ctx.getNodeParameter('fileContent', i, '') ?? ''), 'utf8');
              await transfer.upload(remotePath, data);
              // as n8n: the input item passes through
              return new ItemList([
                { json: deepCopy(item.json), ...(item.binary ? { binary: item.binary } : {}) },
              ]);
            }
            case 'rename':
              await transfer.rename(
                pathParameter('oldPath', i),
                pathParameter('newPath', i),
                Boolean(options.createDirectories),
              );
              return { success: true };
            case 'delete':
              await transfer.remove(pathParameter('path', i), {
                folder: Boolean(options.folder),
                recursive: Boolean(options.recursive),
              });
              return { success: true };
            default:
              throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not supported`, {
                itemIndex: i,
              });
          }
        }),
      ];
    } finally {
      await transfer.close();
    }
  },
};
