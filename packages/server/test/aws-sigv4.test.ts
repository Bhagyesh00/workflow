/** SigV4 against AWS's published examples (P4-08): the signing-key derivation and three signed requests. */
import { amzDate, signAwsRequest, signingKey } from '@workflow/core';
import { describe, expect, it } from 'vitest';

const KEY = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const DATE = new Date('2015-08-30T12:36:00Z');

describe('signature version 4', () => {
  it('derives the signing key of the AWS documentation', () => {
    expect(signingKey(KEY.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });

  it('formats the request date', () => {
    expect(amzDate(DATE)).toBe('20150830T123600Z');
  });

  it('signs get-vanilla of the AWS test suite', () => {
    const out = signAwsRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      date: DATE,
      ...KEY,
    });
    expect(out.canonicalRequest).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(out.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(out.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('signs post-vanilla of the AWS test suite', () => {
    const out = signAwsRequest({
      method: 'POST',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      date: DATE,
      ...KEY,
    });
    expect(out.signature).toBe('5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
  });

  it('signs the ListUsers example of the AWS documentation (query and a content-type header)', () => {
    const out = signAwsRequest({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      region: 'us-east-1',
      service: 'iam',
      date: DATE,
      ...KEY,
    });
    expect(out.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    expect(out.headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date');
  });

  it('signs a session token and sorts query pairs', () => {
    const a = signAwsRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/?b=2&a=1&a=0',
      region: 'us-east-1',
      service: 'service',
      sessionToken: 'tok',
      date: DATE,
      ...KEY,
    });
    expect(a.canonicalRequest.split('\n')[2]).toBe('a=0&a=1&b=2');
    expect(a.headers['x-amz-security-token']).toBe('tok');
    expect(a.headers.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });
});
