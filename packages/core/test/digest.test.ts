import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digestAuthorization } from '../src/http/digest';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const req = { method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle Of Life' };
const rfc =
  'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';

describe('digestAuthorization', () => {
  it('matches the RFC 2617 section 3.5 example', () => {
    const header = digestAuthorization(rfc, { ...req, cnonce: '0a4f113b' })!;
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('cnonce="0a4f113b"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(header).toContain('username="Mufasa"');
    expect(header).toContain('uri="/dir/index.html"');
  });

  it('uses a random cnonce each time', () => {
    const a = digestAuthorization(rfc, req)!.match(/cnonce="([^"]+)"/)![1];
    const b = digestAuthorization(rfc, req)!.match(/cnonce="([^"]+)"/)![1];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('uses the RFC 2069 form without qop', () => {
    const header = digestAuthorization('Digest realm="r", nonce="abc"', req)!;
    const expected = md5(`${md5('Mufasa:r:Circle Of Life')}:abc:${md5('GET:/dir/index.html')}`);
    expect(header).toContain(`response="${expected}"`);
    expect(header).not.toContain('qop=');
    expect(header).not.toContain('cnonce');
  });

  it('computes MD5-sess and echoes the algorithm', () => {
    const header = digestAuthorization('Digest realm="r", nonce="n1", qop="auth", algorithm=MD5-sess', {
      ...req,
      cnonce: 'cc',
    })!;
    const ha1 = md5(`${md5('Mufasa:r:Circle Of Life')}:n1:cc`);
    const expected = md5(`${ha1}:n1:00000001:cc:auth:${md5('GET:/dir/index.html')}`);
    expect(header).toContain(`response="${expected}"`);
    expect(header).toContain('algorithm=MD5-sess');
  });

  it('finds the Digest challenge among several and handles quoted commas and quotes', () => {
    const header = digestAuthorization(
      'Basic realm="b", Digest realm="a, b \\"c\\"", nonce="n", qop="auth"',
      {
        ...req,
        cnonce: 'cc',
      },
    )!;
    expect(header).toContain('realm="a, b \\"c\\""');
    expect(header).toContain('nonce="n"');
  });

  it('skips unsupported challenges and picks a supported one', () => {
    const header = digestAuthorization(
      'Digest realm="r", nonce="s", algorithm=SHA-256, Digest realm="r", nonce="m", algorithm=MD5',
      req,
    )!;
    expect(header).toContain('nonce="m"');
  });

  it('returns undefined when no challenge can be answered', () => {
    expect(digestAuthorization('Basic realm="x"', req)).toBeUndefined();
    expect(digestAuthorization('Digest realm="r", nonce="n", algorithm=SHA-256', req)).toBeUndefined();
    expect(digestAuthorization('Digest realm="r"', req)).toBeUndefined();
    expect(digestAuthorization('', req)).toBeUndefined();
  });

  it('escapes quotes in the user name', () => {
    const header = digestAuthorization('Digest realm="r", nonce="n"', { ...req, username: 'a"b' })!;
    expect(header).toContain('username="a\\"b"');
  });
});
