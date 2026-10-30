/**
 * White-label branding: the brand colour, name and logo from GET /rest/settings are applied as CSS
 * custom properties, the document title and a generated favicon. Values are validated before they
 * reach CSS or the DOM (only hex colours; only http(s) and raster data: image URLs).
 */
import type { Brand } from '../api/types';

export const DEFAULT_BRAND_COLOR = '#3346d3';

export function sanitizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
    if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
    return v.toLowerCase();
  }
  return null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** white or near-black text, whichever has more contrast on `hex` */
export function readableTextOn(hex: string): string {
  const l = relativeLuminance(hex);
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastDark = (l + 0.05) / 0.0636;
  return contrastWhite >= contrastDark ? '#ffffff' : '#111a22';
}

export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const v = url.trim();
  if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v)) return v;
  try {
    const parsed = new URL(v, window.location.origin);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
  } catch {
    return null;
  }
  return null;
}

export function brandInitial(name: string): string {
  const match = name.trim().match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? 'W').toUpperCase();
}

function faviconSvg(color: string, initial: string, textColor: string): string {
  const safeInitial = initial.replace(/[<>&"']/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${color}"/><text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="${textColor}">${safeInitial}</text></svg>`;
}

export function applyBrand(brand: Brand, root: HTMLElement = document.documentElement): void {
  const color = sanitizeColor(brand.primaryColor) ?? DEFAULT_BRAND_COLOR;
  const onBrand = readableTextOn(color);
  root.style.setProperty('--wf-brand', color);
  root.style.setProperty('--wf-on-brand', onBrand);
  const name = brand.name?.trim() || 'Workflow';
  document.title = name;

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  const logo = safeImageUrl(brand.logoUrl);
  link.href =
    logo ?? `data:image/svg+xml,${encodeURIComponent(faviconSvg(color, brandInitial(name), onBrand))}`;
}

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_KEY = 'wf.theme';

export function readThemePreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // storage unavailable (private mode, sandboxed frames)
  }
  return 'system';
}

export function storeThemePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    // ignore
  }
}

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function applyTheme(pref: ThemePreference): 'light' | 'dark' {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  return theme;
}
