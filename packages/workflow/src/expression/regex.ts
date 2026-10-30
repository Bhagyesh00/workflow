/**
 * Regex safety policy for user-authored patterns.
 *
 * JavaScript regexes backtrack, so a pattern like `(a+)+$` takes exponential time on a short
 * non-matching input and blocks the event loop with no way to interrupt it. Every pattern that
 * reaches the regex engine from an expression (literals, the RegExp facade, string methods that
 * compile strings to regexes, luxon format parsers) and the Filter node's regex operator goes
 * through this check.
 *
 * The scanner models each term by the characters it can consume and by where its length can vary:
 * `lead` / `trail` are the characters a variable-length part can trade with its neighbour one at
 * a time, `leadCycle` / `trailCycle` the characters of whole repetitions a variable-count group can
 * trade. Two neighbours that can trade the same text split the input in several ways.
 *
 * Rejected:
 *  - backreferences (`\1`, `\k<name>`)
 *  - a repeated group whose iterations can split the input in more than one way (`(a+)+`, `(a*)*`,
 *    `(\w+\.?)+`, `(a?){20}`), whose alternatives can start with the same character (`(a|ab)*`),
 *    or that contains overlapping alternatives or a lookaround with a repeat (`((a|a)b)*`)
 *  - two neighbouring repeats (only optional terms between them) that can match the same text
 *    (`.*.*`, `\d*\d*`, `\s*-?\s*`, `(ab)*(ab)*`)
 *  - three or more repeats linked by separators they can all consume (`.*a.*a.*`)
 *  - more than four groups of alternatives that can start with the same character (`(a|a)(a|a)...`)
 *
 * Repeats separated by a mandatory character they cannot consume stay allowed, so linear patterns
 * such as `^[\w.+-]+@([\w-]+\.)+[\w-]{2,}$` and `^(\d+,)*\d+$` pass. One repeat retried at every
 * start position, or two linked by a separator they can consume (`^(.*)-(.*)$`), still cost O(n^2)
 * on adversarial input: only a linear engine or a preemptive timeout removes that.
 */
import { ExpressionError } from '../errors';

type Range = readonly [number, number];

/** a set of characters; `null` stands for "any character" */
type CharSet = Range[] | null;

const NONE: Range[] = [];

interface Quantifier {
  min: number;
  max: number;
}

interface Term {
  /** characters the term can start with when it consumes anything */
  first: CharSet;
  /** every character the term can consume */
  chars: CharSet;
  /** can match the empty string */
  nullable: boolean;
  /** a variable quantifier (min !== max) appears on this term or inside it */
  variable: boolean;
  /** characters a variable-length part at the start can trade with the term before (NONE: fixed start) */
  lead: CharSet;
  /** same at the end */
  trail: CharSet;
  /** characters of whole repetitions a variable-count group can trade at its start */
  leadCycle: CharSet;
  /** same at the end */
  trailCycle: CharSet;
  /** contains alternatives that can start with the same character */
  ambiguous: boolean;
  /** contains a lookaround with a variable quantifier */
  lookaround: boolean;
}

interface Atom {
  term: Term;
  /** set for parenthesized groups: lookaround or not, and whether its alternatives overlap */
  group?: { assertion: boolean; overlap: boolean };
}

/** more groups than this with alternatives that start alike multiply the paths beyond a few thousand */
const MAX_OVERLAPPING_ALTERNATIONS = 4;

const MAX_CODE_POINT = 0x10ffff;
const DIGIT: Range[] = [[0x30, 0x39]];
const WORD: Range[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const SPACE: Range[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const LINE_TERMINATORS: Range[] = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];
const NON_ASCII: Range[] = [[0x80, MAX_CODE_POINT]];
/** K, S, k, s: the ASCII letters non-ASCII characters fold onto with the u or v flag */
const FOLDS_FROM_NON_ASCII: Range[] = [
  [0x4b, 0x4b],
  [0x53, 0x53],
  [0x6b, 0x6b],
  [0x73, 0x73],
];
/** ſ and K (Kelvin sign), which fold onto s and k with the u or v flag */
const NON_ASCII_FOLDS: Range[] = [
  [0x17f, 0x17f],
  [0x212a, 0x212a],
];

function complement(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= MAX_CODE_POINT) out.push([next, MAX_CODE_POINT]);
  return out;
}

function caseFold(ranges: Range[]): Range[] {
  const out: Range[] = [...ranges];
  for (const [lo, hi] of ranges) {
    const upperLo = Math.max(lo, 0x41);
    const upperHi = Math.min(hi, 0x5a);
    if (upperLo <= upperHi) out.push([upperLo + 32, upperHi + 32]);
    const lowerLo = Math.max(lo, 0x61);
    const lowerHi = Math.min(hi, 0x7a);
    if (lowerLo <= lowerHi) out.push([lowerLo - 32, lowerHi - 32]);
  }
  return out;
}

function isNone(set: CharSet): boolean {
  return set !== null && set.length === 0;
}

function union(...sets: CharSet[]): CharSet {
  let out: Range[] = NONE;
  for (const set of sets) {
    if (set === null) return null;
    if (set.length) out = out.length ? out.concat(set) : set;
  }
  return out;
}

function overlaps(a: CharSet, b: CharSet): boolean {
  if (isNone(a) || isNone(b)) return false;
  if (a === null || b === null) return true;
  return a.some(([alo, ahi]) => b.some(([blo, bhi]) => alo <= bhi && blo <= ahi));
}

/** `inner` is non-empty and every character of it is in `outer` */
function covers(outer: CharSet, inner: CharSet): boolean {
  if (isNone(inner) || isNone(outer)) return false;
  if (outer === null) return true;
  if (inner === null) return false;
  const merged: [number, number][] = [];
  for (const [lo, hi] of [...outer].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return inner.every(([lo, hi]) => merged.some(([mlo, mhi]) => mlo <= lo && hi <= mhi));
}

/** the two neighbours can trade characters or whole repetitions at their boundary */
function trades(trail: CharSet, trailCycle: CharSet, lead: CharSet, leadCycle: CharSet): boolean {
  return (
    overlaps(trail, lead) ||
    covers(lead, trailCycle) ||
    covers(leadCycle, trailCycle) ||
    covers(trail, leadCycle) ||
    covers(trailCycle, leadCycle)
  );
}

function fixedTerm(set: CharSet): Term {
  return {
    first: set,
    chars: set,
    nullable: false,
    variable: false,
    lead: NONE,
    trail: NONE,
    leadCycle: NONE,
    trailCycle: NONE,
    ambiguous: false,
    lookaround: false,
  };
}

const EMPTY_TERM: Term = { ...fixedTerm(NONE), nullable: true };

/** characters a sequence can start with when it consumes anything */
function startOf(terms: Term[]): CharSet {
  let set: CharSet = NONE;
  for (const t of terms) {
    set = union(set, t.first);
    if (!t.nullable) break;
  }
  return set;
}

/** like startOf, but `null` when the sequence can match the empty string (it then overlaps anything) */
function firstOf(terms: Term[]): CharSet {
  return terms.every((t) => t.nullable) ? null : startOf(terms);
}

/** lead (or trail, on the reversed terms) of a sequence: what its start can trade with the term before */
function edgeOf(terms: Term[], edge: 'lead' | 'trail'): { set: CharSet; cycle: CharSet } {
  const cycleKey = edge === 'lead' ? 'leadCycle' : 'trailCycle';
  let set: CharSet = NONE;
  let cycle: CharSet = NONE;
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    set = union(set, t[edge]);
    cycle = union(cycle, t[cycleKey]);
    if (t.nullable) continue;
    if (!t.variable) {
      // a fixed edge still moves when the variable term after it consumes the same characters, one at a
      // time or in whole repetitions (`aa(a){1,3}` is a run of 3 to 5 a's)
      let fixed: CharSet = t.chars;
      let j = i + 1;
      while (j < terms.length && !terms[j].variable && !terms[j].nullable)
        fixed = union(fixed, terms[j++].chars);
      const next = terms[j];
      if (next && (overlaps(fixed, next[edge]) || overlaps(fixed, next[cycleKey]))) {
        set = union(set, fixed, next[edge], next[cycleKey]);
      }
    }
    break;
  }
  return { set, cycle };
}

class PatternScanner {
  private i = 0;
  private overlappingAlternations = 0;
  private readonly unicode: boolean;
  private readonly unicodeSets: boolean;
  private readonly ignoreCase: boolean;
  private readonly dotAll: boolean;

  constructor(
    private readonly source: string,
    flags: string,
  ) {
    this.unicode = flags.includes('u') || flags.includes('v');
    this.unicodeSets = flags.includes('v');
    this.ignoreCase = flags.includes('i');
    this.dotAll = flags.includes('s');
  }

  check(): void {
    this.disjunction();
  }

  private fail(reason: string): never {
    throw new ExpressionError(`Regular expression is not allowed: ${reason}`, {
      description: `Pattern /${this.source.slice(0, 100)}/ could backtrack for a very long time. Simplify it, for example with a character class that excludes the separator ([^,]* instead of .*).`,
    });
  }

  /** parses alternatives up to `)` or the end and returns them as one term */
  private disjunction(): { term: Term; overlap: boolean } {
    const alternatives: Term[][] = [[]];
    while (this.i < this.source.length) {
      const ch = this.source[this.i];
      if (ch === ')') break;
      if (ch === '|') {
        this.i++;
        alternatives.push([]);
        continue;
      }
      alternatives[alternatives.length - 1].push(this.term());
    }
    for (const alt of alternatives) this.checkSequence(alt);

    const firsts = alternatives.map(firstOf);
    let overlap = false;
    for (let a = 0; a < firsts.length && !overlap; a++) {
      for (let b = a + 1; b < firsts.length && !overlap; b++) overlap = overlaps(firsts[a], firsts[b]);
    }
    if (overlap && ++this.overlappingAlternations > MAX_OVERLAPPING_ALTERNATIONS) {
      this.fail('too many groups of alternatives can match the same text (for example (a|a)(a|a)(a|a)...)');
    }

    const all = alternatives.flat();
    const leads = alternatives.map((alt) => edgeOf(alt, 'lead'));
    const trails = alternatives.map((alt) => edgeOf([...alt].reverse(), 'trail'));
    const term: Term = {
      first: union(...alternatives.map(startOf)),
      chars: union(...all.map((t) => t.chars)),
      nullable: firsts.some((f) => f === null),
      variable: all.some((t) => t.variable),
      lead: union(...leads.map((e) => e.set)),
      trail: union(...trails.map((e) => e.set)),
      leadCycle: union(...leads.map((e) => e.cycle)),
      trailCycle: union(...trails.map((e) => e.cycle)),
      ambiguous: overlap || all.some((t) => t.ambiguous),
      lookaround: all.some((t) => t.lookaround),
    };
    return { term, overlap };
  }

  /** neighbouring terms of one alternative must not split the input in several ways */
  private checkSequence(terms: Term[]): void {
    let openTrail: CharSet = NONE;
    let openCycle: CharSet = NONE;
    // the repeats linked so far: what their end can trade one character at a time, and in whole repetitions
    let chainTrail: CharSet = NONE;
    let chainCycle: CharSet = NONE;
    let chainLength = 0;
    for (const t of terms) {
      if (trades(openTrail, openCycle, t.lead, t.leadCycle)) {
        this.fail('two neighbouring repeats can match the same text (for example .*.* or \\d*\\d*)');
      }
      const flexible = !isNone(t.lead) || !isNone(t.trail) || !isNone(t.leadCycle) || !isNone(t.trailCycle);
      if (flexible) {
        // the chain flows into a term whose start it can trade with, or whose fixed start it can consume
        const pinnedStart = isNone(t.lead) && isNone(t.leadCycle);
        const joins: boolean =
          chainLength > 0 &&
          (trades(chainTrail, chainCycle, t.lead, t.leadCycle) ||
            (pinnedStart && (overlaps(chainTrail, t.first) || covers(t.chars, chainCycle))));
        chainLength = joins ? chainLength + 1 : 1;
        if (chainLength >= 3) {
          this.fail('three or more repeats can match the same text (for example .*a.*a.*)');
        }
        chainTrail = joins ? union(chainTrail, t.trail) : t.trail;
        chainCycle = joins ? union(chainCycle, t.trailCycle) : t.trailCycle;
      } else if (!t.nullable && !overlaps(union(chainTrail, chainCycle), t.chars)) {
        // a separator the repeats cannot consume pins the boundary
        chainTrail = NONE;
        chainCycle = NONE;
        chainLength = 0;
      }
      if (t.nullable) {
        openTrail = union(openTrail, t.trail);
        openCycle = union(openCycle, t.trailCycle);
      } else {
        openTrail = t.trail;
        openCycle = t.trailCycle;
      }
    }
  }

  private term(): Term {
    const { term, group } = this.atom();
    const quantifier = this.quantifier();
    if (!quantifier || group?.assertion) return term;
    if (quantifier.max === 0) return EMPTY_TERM;
    if (group && quantifier.max > 1) {
      if (group.overlap) {
        this.fail('a repeated group has alternatives that can match the same text (for example (a|ab)*)');
      }
      if (term.ambiguous) {
        this.fail(
          'a repeated group contains alternatives that can match the same text (for example ((a|a)b)*)',
        );
      }
      if (term.lookaround) this.fail('a repeated group contains a lookaround with a repeat');
      if (trades(term.trail, term.trailCycle, term.lead, term.leadCycle)) {
        this.fail('a repeated group can split its input in more than one way (for example (a+)+)');
      }
    }
    const variableCount = quantifier.min !== quantifier.max;
    return {
      ...term,
      nullable: quantifier.min === 0 || term.nullable,
      variable: term.variable || variableCount,
      lead: variableCount && !group ? term.chars : term.lead,
      trail: variableCount && !group ? term.chars : term.trail,
      leadCycle: variableCount && group ? term.chars : term.leadCycle,
      trailCycle: variableCount && group ? term.chars : term.trailCycle,
    };
  }

  private atom(): Atom {
    const ch = this.source[this.i++];
    switch (ch) {
      case '^':
      case '$':
        return { term: EMPTY_TERM };
      case '.':
        return { term: fixedTerm(this.dotAll ? null : complement(LINE_TERMINATORS)) };
      case '[':
        return { term: fixedTerm(this.characterClass()) };
      case '(':
        return this.group();
      case '\\': {
        const set = this.escape(false);
        return { term: set === 'assertion' ? EMPTY_TERM : fixedTerm(this.fold(set)) };
      }
      default: {
        const cp = this.source.codePointAt(this.i - 1) ?? 0;
        if (cp > 0xffff) this.i++;
        return { term: fixedTerm(this.fold(this.literal(cp))) };
      }
    }
  }

  private literal(cp: number): Range[] {
    return [[cp, cp]];
  }

  /**
   * Case folding with the i flag. ASCII letters fold onto each other. Other characters fold among
   * non-ASCII ones only, so that part widens to every non-ASCII character; with u or v, ſ and K
   * (U+017F, U+212A) also fold onto s and k.
   */
  private fold(set: CharSet): CharSet {
    if (!this.ignoreCase || set === null) return set;
    const folded = caseFold(set);
    if (set.some(([, hi]) => hi > 0x7f)) {
      return folded.concat(NON_ASCII, this.unicode ? FOLDS_FROM_NON_ASCII : NONE);
    }
    return this.unicode && overlaps(folded, FOLDS_FROM_NON_ASCII) ? folded.concat(NON_ASCII_FOLDS) : folded;
  }

  private group(): Atom {
    let assertion = false;
    if (this.source[this.i] === '?') {
      this.i++;
      const kind = this.source[this.i];
      if (kind === '=' || kind === '!') {
        assertion = true;
        this.i++;
      } else if (kind === '<' && (this.source[this.i + 1] === '=' || this.source[this.i + 1] === '!')) {
        assertion = true;
        this.i += 2;
      } else if (kind === '<') {
        const end = this.source.indexOf('>', this.i);
        this.i = end < 0 ? this.source.length : end + 1;
      } else {
        while (this.i < this.source.length && this.source[this.i] !== ':') this.i++;
        this.i++;
      }
    }
    const { term, overlap } = this.disjunction();
    this.i++;
    if (assertion) {
      return {
        term: { ...EMPTY_TERM, ambiguous: term.ambiguous, lookaround: term.variable || term.lookaround },
        group: { assertion, overlap },
      };
    }
    return { term, group: { assertion, overlap } };
  }

  private quantifier(): Quantifier | undefined {
    const ch = this.source[this.i];
    let q: Quantifier | undefined;
    if (ch === '*') q = { min: 0, max: Number.POSITIVE_INFINITY };
    else if (ch === '+') q = { min: 1, max: Number.POSITIVE_INFINITY };
    else if (ch === '?') q = { min: 0, max: 1 };
    else if (ch === '{') {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.i, this.i + 32));
      if (!match) return undefined;
      const min = Number(match[1]);
      const max =
        match[2] === undefined ? min : match[3] === '' ? Number.POSITIVE_INFINITY : Number(match[3]);
      this.i += match[0].length - 1;
      q = { min, max };
    }
    if (!q) return undefined;
    this.i++;
    if (this.source[this.i] === '?') this.i++;
    return q;
  }

  /** parses after the backslash; `inClass` disables the assertion and backreference forms */
  private escape(inClass: boolean): CharSet | 'assertion' {
    const ch = this.source[this.i++];
    switch (ch) {
      case 'd':
        return DIGIT;
      case 'D':
        return complement(DIGIT);
      case 'w':
        return WORD;
      case 'W':
        return complement(WORD);
      case 's':
        return SPACE;
      case 'S':
        return complement(SPACE);
      case 'b':
        return inClass ? [[8, 8]] : 'assertion';
      case 'B':
        return inClass ? this.literal(0x42) : 'assertion';
      case 'p':
      case 'P':
        if (this.source[this.i] === '{') {
          const end = this.source.indexOf('}', this.i);
          this.i = end < 0 ? this.source.length : end + 1;
        }
        return null;
      case 'k':
        if (!inClass && this.source[this.i] === '<') this.fail('backreferences are not supported');
        return this.literal(0x6b);
      case 't':
        return [[9, 9]];
      case 'n':
        return [[10, 10]];
      case 'v':
        return [[11, 11]];
      case 'f':
        return [[12, 12]];
      case 'r':
        return [[13, 13]];
      case 'c': {
        const letter = this.source.charCodeAt(this.i);
        if (/[A-Za-z]/.test(this.source[this.i] ?? '')) {
          this.i++;
          return [[letter % 32, letter % 32]];
        }
        return this.literal(0x5c);
      }
      case 'x': {
        const hex = /^[0-9a-fA-F]{2}/.exec(this.source.slice(this.i, this.i + 2));
        if (!hex) return this.literal(0x78);
        this.i += 2;
        return this.literal(Number.parseInt(hex[0], 16));
      }
      case 'u': {
        const braced = /^\{([0-9a-fA-F]+)\}/.exec(this.source.slice(this.i, this.i + 10));
        if (braced) {
          this.i += braced[0].length;
          return this.literal(Number.parseInt(braced[1], 16));
        }
        const hex = /^[0-9a-fA-F]{4}/.exec(this.source.slice(this.i, this.i + 4));
        if (!hex) return this.literal(0x75);
        this.i += 4;
        return this.literal(Number.parseInt(hex[0], 16));
      }
      case '0':
        return [[0, 0]];
      default: {
        if (ch !== undefined && ch >= '1' && ch <= '9') {
          if (!inClass) this.fail('backreferences are not supported');
          return null;
        }
        const cp = this.source.codePointAt(this.i - 1) ?? 0;
        if (cp > 0xffff) this.i++;
        return this.literal(cp);
      }
    }
  }

  private characterClass(): CharSet {
    let negated = false;
    if (this.source[this.i] === '^') {
      negated = true;
      this.i++;
    }
    const ranges: Range[] = [];
    let wide = false;
    let depth = 1;
    while (this.i < this.source.length) {
      const ch = this.source[this.i];
      if (ch === ']') {
        this.i++;
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (this.unicodeSets && ch === '[') {
        depth++;
        wide = true;
        this.i++;
        continue;
      }
      if (
        this.unicodeSets &&
        (this.source.startsWith('--', this.i) || this.source.startsWith('&&', this.i))
      ) {
        wide = true;
        this.i += 2;
        continue;
      }
      const low = this.classAtom();
      if (low === null) {
        wide = true;
        continue;
      }
      const single = low.length === 1 && low[0][0] === low[0][1];
      if (single && this.source[this.i] === '-' && this.source[this.i + 1] !== ']') {
        const save = this.i;
        this.i++;
        const high = this.classAtom();
        if (high && high.length === 1 && high[0][0] === high[0][1]) {
          ranges.push([low[0][0], high[0][0]]);
          continue;
        }
        this.i = save;
      }
      ranges.push(...low);
    }
    if (wide) return null;
    const folded = this.fold(ranges);
    if (folded === null) return null;
    return negated ? complement(folded) : folded;
  }

  /** one class member; returns ranges without case folding (the class folds once at the end) */
  private classAtom(): Range[] | null {
    const ch = this.source[this.i++];
    if (ch === '\\') {
      const set = this.escape(true);
      return set === 'assertion' ? null : set;
    }
    const cp = this.source.codePointAt(this.i - 1) ?? 0;
    if (cp > 0xffff) this.i++;
    return [[cp, cp]];
  }
}

const verdictCache = new Map<string, true>();
const VERDICT_CACHE_MAX = 2000;

/** Throws an ExpressionError when the pattern is invalid or could backtrack catastrophically. */
export function assertSafeRegExp(source: string, flags = ''): void {
  const key = `${flags}/${source}`;
  if (verdictCache.has(key)) return;
  try {
    new RegExp(source, flags);
  } catch (error) {
    throw new ExpressionError(`Invalid regular expression: ${(error as Error).message}`, { cause: error });
  }
  new PatternScanner(source, flags).check();
  if (verdictCache.size >= VERDICT_CACHE_MAX) verdictCache.delete(verdictCache.keys().next().value as string);
  verdictCache.set(key, true);
}

/**
 * Compiles a user-supplied pattern after the safety check. `source` may be a string or a RegExp
 * (its flags are kept unless `flags` is given), matching the RegExp constructor.
 */
export function createSafeRegExp(source: string | RegExp, flags?: string): RegExp {
  const pattern = source instanceof RegExp ? source.source : String(source);
  const effectiveFlags = flags ?? (source instanceof RegExp ? source.flags : '');
  assertSafeRegExp(pattern, effectiveFlags);
  return new RegExp(pattern, effectiveFlags);
}
