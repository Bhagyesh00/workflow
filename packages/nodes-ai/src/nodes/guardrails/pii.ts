/**
 * Guardrails PII check: 36 entity patterns. Every pattern is bounded (no unbounded nested repeat),
 * so a long text cannot make one backtrack for long, and each passes the shared safe-regex scan.
 * Patterns overlap on purpose: many 8 to 11 digit numbers match more than one entity.
 */
import { createSafeRegExp } from '@workflow/workflow';

/** a found value: entity or check token plus its offsets in the text */
export interface Span {
  type: string;
  start: number;
  end: number;
}

interface EntityDef {
  name: string;
  patterns: Array<[source: string, flags: string, accept?: (value: string) => boolean]>;
}

const validOctets = (value: string): boolean => value.split('.').every((part) => Number(part) <= 255);

const GI = 'gi';
const G = 'g';

/** Entity key to display name and patterns, in the order the editor lists them. */
const ENTITIES: Record<string, EntityDef> = {
  CREDIT_CARD: {
    name: 'Credit Card',
    patterns: [
      [String.raw`\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b`, G],
      [String.raw`\b(?:\d{4}[ -]?){3}\d{4}\b`, G],
    ],
  },
  CRYPTO: {
    name: 'Crypto Wallet',
    patterns: [
      [String.raw`\bbc1[a-z0-9]{25,59}\b`, G],
      [String.raw`\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b`, G],
      [String.raw`\b0x[a-fA-F0-9]{40}\b`, G],
    ],
  },
  DATE_TIME: {
    name: 'Date/Time',
    patterns: [
      [String.raw`\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b`, G],
      [String.raw`\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b`, G],
    ],
  },
  EMAIL_ADDRESS: {
    name: 'Email Address',
    patterns: [
      [
        String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,5}\.[A-Za-z]{2,24}\b`,
        G,
      ],
    ],
  },
  IBAN_CODE: {
    name: 'IBAN',
    patterns: [
      [String.raw`\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7} [A-Z0-9]{1,3}\b`, GI],
      [String.raw`\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}\b`, GI],
      [String.raw`\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`, GI],
    ],
  },
  IP_ADDRESS: {
    name: 'IP Address',
    patterns: [
      [String.raw`\b\d{1,3}(?:\.\d{1,3}){3}\b`, G, validOctets],
      [String.raw`\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b`, G],
      [
        String.raw`(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{1,4}:){1,6}:(?:[A-Fa-f0-9]{1,4}(?::[A-Fa-f0-9]{1,4}){0,5})?(?![A-Za-z0-9:])`,
        G,
      ],
      [String.raw`(?<![A-Za-z0-9:])::(?:[A-Fa-f0-9]{1,4}:){0,6}[A-Fa-f0-9]{1,4}(?![A-Za-z0-9:])`, G],
    ],
  },
  LOCATION: {
    name: 'Location',
    patterns: [
      [
        String.raw`\b(?:\d{1,5}[ \t]{1,3})?(?:[A-Za-z]{1,20}[ \t]{1,3}){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Square|Sq|Highway|Hwy)\b`,
        GI,
      ],
    ],
  },
  PHONE_NUMBER: {
    name: 'Phone Number',
    patterns: [
      [String.raw`(?<![\d+])\+\d{1,3}(?:[ .-]\d{2,4}){2,5}(?!\d)`, G],
      [String.raw`(?<![\d+])\+\d{8,15}(?!\d)`, G],
      [String.raw`(?<![\d+])(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)`, G],
    ],
  },
  MEDICAL_LICENSE: {
    name: 'Medical License',
    patterns: [[String.raw`\b[ABCDEFGHJKLMPRSTUX][A-Z9]\d{7}\b`, GI]],
  },
  US_BANK_NUMBER: { name: 'US Bank Number', patterns: [[String.raw`\b\d{8,17}\b`, G]] },
  US_DRIVER_LICENSE: { name: 'US Driver License', patterns: [[String.raw`\b[A-Z]{1,2}\d{6,8}\b`, GI]] },
  US_ITIN: { name: 'US ITIN', patterns: [[String.raw`\b9\d{2}[ -]?[7-9]\d[ -]?\d{4}\b`, G]] },
  US_PASSPORT: { name: 'US Passport', patterns: [[String.raw`\b[A-Z]?\d{8,9}\b`, GI]] },
  US_SSN: {
    name: 'US SSN',
    patterns: [[String.raw`\b(?!000|666|9\d{2})\d{3}[ -]?(?!00)\d{2}[ -]?(?!0000)\d{4}\b`, G]],
  },
  UK_NHS: { name: 'UK NHS', patterns: [[String.raw`\b\d{3}[ -]?\d{3}[ -]?\d{4}\b`, G]] },
  UK_NINO: {
    name: 'UK NINO',
    patterns: [
      [
        String.raw`\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b`,
        GI,
      ],
    ],
  },
  ES_NIF: { name: 'ES NIF', patterns: [[String.raw`\b\d{8}[ -]?[A-Z]\b`, GI]] },
  ES_NIE: { name: 'ES NIE', patterns: [[String.raw`\b[XYZ][ -]?\d{7}[ -]?[A-Z]\b`, GI]] },
  IT_FISCAL_CODE: {
    name: 'IT Fiscal Code',
    patterns: [[String.raw`\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b`, GI]],
  },
  IT_DRIVER_LICENSE: { name: 'IT Driver License', patterns: [[String.raw`\b[A-Z]{2}\d{7}[A-Z]\b`, GI]] },
  IT_VAT_CODE: { name: 'IT VAT Code', patterns: [[String.raw`\b(?:IT)?\d{11}\b`, GI]] },
  IT_PASSPORT: { name: 'IT Passport', patterns: [[String.raw`\b[A-Z]{2}\d{7}\b`, GI]] },
  IT_IDENTITY_CARD: {
    name: 'IT Identity Card',
    patterns: [
      [String.raw`\b[A-Z]{2}\d{5}[A-Z]{2}\b`, GI],
      [String.raw`\b\d{7}[A-Z]{2}\b`, GI],
    ],
  },
  PL_PESEL: { name: 'PL PESEL', patterns: [[String.raw`\b\d{11}\b`, G]] },
  SG_NRIC_FIN: { name: 'SG NRIC/FIN', patterns: [[String.raw`\b[STFGM]\d{7}[A-Z]\b`, GI]] },
  SG_UEN: {
    name: 'SG UEN',
    patterns: [
      [String.raw`\b\d{8,9}[A-Z]\b`, GI],
      [String.raw`\b[TSR]\d{2}[A-Z]{2}\d{4}[A-Z]\b`, GI],
    ],
  },
  AU_ABN: { name: 'AU ABN', patterns: [[String.raw`\b\d{2} ?\d{3} ?\d{3} ?\d{3}\b`, G]] },
  AU_ACN: { name: 'AU ACN', patterns: [[String.raw`\b\d{3} ?\d{3} ?\d{3}\b`, G]] },
  AU_TFN: { name: 'AU TFN', patterns: [[String.raw`\b\d{3} ?\d{3} ?\d{2,3}\b`, G]] },
  AU_MEDICARE: { name: 'AU Medicare', patterns: [[String.raw`\b[2-6]\d{3} ?\d{5} ?\d{1,2}\b`, G]] },
  IN_PAN: { name: 'IN PAN', patterns: [[String.raw`\b[A-Z]{5}\d{4}[A-Z]\b`, GI]] },
  IN_AADHAAR: { name: 'IN AADHAAR', patterns: [[String.raw`\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b`, G]] },
  IN_VEHICLE_REGISTRATION: {
    name: 'IN Vehicle Registration',
    patterns: [[String.raw`\b[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{4}\b`, GI]],
  },
  IN_VOTER: { name: 'IN Voter', patterns: [[String.raw`\b[A-Z]{3}\d{7}\b`, GI]] },
  IN_PASSPORT: { name: 'IN Passport', patterns: [[String.raw`\b[A-PR-WY][1-9]\d{6}\b`, GI]] },
  FI_PERSONAL_IDENTITY_CODE: {
    name: 'FI Personal Identity Code',
    patterns: [[String.raw`\b\d{6}[-+A]\d{3}[0-9A-Y]\b`, GI]],
  },
};

export const PII_ENTITIES: string[] = Object.keys(ENTITIES);
export const PII_NAME_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITIES).map(([key, def]) => [key, def.name]),
);

const MAX_MATCHES_PER_PATTERN = 10_000;

/** compiled once; lastIndex is reset before every scan */
const compiled = new Map<string, Array<{ pattern: RegExp; accept?: (value: string) => boolean }>>();

function patternsOf(entity: string) {
  let list = compiled.get(entity);
  if (!list) {
    list = (ENTITIES[entity]?.patterns ?? []).map(([source, flags, accept]) => ({
      pattern: createSafeRegExp(source, flags),
      accept,
    }));
    compiled.set(entity, list);
  }
  return list;
}

/** Offsets of every value that matches one of the chosen entities. Unknown keys are ignored. */
export function detectPii(text: string, entities: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const entity of new Set(entities)) {
    for (const { pattern, accept } of patternsOf(entity)) {
      pattern.lastIndex = 0;
      let count = 0;
      for (
        let match = pattern.exec(text);
        match && count < MAX_MATCHES_PER_PATTERN;
        match = pattern.exec(text)
      ) {
        count++;
        if (match[0].length === 0) {
          pattern.lastIndex++;
          continue;
        }
        if (accept && !accept(match[0])) continue;
        spans.push({ type: entity, start: match.index, end: match.index + match[0].length });
      }
    }
  }
  return withoutNested(spans);
}

/** one entity found twice by two patterns, or inside a longer value of the same entity, counts once */
function withoutNested(spans: Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const span of ordered) {
    if (!kept.some((k) => k.type === span.type && k.start <= span.start && k.end >= span.end))
      kept.push(span);
  }
  return kept;
}
