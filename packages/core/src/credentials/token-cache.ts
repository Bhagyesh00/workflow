/**
 * Short-lived access tokens, kept per secret and scope. The key is a sha256, so neither is held here, and
 * two credentials share a token only if they hold the same secret and ask for the same scope. Every caller
 * passes as scope the JSON of its token URL, subject, scopes, resource and role.
 */
import { createHash } from 'node:crypto';
import type { AccessToken } from '@workflow/workflow';

const MAX_ENTRIES = 1000;
/** a token this close to its end is not handed out: the request it goes on still has to arrive */
const EARLY_EXPIRY_MS = 60_000;

interface CachedToken {
  token: string;
  usableUntil: number;
}

export class TokenCache {
  private readonly entries = new Map<string, CachedToken>();
  private readonly fetching = new Map<string, Promise<string>>();

  get(secret: string, scope: string, fetch: () => Promise<AccessToken>): Promise<string> {
    const key = createHash('sha256')
      .update(JSON.stringify([secret, scope]))
      .digest('hex');
    const cached = this.entries.get(key);
    if (cached && Date.now() < cached.usableUntil) return Promise.resolve(cached.token);
    const running = this.fetching.get(key);
    if (running) return running;
    const started = this.fetchAndKeep(key, fetch).finally(() => this.fetching.delete(key));
    this.fetching.set(key, started);
    return started;
  }

  private async fetchAndKeep(key: string, fetch: () => Promise<AccessToken>): Promise<string> {
    const { token, expiresInSeconds } = await fetch();
    const usableUntil = Date.now() + expiresInSeconds * 1000 - EARLY_EXPIRY_MS;
    this.entries.delete(key);
    if (Date.now() < usableUntil) {
      if (this.entries.size >= MAX_ENTRIES) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
      this.entries.set(key, { token, usableUntil });
    }
    return token;
  }
}

/** the one cache `createCredentialHelpers` uses */
export const sharedTokenCache = new TokenCache();
