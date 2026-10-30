import type { DataObject, Logger } from '@workflow/workflow';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Minimal structured JSON logger (stdout). The server swaps in pino. */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly level: Level = 'info',
    private readonly base: DataObject = {},
  ) {}

  private write(level: Level, message: string, meta?: DataObject) {
    if (ORDER[level] < ORDER[this.level]) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      msg: message,
      ...this.base,
      ...meta,
    });
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(message: string, meta?: DataObject) {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: DataObject) {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: DataObject) {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: DataObject) {
    this.write('error', message, meta);
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
