/** The request log never holds a sign-in's one-time code: a form's (P4-16) or a Chat Trigger's (P5-57). */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactUrl } from '../src/logger';

const CODE = 'c0de-one-time-0123456789';

describe('redactUrl', () => {
  it.each([
    `/webhook/acme/hook-1/chat?code=${CODE}`,
    `/webhook-test/acme/hook-1/chat?code=${CODE}`,
    `/webhook/acme/a/b/chat?ref=mail&code=${CODE}`,
    `/webhook/acme/hook-1/chat/?code=${CODE}`,
    `//webhook/acme/hook-1/chat?code=${CODE}`,
    `/%77ebhook/acme/hook-1/chat?code=${CODE}`,
  ])('hides the code of the chat path %s', (url) => {
    const out = redactUrl(url);
    expect(out).not.toContain(CODE);
    expect(out).toContain('code=[redacted]');
  });

  it('keeps the chat path and the rest of its query', () => {
    expect(redactUrl(`/webhook/acme/hook-1/chat?ref=mail&code=${CODE}&x=1`)).toBe(
      '/webhook/acme/hook-1/chat?ref=mail&code=[redacted]&x=1',
    );
    expect(redactUrl('/webhook-test/acme/hook-1/chat?ref=mail')).toBe(
      '/webhook-test/acme/hook-1/chat?ref=mail',
    );
  });

  it('still hides the code of the form paths', () => {
    expect(redactUrl(`/form/acme/who?code=${CODE}`)).toBe('/form/acme/who?code=[redacted]');
    expect(redactUrl(`/form-test/acme/who?code=${CODE}`)).toBe('/form-test/acme/who?code=[redacted]');
    expect(redactUrl(`/form-waiting/e1/sig?code=${CODE}`)).toBe('/form-waiting/[redacted]?code=[redacted]');
  });

  it('hides the code of a plain webhook too (P6-19: the browser sign-in comes back with it)', () => {
    expect(redactUrl('/webhook/acme/orders?code=42&x=1')).toBe('/webhook/acme/orders?code=[redacted]&x=1');
    expect(redactUrl('/webhook/acme/orders?x=1')).toBe('/webhook/acme/orders?x=1');
  });
});

describe('the request log line', () => {
  it('writes the chat and form URLs without the code', () => {
    const lines: string[] = [];
    const logger = createLogger(
      'info',
      {},
      new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    );
    for (const url of [`/webhook/acme/hook-1/chat?code=${CODE}`, `/form/acme/who?code=${CODE}`]) {
      logger.info({ req: { method: 'GET', url, headers: {} } }, 'incoming request');
    }
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(CODE);
      expect(line).toContain('code=[redacted]');
    }
  });
});
