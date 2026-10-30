/** In-process HTTP and SMTP servers on 127.0.0.1 for node tests (no outbound network). */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export async function startHttpServer(
  handler: (req: ReceivedRequest, res: ServerResponse) => unknown,
): Promise<{ url: string; requests: ReceivedRequest[]; close: () => Promise<void> }> {
  const requests: ReceivedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const received = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(received);
    try {
      await handler(received, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** HttpClient that may reach the local test servers. */
export const localHttp = () => new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });

export interface SmtpMessage {
  from: string;
  to: string[];
  data: string;
  auth?: string;
}

/** Minimal SMTP server: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
export async function startSmtpServer(): Promise<{
  port: number;
  messages: SmtpMessage[];
  close: () => Promise<void>;
}> {
  const messages: SmtpMessage[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let current: SmtpMessage = { from: '', to: [], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 localhost ESMTP test');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: '', to: [], data: '', auth: current.auth };
          reply('250 OK: queued as 42');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (command === 'AUTH') {
          current.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          reply('235 Authentication successful');
        } else if (command === 'MAIL') {
          current.from = line.slice(10).trim();
          reply('250 OK');
        } else if (command === 'RCPT') {
          current.to.push(line.slice(8).trim());
          reply('250 OK');
        } else if (command === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (command === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else if (command === 'RSET' || command === 'NOOP') {
          reply('250 OK');
        } else {
          reply('502 Command not implemented');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
