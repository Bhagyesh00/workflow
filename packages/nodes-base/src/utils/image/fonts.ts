/**
 * Edit Image fonts: the bundled Liberation Sans (the default, so text looks the same on every machine and in the
 * slim server image) plus the font families installed on the system. Only family names leave this module, never
 * file paths. The bundled file is Liberation Sans 2.1.5 Regular from the official release, under the SIL Open
 * Font License 1.1 (assets/fonts/LICENSE_LIBERATION).
 */
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';
import { ImageError } from './canvas';

export const DEFAULT_FONT = 'Liberation Sans';

const BUNDLED_FONT = fileURLToPath(
  new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url),
);

let registered = false;

/** registers the bundled font once (system fonts are found by the canvas library itself) */
export function ensureFonts(): void {
  if (registered) return;
  registered = true;
  // registered even when the system has a font of that name: the bundled file is the one we test with
  GlobalFonts.registerFromPath(BUNDLED_FONT, DEFAULT_FONT);
}

/** the font family names text can use, sorted, the default first */
export function fontFamilies(): string[] {
  ensureFonts();
  const names = new Set(
    GlobalFonts.families.map((f) => f.family).filter((name) => name && name !== DEFAULT_FONT),
  );
  return [DEFAULT_FONT, ...[...names].sort((a, b) => a.localeCompare(b))];
}

/** the family to draw with; an empty value is the default, an unknown one is an error */
export function resolveFont(name: unknown): string {
  ensureFonts();
  const family = String(name ?? '').trim() || DEFAULT_FONT;
  if (!GlobalFonts.has(family)) {
    throw new ImageError(`The font "${family}" is not available on this instance`);
  }
  return family;
}

/** a CSS font shorthand for the canvas, with the family quoted */
export function cssFont(sizePx: number, family: string): string {
  return `${sizePx}px "${family.replace(/["\\]/g, '')}"`;
}
