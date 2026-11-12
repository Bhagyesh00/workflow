/**
 * P6-61 (S5 L5): a syslog receiver for tests, on 127.0.0.1 with ephemeral ports: UDP (`node:dgram`, one message per
 * datagram), TCP (`net`, newline framing) and TLS (`tls`, the PEM pair of test/fixtures/tls: the certificate holds
 * 127.0.0.1 and localhost and is signed by `ca.pem`). It records what arrived; tests assert on it. No network beyond
 * 127.0.0.1.
 */
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { loadTlsFixtures } from './http-sink';

export type SyslogTransport = 'udp' | 'tcp' | 'tls';

export interface SyslogFake {
  udp: { port: number; messages: string[] };
  tcp: { port: number; lines: string[]; connections: number; dropConnections(): void };
  tls: { port: number; lines: string[]; connections: number; rejected: number };
  /** resolves with the messages of that receiver once `count` arrived; rejects after `timeoutMs` (default 5 s) */
  waitFor(transport: SyslogTransport, count: number, timeoutMs?: number): Promise<string[]>;
  close(): Promise<void>;
}

function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString('utf8');
    let at = rest.indexOf('\n');
    while (at >= 0) {
      onLine(rest.slice(0, at).replace(/\r$/, ''));
      rest = rest.slice(at + 1);
      at = rest.indexOf('\n');
    }
  };
}

export async function startSyslogFake(): Promise<SyslogFake> {
  const fixtures = loadTlsFixtures();
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of [...waiters]) w();
  };

  const udpMessages: string[] = [];
  const udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', (msg) => {
    udpMessages.push(msg.toString('utf8'));
    wake();
  });
  await new Promise<void>((resolve) => udpSocket.bind(0, '127.0.0.1', resolve));

  const tcpLines: string[] = [];
  const tcpState = { connections: 0 };
  const tcpSockets = new Set<net.Socket>();
  const tcpServer = net.createServer((socket) => {
    tcpState.connections += 1;
    tcpSockets.add(socket);
    socket.on('close', () => tcpSockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on(
      'data',
      lineReader((line) => {
        tcpLines.push(line);
        wake();
      }),
    );
  });
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));

  const tlsLines: string[] = [];
  const tlsState = { connections: 0, rejected: 0 };
  const tlsServer = tls.createServer({ key: fixtures.key, cert: fixtures.cert }, (socket) => {
    tlsState.connections += 1;
    socket.on('error', () => undefined);
    socket.on(
      'data',
      lineReader((line) => {
        tlsLines.push(line);
        wake();
      }),
    );
  });
  tlsServer.on('tlsClientError', () => {
    tlsState.rejected += 1;
  });
  await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));

  const lists: Record<SyslogTransport, string[]> = { udp: udpMessages, tcp: tcpLines, tls: tlsLines };

  return {
    udp: { port: udpSocket.address().port, messages: udpMessages },
    tcp: {
      port: (tcpServer.address() as net.AddressInfo).port,
      lines: tcpLines,
      get connections() {
        return tcpState.connections;
      },
      dropConnections() {
        for (const socket of tcpSockets) socket.destroy();
      },
    },
    tls: {
      port: (tlsServer.address() as net.AddressInfo).port,
      lines: tlsLines,
      get connections() {
        return tlsState.connections;
      },
      get rejected() {
        return tlsState.rejected;
      },
    },
    waitFor(transport, count, timeoutMs = 5000) {
      const list = lists[transport];
      return new Promise<string[]>((resolve, reject) => {
        const check = () => {
          if (list.length >= count) {
            cleanup();
            resolve([...list]);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(`syslog fake: ${list.length} of ${count} ${transport} messages after ${timeoutMs} ms`),
          );
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    async close() {
      for (const socket of tcpSockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => udpSocket.close(() => resolve())),
        new Promise<void>((resolve) => tcpServer.close(() => resolve())),
        new Promise<void>((resolve) => tlsServer.close(() => resolve())),
      ]);
    },
  };
}
