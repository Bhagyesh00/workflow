/**
 * P6-72 (S4 L1): the remote URL rules of `parseRemoteUrl`. https, http, ssh and the scp form pass; every other
 * scheme, `ext::`, `file://`, control characters, a leading `-`, `::`, a password and a path with a quote, `$`,
 * `;`, a backtick, `\` or whitespace are refused, and the error never echoes the URL.
 */
import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../src/services/source-control/url';

describe('parseRemoteUrl accepts', () => {
  it('https with the default port', () => {
    expect(parseRemoteUrl('https://github.com/acme/flows.git')).toEqual({
      kind: 'https',
      host: 'github.com',
      port: 443,
      path: '/acme/flows.git',
    });
  });

  it('http with a port', () => {
    expect(parseRemoteUrl('http://127.0.0.1:8080/repo.git')).toEqual({
      kind: 'http',
      host: '127.0.0.1',
      port: 8080,
      path: '/repo.git',
    });
  });

  it('https with a user name and no password', () => {
    expect(parseRemoteUrl('https://deploy@git.example.com/team/repo.git')).toMatchObject({
      kind: 'https',
      host: 'git.example.com',
      user: 'deploy',
      path: '/team/repo.git',
    });
  });

  it('ssh:// with a user and a port', () => {
    expect(parseRemoteUrl('ssh://git@127.0.0.1:2222/repo.git')).toEqual({
      kind: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      path: '/repo.git',
      user: 'git',
    });
  });

  it('the scp form user@host:path', () => {
    expect(parseRemoteUrl('git@github.com:acme/flows.git')).toEqual({
      kind: 'ssh',
      host: 'github.com',
      port: 22,
      path: 'acme/flows.git',
      user: 'git',
    });
  });

  it('an IPv6 host', () => {
    expect(parseRemoteUrl('ssh://git@[::1]:2222/repo.git')).toMatchObject({
      kind: 'ssh',
      host: '::1',
      port: 2222,
    });
  });

  it('upper-case schemes', () => {
    expect(parseRemoteUrl('HTTPS://example.com/r.git').kind).toBe('https');
  });
});

describe('parseRemoteUrl refuses', () => {
  const refused: Array<[string, string]> = [
    ['ext:: transport', 'ext::sh -c touch% /tmp/pwned'],
    ['a transport::address override', 'https::https://example.com/r.git'],
    ['file://', 'file:///etc/passwd'],
    ['git://', 'git://example.com/r.git'],
    ['ftp://', 'ftp://example.com/r.git'],
    ['a scheme with no slashes', 'javascript:alert(1)'],
    ['a local path', '/srv/git/repo.git'],
    ['a relative path', 'repo.git'],
    ['a Windows path', 'C:\\repos\\repo.git'],
    ['a host:path with no user', 'example.com:repo.git'],
    ['a leading dash', '-oProxyCommand=evil'],
    ['a leading dash in the scp host', 'git@-oProxyCommand=evil:repo.git'],
    ['a password', 'https://user:secret@example.com/r.git'],
    ['an empty password', 'https://user:@example.com/r.git'],
    ['a password in ssh://', 'ssh://git:pw@example.com/r.git'],
    ['a newline', 'https://example.com/r.git\n'],
    ['a NUL', 'https://example.com/r\u0000.git'],
    ['a tab', 'git@example.com:r\t.git'],
    ['DEL', 'https://example.com/r\u007f.git'],
    ['a single quote in the path', "git@example.com:repo'.git"],
    ['a quote that breaks out of the exec quoting', "ssh://git@example.com/repo.git'; touch x; echo '"],
    ['a double quote in the path', 'git@example.com:repo".git'],
    ['a backslash in the path', 'git@example.com:repo\\x.git'],
    ['a backtick in the path', 'git@example.com:repo`id`.git'],
    ['a dollar in the path', 'git@example.com:$(id).git'],
    ['a semicolon in the path', 'git@example.com:repo;id.git'],
    ['a space in the path', 'git@example.com:my repo.git'],
    ['an encoded quote in the path', 'ssh://git@example.com/repo%27.git'],
    ['an encoded space in the path', 'https://example.com/my%20repo.git'],
    ['a query string', 'https://example.com/r.git?x=1'],
    ['a fragment', 'https://example.com/r.git#main'],
    ['no host', 'https:///r.git'],
    ['no path', 'https://example.com'],
    ['an empty string', ''],
  ];

  it.each(refused)('%s', (_label, url) => {
    let thrown: unknown;
    try {
      parseRemoteUrl(url);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { statusCode?: number }).statusCode).toBe(400);
    expect((thrown as { code?: string }).code).toBe('source_control_url');
    // the URL (it can hold a password) is never echoed
    expect((thrown as Error).message).not.toContain('secret');
    if (url.length > 3) expect((thrown as Error).message).not.toContain(url);
  });

  it('a value that is not a string', () => {
    expect(() => parseRemoteUrl(42 as unknown as string)).toThrow(/not valid/);
  });
});
