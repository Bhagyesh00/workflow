/**
 * "Allowed HTTP Request Domains" for credentials: which hosts a credential may be sent to.
 *
 * STUB from the Phase 2 contract step (C0a): every request is unrestricted. Lane L7 writes the
 * matcher, the credential fields and the error wording.
 */
import { WorkflowError } from './errors';
import type { DataObject, NodeProperty } from './interfaces';

/** the credential fields added to credential types that send requests (empty in the stub) */
export const ALLOWED_DOMAINS_PROPERTIES: NodeProperty[] = [];

/** thrown before a request when its URL (or a redirect hop) is outside the credential's list */
export class CredentialDomainError extends WorkflowError {
  constructor(
    message: string,
    /** the host that was refused */
    readonly host?: string,
  ) {
    super(message, { code: 'CREDENTIAL_DOMAIN' });
  }
}

/** true when `host` matches an entry of `list` (stub: always true) */
export function isDomainAllowed(_host: string, _list: string[]): boolean {
  return true;
}

/**
 * The host list a credential allows, or undefined when it is unrestricted. `userUrl`: the request URL
 * was typed by the user, so the `none` mode applies (stub: always undefined).
 */
export function getCredentialAllowedDomains(
  _data: DataObject,
  _options: { userUrl: boolean },
): string[] | undefined {
  return undefined;
}

/** throws CredentialDomainError when `url` is outside `list`; undefined list = unrestricted (stub: no-op) */
export function assertCredentialUrlAllowed(_url: string, _list: string[] | undefined): void {}
