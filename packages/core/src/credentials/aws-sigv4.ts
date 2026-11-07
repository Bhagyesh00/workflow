/**
 * AWS Signature Version 4 on node:crypto. L1 moves the server's tested copy here
 * (server/src/services/secrets/providers/aws-sigv4.ts). It signs with the keys it is given and reads
 * nothing from the host.
 */
import type { AwsSignInput } from '@workflow/workflow';

export type SigV4Input = AwsSignInput;

export interface SigV4Result {
  /** the given headers plus x-amz-date, authorization and, with a session token, x-amz-security-token */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function amzDate(_date: Date): string {
  throw new Error('not implemented (L1)');
}

export function signingKey(
  _secretAccessKey: string,
  _day: string,
  _region: string,
  _service: string,
): Buffer {
  throw new Error('not implemented (L1)');
}

export function signAwsRequest(_input: SigV4Input): SigV4Result {
  throw new Error('not implemented (L1)');
}
