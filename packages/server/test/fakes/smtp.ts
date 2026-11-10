/**
 * P6 S2 (C0e): an in-process SMTP server on 127.0.0.1 for mail tests (no outbound network). A copy of
 * nodes-base test/servers.ts `startSmtpServer` (no cross-package import): EHLO, AUTH PLAIN, MAIL, RCPT,
 * DATA, QUIT; every message lands in `messages`.
 */
import net, { type AddressInfo } from 'node:net';

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
