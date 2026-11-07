/** Guardrails URL check (fixed bounded patterns, no user pattern here): finds URLs, bare domains and IPs, and blocks by scheme, userinfo and allow list. */
import type { Span } from './pii';

export interface UrlOptions {
  /** domains, full URLs with a path prefix, IPs or IPv4 CIDR ranges */
  allowedUrls: string[];
  allowedSchemes: string[];
  blockUserinfo: boolean;
  allowSubdomains: boolean;
}

export interface UrlResult {
  /** distinct URLs found */
  detected: number;
  /** distinct URLs that passed */
  allowed: number;
  /** every place a blocked URL stands in the text */
  blocked: Span[];
  /** distinct fixed reason phrases (never part of the text) */
  blockedReasons: string[];
}

const NO_HOST_SCHEMES = new Set(['data', 'javascript', 'vbscript', 'mailto']);
const FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'sql',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'zip',
  'gz',
  'tar',
  'log',
  'ini',
  'toml',
  'conf',
  'exe',
  'dll',
]);
const TRAILING = /[.,;:!?)\]}'"]+$/;

const SCHEME_URL = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'\x60]{1,2048}/gi;
const SPECIAL_URL = /\b(?:data|javascript|vbscript|mailto):[^\s<>"'\x60]{1,2048}/gi;
const BARE_URL =
  /(?<![\w@.:/-])[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8}(?::\d{1,5})?(?:\/[^\s<>"'\x60]{0,2048})?/gi;

interface Candidate {
  value: string;
  start: number;
  end: number;
  kind: 'scheme' | 'special' | 'bare';
}

function collect(text: string): Candidate[] {
  const found: Candidate[] = [];
  const overlaps = (start: number, end: number) => found.some((c) => start < c.end && end > c.start);
  const scan = (pattern: RegExp, kind: Candidate['kind']) => {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const value = m[0].replace(TRAILING, '');
      const start = m.index;
      const end = start + value.length;
      if (!value || overlaps(start, end)) continue;
      if (kind === 'bare') {
        if (text[end] === '@') continue;
        const host = value.split(/[:/]/, 1)[0];
        const labels = host.split('.');
        const tld = labels[labels.length - 1].toLowerCase();
        const isIp = labels.length === 4 && labels.every((l) => /^\d{1,3}$/.test(l));
        if (!isIp && (!/^[a-z]{2,24}$/.test(tld) || FILE_EXTENSIONS.has(tld))) continue;
      }
      found.push({ value, start, end, kind });
    }
  };
  scan(SCHEME_URL, 'scheme');
  scan(SPECIAL_URL, 'special');
  scan(BARE_URL, 'bare');
  return found.sort((a, b) => a.start - b.start);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === undefined || b === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

function pathAllowed(entryPath: string, path: string): boolean {
  if (entryPath === '/' || entryPath === '') return true;
  const base = entryPath.endsWith('/') ? entryPath : `${entryPath}/`;
  return path === entryPath || path.startsWith(base);
}

function hostAllowed(entryHost: string, host: string, subdomains: boolean): boolean {
  const e = normalizeHost(entryHost);
  const h = normalizeHost(host);
  return h === e || (subdomains && h.endsWith(`.${e}`));
}

function onAllowList(entries: readonly string[], host: string, path: string, subdomains: boolean): boolean {
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(entry)) {
      if (inCidr(host, entry)) return true;
      continue;
    }
    if (entry.includes('://') || entry.includes('/')) {
      try {
        const url = new URL(entry.includes('://') ? entry : `https://${entry}`);
        if (hostAllowed(url.hostname, host, subdomains) && pathAllowed(url.pathname, path)) return true;
      } catch {
        // an unreadable entry allows nothing
      }
      continue;
    }
    if (hostAllowed(entry, host, subdomains)) return true;
  }
  return false;
}

/** The reason a URL is blocked, or undefined when it passes. */
function judge(candidate: Candidate, options: UrlOptions): string | undefined {
  if (candidate.kind === 'special') {
    const scheme = candidate.value.slice(0, candidate.value.indexOf(':')).toLowerCase();
    return options.allowedSchemes.includes(scheme) ? undefined : 'Scheme is not allowed';
  }
  let url: URL;
  try {
    url = new URL(candidate.kind === 'bare' ? `https://${candidate.value}` : candidate.value);
  } catch {
    return 'Not a valid URL';
  }
  if (candidate.kind === 'scheme') {
    const scheme = url.protocol.slice(0, -1);
    if (NO_HOST_SCHEMES.has(scheme) || !options.allowedSchemes.includes(scheme)) {
      return 'Scheme is not allowed';
    }
  }
  if (options.blockUserinfo && (url.username || url.password)) return 'Contains user info';
  const host = url.hostname;
  if (!host || !onAllowList(options.allowedUrls, host, url.pathname, options.allowSubdomains)) {
    return 'Not in the allow list';
  }
  return undefined;
}

export function checkUrls(text: string, options: UrlOptions): UrlResult {
  const verdicts = new Map<string, string | undefined>();
  const blocked: Span[] = [];
  const reasons = new Set<string>();
  for (const candidate of collect(text)) {
    const key = `${candidate.kind}:${candidate.value}`;
    if (!verdicts.has(key)) verdicts.set(key, judge(candidate, options));
    const reason = verdicts.get(key);
    if (reason) {
      reasons.add(reason);
      blocked.push({ type: 'URL', start: candidate.start, end: candidate.end });
    }
  }
  const blockedValues = [...verdicts.values()].filter(Boolean).length;
  return {
    detected: verdicts.size,
    allowed: verdicts.size - blockedValues,
    blocked,
    blockedReasons: [...reasons],
  };
}
