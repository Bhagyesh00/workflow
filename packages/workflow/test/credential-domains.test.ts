import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DOMAINS_PROPERTIES,
  assertCredentialUrlAllowed,
  CredentialDomainError,
  getCredentialAllowedDomains,
  isDomainAllowed,
} from '../src';

describe('isDomainAllowed', () => {
  const table: Array<[host: string, list: string[], expected: boolean]> = [
    // exact host
    ['api.example.com', ['api.example.com'], true],
    ['api.example.com', ['example.com'], false],
    ['example.com', ['api.example.com'], false],
    // case-insensitive, trailing dot
    ['API.Example.COM', ['api.example.com'], true],
    ['api.example.com', ['API.EXAMPLE.COM'], true],
    ['api.example.com.', ['api.example.com'], true],
    ['api.example.com', ['api.example.com.'], true],
    // wildcard: subdomains only, never the bare domain
    ['a.example.com', ['*.example.com'], true],
    ['a.b.example.com', ['*.example.com'], true],
    ['example.com', ['*.example.com'], false],
    ['.example.com', ['*.example.com'], false],
    ['notexample.com', ['*.example.com'], false],
    ['evilexample.com', ['*.example.com'], false],
    ['a.example.com.evil.net', ['*.example.com'], false],
    ['a.example.com.', ['*.example.com'], true],
    // a list: any entry matches
    ['b.net', ['a.com', 'b.net'], true],
    ['c.net', ['a.com', 'b.net'], false],
    // entries that cannot name a host never match
    ['example.com', ['https://example.com'], false],
    ['example.com', ['example.com/path'], false],
    ['example.com', ['example.com:8080'], false],
    ['example.com', ['user@example.com'], false],
    ['example.com', ['*'], false],
    ['example.com', ['*example.com'], false],
    ['anything.com', ['*.'], false],
    ['anything.com', ['*.*'], false],
    ['example.com', [], false],
    ['example.com', [''], false],
    // IP literals are exact
    ['127.0.0.1', ['127.0.0.1'], true],
    ['127.0.0.2', ['127.0.0.1'], false],
    ['[::1]', ['[::1]'], true],
    ['::1', ['[::1]'], true],
  ];
  it.each(table)('%s against %j is %s', (host, list, expected) => {
    expect(isDomainAllowed(host, list)).toBe(expected);
  });
});

describe('assertCredentialUrlAllowed', () => {
  it('ignores port, path, scheme, query and user info of the URL', () => {
    const list = ['api.example.com'];
    for (const url of [
      'https://api.example.com/x',
      'http://api.example.com:8080/x?y=1#z',
      'https://user:pw@api.example.com/',
      'HTTPS://API.EXAMPLE.COM./x',
    ]) {
      expect(() => assertCredentialUrlAllowed(url, list)).not.toThrow();
    }
  });

  it('is a no-op without a list', () => {
    expect(() => assertCredentialUrlAllowed('https://anything.test/', undefined)).not.toThrow();
    expect(() => assertCredentialUrlAllowed('not a url', undefined)).not.toThrow();
  });

  it('refuses another host with the n8n wording, naming the host and the list but not the URL', () => {
    let error: unknown;
    try {
      assertCredentialUrlAllowed('https://evil.test/steal?token=SECRET', ['a.com', '*.b.com']);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CredentialDomainError);
    expect((error as CredentialDomainError).host).toBe('evil.test');
    expect((error as Error).message).toBe(
      'Domain not allowed: This credential is restricted from accessing evil.test. Only the following domains are allowed: a.com, *.b.com',
    );
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('refuses the bare domain of a wildcard and an unparsable URL (without echoing it)', () => {
    expect(() => assertCredentialUrlAllowed('https://b.com/', ['*.b.com'])).toThrow(CredentialDomainError);
    let error: unknown;
    try {
      assertCredentialUrlAllowed('//secret-in-url', ['a.com']);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CredentialDomainError);
    expect((error as Error).message).not.toContain('secret-in-url');
  });
});

describe('getCredentialAllowedDomains', () => {
  it('mode all, missing or empty: unrestricted, on every surface', () => {
    for (const userUrl of [true, false]) {
      expect(getCredentialAllowedDomains({}, { userUrl })).toBeUndefined();
      expect(getCredentialAllowedDomains({ allowedHttpRequestDomains: 'all' }, { userUrl })).toBeUndefined();
      expect(getCredentialAllowedDomains({ allowedHttpRequestDomains: '' }, { userUrl })).toBeUndefined();
      // a list left in the data while the mode is "all" is ignored
      expect(
        getCredentialAllowedDomains(
          { allowedHttpRequestDomains: 'all', allowedDomains: 'a.com' },
          { userUrl },
        ),
      ).toBeUndefined();
    }
  });

  it('mode domains: the trimmed, lower-cased entries', () => {
    expect(
      getCredentialAllowedDomains(
        { allowedHttpRequestDomains: 'domains', allowedDomains: ' Example.com ,*.Sub.com,, x.io ' },
        { userUrl: false },
      ),
    ).toEqual(['example.com', '*.sub.com', 'x.io']);
  });

  it('mode domains with an empty list is an error, never "allow all"', () => {
    for (const allowedDomains of [undefined, '', '  ', ' , ,']) {
      expect(() =>
        getCredentialAllowedDomains(
          { allowedHttpRequestDomains: 'domains', allowedDomains },
          { userUrl: false },
        ),
      ).toThrow(/No allowed domains specified/);
    }
  });

  it('mode none refuses only a user-typed URL', () => {
    expect(() =>
      getCredentialAllowedDomains({ allowedHttpRequestDomains: 'none' }, { userUrl: true }),
    ).toThrow('This credential is configured to prevent use within an HTTP Request or GraphQL node');
    expect(
      getCredentialAllowedDomains({ allowedHttpRequestDomains: 'none' }, { userUrl: false }),
    ).toBeUndefined();
  });

  it('an unknown mode fails closed', () => {
    expect(() =>
      getCredentialAllowedDomains({ allowedHttpRequestDomains: 'maybe' }, { userUrl: false }),
    ).toThrow(CredentialDomainError);
  });
});

describe('ALLOWED_DOMAINS_PROPERTIES', () => {
  it('are the n8n mode and list fields', () => {
    expect(ALLOWED_DOMAINS_PROPERTIES.map((p) => p.name)).toEqual([
      'allowedHttpRequestDomains',
      'allowedDomains',
    ]);
    const [mode, list] = ALLOWED_DOMAINS_PROPERTIES;
    expect(mode.displayName).toBe('Allowed HTTP Request Domains');
    expect(mode.default).toBe('all');
    expect(mode.options?.map((o) => (o as { value: string }).value)).toEqual(['all', 'domains', 'none']);
    expect(list.type).toBe('string');
    expect(list.placeholder).toBe('example.com, *.subdomain.com');
    expect(list.displayOptions).toEqual({ show: { allowedHttpRequestDomains: ['domains'] } });
    // neither field is a secret
    expect(list.typeOptions?.password).toBeFalsy();
  });
});
