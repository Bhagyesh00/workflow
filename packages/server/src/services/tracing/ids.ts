/** P6-65 (S5 L9): random W3C trace and span ids (crypto random, never all zero). */
import { randomBytes } from 'node:crypto';

function randomHex(bytes: number): string {
  for (;;) {
    const id = randomBytes(bytes);
    // an all-zero id is invalid in W3C Trace Context and OTLP; draw again (odds 2^-64 or less)
    if (id.some((byte) => byte !== 0)) return id.toString('hex');
  }
}

/** 32 lowercase hex characters (16 bytes) */
export function randomTraceId(): string {
  return randomHex(16);
}

/** 16 lowercase hex characters (8 bytes) */
export function randomSpanId(): string {
  return randomHex(8);
}
