/**
 * Phase 2 contract step: registrations, auth types, credential scope, PEM re-wrap, Keep Source reader
 * (C0a); zip central directory reader (C0b).
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { DataObject, Item, NodeProperty, NodePropertyOption } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { credentials, nodes, parseOAuthResponse, signOAuth1Request } from '../src';
import { keepSourceMode } from '../src/nodes/core/extract/keep-source';
import { ExtractFromFileNode } from '../src/nodes/core/files.nodes';
import { authCredentialDescriptions, GENERIC_AUTH_TYPES } from '../src/utils/http';
import { formatPemBlock } from '../src/utils/pem';
import { readZipDirectory } from '../src/utils/zip-directory';
import { FakeHttpClient, runNode } from './harness';

describe('Phase 2 registrations', () => {
  it('registers the new nodes and credentials', () => {
    const names = nodes.map((n) => n.description.name);
    for (const name of [
      'core.jwt',
      'core.totp',
      'core.compression',
      'core.editImage',
      'core.ftp',
      'core.ssh',
    ]) {
      expect(names, name).toContain(name);
    }
    const credentialNames = credentials.map((c) => c.name);
    for (const name of [
      'jwtAuth',
      'totpApi',
      'ftp',
      'sftp',
      'sshPassword',
      'sshPrivateKey',
      'oAuth1Api',
      'httpDigestAuth',
    ]) {
      expect(credentialNames, name).toContain(name);
    }
    expect(typeof signOAuth1Request).toBe('function');
    expect(typeof parseOAuthResponse).toBe('function');
  });

  it('runs a stub node into a clear "not built yet" error', async () => {
    const r = await runNode('core.compression', {});
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/not built yet/);
  });
});

describe('generic auth types', () => {
  it('offers Digest Auth and OAuth1', () => {
    const values = GENERIC_AUTH_TYPES.map((t) => t.value);
    expect(values).toContain('httpDigestAuth');
    expect(values).toContain('oAuth1Api');
    expect(authCredentialDescriptions.map((d) => d.name)).toEqual(expect.arrayContaining(values));
  });

  it('sends credentials with credentialScope userUrl from the HTTP Request node, none without', async () => {
    const http = new FakeHttpClient().on('GET', 'https://api.example.com', () => ({ ok: true }));
    const authed = await runNode(
      'core.httpRequest',
      {
        url: 'https://api.example.com/x',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
      },
      [{ json: {} }],
      { services: { http }, creds: { httpHeaderAuth: { name: 'X-Key', value: 'k' } } },
    );
    expect(authed.status).toBe('success');
    expect(http.requests[0].options.credentialScope).toBe('userUrl');
    expect(http.requests[0].headers['x-key']).toBe('k');

    await runNode('core.httpRequest', { url: 'https://api.example.com/y' }, [{ json: {} }], {
      services: { http },
    });
    expect(http.requests[1].options.credentialScope).toBeUndefined();
  });
});

describe('formatPemBlock', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('re-wraps a key pasted on one line into 64-character body lines', () => {
    const oneLine = pem.trim().replace(/\n/g, ' ');
    const fixed = formatPemBlock(oneLine);
    const lines = fixed.trim().split('\n');
    expect(lines[0]).toBe('-----BEGIN PRIVATE KEY-----');
    expect(lines.at(-1)).toBe('-----END PRIVATE KEY-----');
    for (const line of lines.slice(1, -2)) expect(line).toHaveLength(64);
    expect(() => createPrivateKey(fixed)).not.toThrow();
    expect(fixed.trim()).toBe(pem.trim());
  });

  it('accepts escaped \\n sequences, CRLF and a body with no separators', () => {
    expect(formatPemBlock(pem.trim().replace(/\n/g, '\\n')).trim()).toBe(pem.trim());
    expect(formatPemBlock(pem.replace(/\n/g, '\r\n')).trim()).toBe(pem.trim());
    const body = pem.trim().split('\n').slice(1, -1).join('');
    const glued = `-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----`;
    expect(formatPemBlock(glued).trim()).toBe(pem.trim());
  });

  it('keeps the header fields of an encrypted PKCS#1 key', () => {
    const encrypted = privateKey
      .export({ type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'pw' })
      .toString();
    const fixed = formatPemBlock(encrypted.trim().replace(/\n+/g, ' '));
    expect(fixed.trim()).toBe(encrypted.trim());
    expect(() => createPrivateKey({ key: fixed, passphrase: 'pw' })).not.toThrow();
  });

  it('leaves text without a PEM block as it is (trimmed)', () => {
    expect(formatPemBlock('  plain-secret \n')).toBe('plain-secret');
  });
});

describe('Extract from File: spreadsheets, PDF and Keep Source', () => {
  const props = ExtractFromFileNode.description.properties;
  const options = props.find((p) => p.name === 'options')!.options as NodeProperty[];
  const optionFor = (name: string) => options.find((o) => o.name === name)!;

  it('offers xlsx, xls, ods and pdf', () => {
    const operation = props.find((p) => p.name === 'operation')!;
    const values = (operation.options as NodePropertyOption[]).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['xlsx', 'xls', 'ods', 'pdf']));
    for (const name of ['headerRow', 'includeEmptyCells', 'maxRowCount']) {
      expect(optionFor(name).displayOptions?.show?.['/operation'], name).toEqual(
        expect.arrayContaining(['csv', 'xlsx', 'xls', 'ods']),
      );
    }
  });

  it('shows ONE Keep Source option json | binary | both for fromJson, text, binaryToPropery and pdf', () => {
    expect(options.filter((o) => o.name === 'keepSource')).toHaveLength(1);
    const keep = optionFor('keepSource');
    expect(keep.type).toBe('options');
    expect(keep.default).toBe('json');
    expect((keep.options as NodePropertyOption[]).map((o) => o.value)).toEqual(['json', 'binary', 'both']);
    expect(keep.displayOptions?.show?.['/operation']).toEqual(['fromJson', 'text', 'binaryToPropery', 'pdf']);
  });

  it('keepSourceMode reads old booleans and new strings', () => {
    expect(keepSourceMode(undefined)).toBe('none');
    expect(keepSourceMode(false)).toBe('none');
    expect(keepSourceMode(true)).toBe('both');
    expect(keepSourceMode('json')).toBe('json');
    expect(keepSourceMode('binary')).toBe('binary');
    expect(keepSourceMode('both')).toBe('both');
  });

  const input = (): Item[] => [
    {
      json: { keep: 1 },
      binary: { data: { data: Buffer.from('hi').toString('base64'), mimeType: 'text/plain' } },
    },
  ];
  const extractText = (keepSource?: unknown) =>
    runNode(
      'core.extractFromFile',
      { operation: 'text', options: keepSource === undefined ? {} : { keepSource } },
      input(),
    );

  it.each([
    [undefined, { data: 'hi' }, false],
    [false, { data: 'hi' }, false],
    [true, { keep: 1, data: 'hi' }, true],
    ['json', { keep: 1, data: 'hi' }, false],
    ['binary', { data: 'hi' }, true],
    ['both', { keep: 1, data: 'hi' }, true],
  ] as const)('keepSource %s keeps the right parts', async (keepSource, json, binary) => {
    const r = await extractText(keepSource);
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([json]);
    expect(Boolean(r.items[0][0].binary?.data)).toBe(binary);
  });

  it.each(['xlsx', 'xls', 'ods', 'pdf'])('%s dispatches inside continueOnFail', async (operation) => {
    const failing = await runNode('core.extractFromFile', { operation }, input());
    expect(failing.status).toBe('error');
    const kept = await runNode('core.extractFromFile', { operation }, input(), {
      node: { onError: 'continueRegularOutput' },
    });
    expect(kept.status).toBe('success');
    expect((kept.outputs[0][0] as DataObject).error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------
// C0b: zip central directory reader

interface TestEntry {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
  flags?: number;
}

/** a small zip built by hand: local headers, data, central directory, end record */
function makeZip(entries: TestEntry[], options: { comment?: string; entryCount?: number } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const stored = entry.deflate ? deflateRawSync(entry.data) : Buffer.from(entry.data);
    const method = entry.deflate ? 8 : 0;
    const flags = (entry.flags ?? 0) | 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0x12345678, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.entryCount ?? entries.length, 8);
  end.writeUInt16LE(options.entryCount ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, directory, end, comment]));
}

describe('readZipDirectory', () => {
  const text = new TextEncoder().encode('hello hello hello hello');

  it('lists the entries of a small zip', () => {
    const zip = makeZip([
      { name: 'a.txt', data: text },
      { name: 'dir/b.txt', data: text, deflate: true, flags: 0x0008 },
      { name: 'dir/', data: new Uint8Array() },
    ]);
    const entries = readZipDirectory(zip, { maxEntries: 10 });
    expect(
      entries.map(({ name, method, flags, declaredSize }) => ({ name, method, flags, declaredSize })),
    ).toEqual([
      { name: 'a.txt', method: 0, flags: 0x0800, declaredSize: text.length },
      { name: 'dir/b.txt', method: 8, flags: 0x0808, declaredSize: text.length },
      { name: 'dir/', method: 0, flags: 0x0800, declaredSize: 0 },
    ]);
    expect(entries[0]).toMatchObject({
      compressedSize: text.length,
      localHeaderOffset: 0,
      crc32: 0x12345678,
    });
    expect(entries[1].compressedSize).toBe(deflateRawSync(text).length);
    expect(entries[1].localHeaderOffset).toBe(30 + 5 + text.length);
  });

  it('finds the end record behind a comment', () => {
    const zip = makeZip([{ name: 'a.txt', data: text }], {
      comment: 'PK\u0005\u0006 is not an end record, only part of the comment',
    });
    expect(readZipDirectory(zip, { maxEntries: 1 }).map((e) => e.name)).toEqual(['a.txt']);
  });

  it('reads a zip made by Python zipfile', () => {
    // zipfile.ZipFile(..., 'w', ZIP_DEFLATED).writestr('x.txt', 'abc'), base64
    const zip = Buffer.from(
      'UEsDBBQAAAAIAAAAIVzCQSQ1BQAAAAMAAAAFAAAAeC50eHRLTEoGAFBLAQIUABQAAAAIAAAAIVzCQSQ1BQAAAAMAAAAFAAAAAAAAAAAAAACAAQAAAAB4LnR4dFBLBQYAAAAAAQABADMAAAAoAAAAAAA=',
      'base64',
    );
    expect(readZipDirectory(new Uint8Array(zip), { maxEntries: 5 })).toEqual([
      {
        name: 'x.txt',
        method: 8,
        flags: 0,
        compressedSize: 5,
        declaredSize: 3,
        crc32: 0x352441c2,
        localHeaderOffset: 0,
      },
    ]);
  });

  it('refuses more entries than allowed', () => {
    const zip = makeZip([
      { name: 'a', data: text },
      { name: 'b', data: text },
    ]);
    expect(() => readZipDirectory(zip, { maxEntries: 1 })).toThrow(/more than 1 entries/);
  });

  it('refuses zip64, truncated and non-zip input', () => {
    expect(() =>
      readZipDirectory(makeZip([{ name: 'a', data: text }], { entryCount: 0xffff }), { maxEntries: 9 }),
    ).toThrow(/ZIP64/);
    const zip = makeZip([{ name: 'a.txt', data: text }]);
    expect(() => readZipDirectory(zip.subarray(0, zip.length - 30), { maxEntries: 9 })).toThrow(
      /not a zip|truncated/i,
    );
    expect(() => readZipDirectory(zip.subarray(10), { maxEntries: 9 })).toThrow(/truncated|corrupt/i);
    expect(() => readZipDirectory(new TextEncoder().encode('plain text'), { maxEntries: 9 })).toThrow(
      /not a zip/i,
    );
    expect(() => readZipDirectory(new Uint8Array(), { maxEntries: 9 })).toThrow(/not a zip/i);
  });

  it('refuses a directory whose entry count does not match the end record', () => {
    const zip = makeZip([{ name: 'a.txt', data: text }], { entryCount: 2 });
    expect(() => readZipDirectory(zip, { maxEntries: 9 })).toThrow(/corrupt|truncated/i);
  });
});
