/**
 * SSH: run a command or move a file on a remote host, as n8n's SSH node. The connection goes through
 * the SSRF guard (remote-connect.ts: resolved and checked once, the socket pinned to the checked
 * address) and is handed to ssh2 as `sock`. Command output and downloads are capped by the instance
 * remote file limit. As in n8n, the server's host key is not checked.
 */
import type { Readable } from 'node:stream';
import {
  type DataObject,
  deepCopy,
  type ExecuteContext,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import ssh2, { type ClientChannel, type SFTPWrapper } from 'ssh2';
import {
  CappedBuffer,
  connectSocket,
  fileTooLarge,
  formatLimit,
  readCapped,
  remoteBaseName,
  remoteHost,
  remotePort,
  shellQuote,
  sshAuthConfig,
} from '../../utils/remote-connect';
import { ItemList, mapItems } from '../../utils/utilities';

/** how long the TCP connect and the SSH handshake with sign-in may take (ssh2's default) */
const READY_TIMEOUT_MS = 20_000;

export interface CommandResult extends DataObject {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** One SSH connection for the whole run. */
export class SshSession {
  private sftpChannel?: Promise<SFTPWrapper>;
  private homeDir?: Promise<string>;

  private constructor(
    private readonly client: ssh2.Client,
    private readonly maxBytes: number,
  ) {}

  static async open(
    ctx: ExecuteContext,
    creds: DataObject,
    usePrivateKey: boolean,
    credentialName: string,
  ): Promise<SshSession> {
    const host = remoteHost(creds.host, credentialName);
    const port = remotePort(creds.port, 22);
    const sock = await connectSocket(ctx, host, port, READY_TIMEOUT_MS);
    const client = new ssh2.Client();
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => resolve());
        client.once('error', reject);
        client.connect({ sock, readyTimeout: READY_TIMEOUT_MS, ...sshAuthConfig(creds, usePrivateKey) });
      });
    } catch (error) {
      client.end();
      sock.destroy();
      throw error;
    }
    // errors after sign-in surface through the channel that hit them
    client.on('error', () => undefined);
    return new SshSession(client, ctx.helpers.getInstanceLimits().maxRemoteFileBytes);
  }

  close(): void {
    this.client.end();
  }

  /** run `command`, collecting stdout and stderr (trimmed, as n8n) up to the instance limit */
  exec(command: string): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      this.client.exec(command, (error, stream: ClientChannel) => {
        if (error) return reject(error);
        const stdout = new CappedBuffer(this.maxBytes);
        const stderr = new CappedBuffer(this.maxBytes);
        let code: number | null = null;
        let signal: string | null = null;
        let failed = false;
        const collect = (target: CappedBuffer) => (chunk: Buffer) => {
          if (failed) return;
          if (!target.push(chunk) || stdout.size + stderr.size > this.maxBytes) {
            failed = true;
            stream.close();
            reject(new Error(`The command output is larger than the limit of ${formatLimit(this.maxBytes)}`));
          }
        };
        stream.on('data', collect(stdout));
        stream.stderr.on('data', collect(stderr));
        stream.on('exit', (exitCode: number | null, exitSignal?: string) => {
          code = typeof exitCode === 'number' ? exitCode : null;
          signal = exitSignal ?? null;
        });
        stream.on('error', (streamError: Error) => {
          if (!failed) reject(streamError);
          failed = true;
        });
        stream.on('close', () => {
          if (failed) return;
          resolve({
            code,
            signal,
            stdout: stdout.toBuffer().toString('utf8').trim(),
            stderr: stderr.toBuffer().toString('utf8').trim(),
          });
        });
      });
    });
  }

  /** `~/x` becomes `<remote $HOME>/x`; a bare `~` or `~user` is refused, as in n8n */
  async resolveHome(remotePath: string, itemIndex: number, node: ExecuteContext): Promise<string> {
    if (remotePath.startsWith('~/')) {
      this.homeDir ??= this.exec('echo $HOME').then((r) =>
        r.stdout.endsWith('/') ? r.stdout : `${r.stdout}/`,
      );
      return (await this.homeDir) + remotePath.slice(2);
    }
    if (remotePath.startsWith('~')) {
      throw new NodeOperationError(node.getNode(), 'Invalid path. Replace "~" with home directory or "~/"', {
        itemIndex,
      });
    }
    return remotePath;
  }

  private sftp(): Promise<SFTPWrapper> {
    this.sftpChannel ??= new Promise<SFTPWrapper>((resolve, reject) =>
      this.client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))),
    );
    return this.sftpChannel;
  }

  async download(remotePath: string): Promise<Buffer> {
    const sftp = await this.sftp();
    const size = await new Promise<number>((resolve, reject) =>
      sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats.size))),
    );
    if (size > this.maxBytes) throw fileTooLarge(remotePath, this.maxBytes);
    // the stat size is only a hint: the read is capped as well
    return readCapped(sftp.createReadStream(remotePath) as Readable, this.maxBytes, () =>
      fileTooLarge(remotePath, this.maxBytes),
    );
  }

  async upload(remotePath: string, data: Uint8Array): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      sftp.writeFile(remotePath, Buffer.from(data), (error) => (error ? reject(error) : resolve())),
    );
  }
}

/** a file name for the remote side: no folders, no control characters */
function safeFileName(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we remove
  const name = remoteBaseName(value.replace(/[\u0000-\u001f\u007f]/g, ''));
  if (!name || name === '.' || name === '..') throw new Error(`"${value}" is not a valid file name`);
  return name;
}

export const SshNode: NodeType = {
  description: {
    name: 'core.ssh',
    displayName: 'SSH',
    description: 'Run commands and move files on a remote host over SSH',
    icon: 'lucide:terminal',
    group: ['input'],
    version: 1,
    defaults: { name: 'SSH' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Developer tools'],
    alias: ['ssh', 'remote command', 'shell', 'sftp'],
    credentials: [
      { name: 'sshPassword', required: true, displayOptions: { show: { authentication: ['password'] } } },
      { name: 'sshPrivateKey', required: true, displayOptions: { show: { authentication: ['privateKey'] } } },
    ],
    properties: [
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'password',
        noDataExpression: true,
        options: [
          { name: 'Password', value: 'password' },
          { name: 'Private Key', value: 'privateKey' },
        ],
      },
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        default: 'command',
        noDataExpression: true,
        options: [
          { name: 'Command', value: 'command' },
          { name: 'File', value: 'file' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'execute',
        noDataExpression: true,
        displayOptions: { show: { resource: ['command'] } },
        options: [{ name: 'Execute', value: 'execute', action: 'Execute a command' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'upload',
        noDataExpression: true,
        displayOptions: { show: { resource: ['file'] } },
        options: [
          { name: 'Download', value: 'download', action: 'Download a file' },
          { name: 'Upload', value: 'upload', action: 'Upload a file' },
        ],
      },
      {
        displayName: 'Command',
        name: 'command',
        type: 'string',
        default: '',
        typeOptions: { rows: 3 },
        displayOptions: { show: { resource: ['command'], operation: ['execute'] } },
        description: 'The command to run on the remote host',
      },
      {
        displayName: 'Working Directory',
        name: 'cwd',
        type: 'string',
        default: '/',
        required: true,
        displayOptions: { show: { resource: ['command'], operation: ['execute'] } },
        description: 'The folder the command runs in. "~/" is the remote home folder.',
      },
      {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
        description: 'The binary field of the input item that holds the file to upload',
      },
      {
        displayName: 'Target Directory',
        name: 'path',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/home/user',
        displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
        description: 'The folder to upload the file into. The file name comes from the binary field.',
      },
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '',
        required: true,
        placeholder: '/home/user/invoice.txt',
        displayOptions: { show: { resource: ['file'], operation: ['download'] } },
        description: 'The full path of the file to download, file name included',
      },
      {
        displayName: 'File Property',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: { show: { resource: ['file'], operation: ['download'] } },
        description: 'The binary field to put the downloaded file in',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { resource: ['file'] } },
        options: [
          {
            displayName: 'File Name',
            name: 'fileName',
            type: 'string',
            default: '',
            description: 'Overrides the file name of the binary data',
          },
        ],
      },
    ],
  },

  async execute(ctx) {
    // as n8n: authentication, resource and operation come from the first item
    const authentication = ctx.getNodeParameter('authentication', 0, 'password') as string;
    const resource = ctx.getNodeParameter('resource', 0, 'command') as string;
    const operation = ctx.getNodeParameter(
      'operation',
      0,
      resource === 'file' ? 'upload' : 'execute',
    ) as string;
    const credentialName = authentication === 'privateKey' ? 'sshPrivateKey' : 'sshPassword';
    const creds = await ctx.getCredentials(credentialName);
    let session: SshSession;
    try {
      session = await SshSession.open(ctx, creds, authentication === 'privateKey', credentialName);
    } catch (error) {
      if (error instanceof NodeOperationError) throw error;
      throw new NodeOperationError(ctx.getNode(), `Couldn't connect over SSH: ${(error as Error).message}`, {
        cause: error,
      });
    }

    try {
      return [
        await mapItems(ctx, async (i, item) => {
          if (resource === 'command' && operation === 'execute') {
            const command = String(ctx.getNodeParameter('command', i, '') ?? '');
            const cwd = await session.resolveHome(String(ctx.getNodeParameter('cwd', i, '/') ?? '/'), i, ctx);
            // a semicolon, as n8n: the command still runs when the folder is missing
            return session.exec(`cd ${shellQuote(cwd)} ; ${command}`);
          }
          if (resource === 'file' && operation === 'download') {
            const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data'));
            const options = ctx.getNodeParameter('options', i, {}) as DataObject;
            const remotePath = await session.resolveHome(String(ctx.getNodeParameter('path', i, '')), i, ctx);
            const data = await session.download(remotePath);
            const fileName = options.fileName ? String(options.fileName) : remoteBaseName(remotePath);
            return new ItemList([
              {
                json: deepCopy(item.json),
                binary: {
                  ...(item.binary ?? {}),
                  [property]: await ctx.helpers.prepareBinaryData(data, fileName),
                },
              },
            ]);
          }
          if (resource === 'file' && operation === 'upload') {
            const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data'));
            const options = ctx.getNodeParameter('options', i, {}) as DataObject;
            const binary = ctx.helpers.assertBinaryData(i, property);
            const folder = await session.resolveHome(String(ctx.getNodeParameter('path', i, '')), i, ctx);
            const fileName = safeFileName(String(options.fileName || binary.fileName || property));
            const target = `${folder}${folder.endsWith('/') ? '' : '/'}${fileName}`;
            await session.upload(target, await ctx.helpers.getBinaryDataBuffer(i, property));
            return { success: true };
          }
          throw new NodeOperationError(ctx.getNode(), `The operation "${operation}" is not supported`, {
            itemIndex: i,
          });
        }),
      ];
    } finally {
      session.close();
    }
  },
};
