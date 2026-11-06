/**
 * Custom Email Rules: the JSON array of IMAP search criteria n8n documents (the node-imap form, such as
 * ["UNSEEN", ["FROM", "a@b.c"], ["!SUBJECT", "x"], ["OR", "SEEN", ["SINCE", "May 20, 2018"]]]) as one
 * imapflow search object. A rule that cannot be read fails the activation with a clear text.
 */
import type { SearchObject } from 'imapflow';

const FLAG_RULES = new Map<string, SearchObject>([
  ['ALL', { all: true }],
  ['ANSWERED', { answered: true }],
  ['UNANSWERED', { answered: false }],
  ['DELETED', { deleted: true }],
  ['UNDELETED', { deleted: false }],
  ['DRAFT', { draft: true }],
  ['UNDRAFT', { draft: false }],
  ['FLAGGED', { flagged: true }],
  ['UNFLAGGED', { flagged: false }],
  ['SEEN', { seen: true }],
  ['UNSEEN', { seen: false }],
  ['NEW', { new: true }],
  ['OLD', { old: true }],
  ['RECENT', { recent: true }],
]);

const TEXT_RULES = new Map<string, keyof SearchObject>([
  ['BCC', 'bcc'],
  ['BODY', 'body'],
  ['CC', 'cc'],
  ['FROM', 'from'],
  ['SUBJECT', 'subject'],
  ['TEXT', 'text'],
  ['TO', 'to'],
  ['KEYWORD', 'keyword'],
  ['UNKEYWORD', 'unKeyword'],
]);

const DATE_RULES = new Map<string, keyof SearchObject>([
  ['BEFORE', 'before'],
  ['ON', 'on'],
  ['SINCE', 'since'],
  ['SENTBEFORE', 'sentBefore'],
  ['SENTON', 'sentOn'],
  ['SENTSINCE', 'sentSince'],
]);

const NUMBER_RULES = new Map<string, keyof SearchObject>([
  ['LARGER', 'larger'],
  ['SMALLER', 'smaller'],
]);

const SEQUENCE_SET = /^[\d*][\d*:,]*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// line breaks and NUL would end the IMAP command
const UNSAFE_TEXT = /[\r\n\0]/;

const invalid = (detail: string) => new Error(`Custom email config: ${detail}`);

function textValue(rule: string, value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || UNSAFE_TEXT.test(String(value))) {
    throw invalid(`${rule} needs a value`);
  }
  return String(value);
}

/** IMAP dates have no time: the day as written, at midnight UTC, whatever the time zone of this host */
function dateValue(rule: string, value: unknown): Date {
  const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) throw invalid(`${rule} needs a date`);
  if (typeof value === 'string' && DATE_ONLY.test(value.trim())) return parsed;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

function namedRule(name: string, args: unknown[]): SearchObject {
  const rule = name.trim().toUpperCase();
  if (rule.startsWith('!')) return { not: namedRule(rule.slice(1), args) };

  const flag = FLAG_RULES.get(rule);
  if (flag) {
    if (args.length) throw invalid(`${rule} takes no value`);
    return flag;
  }
  const textKey = TEXT_RULES.get(rule);
  if (textKey) return { [textKey]: textValue(rule, args[0]) };
  const dateKey = DATE_RULES.get(rule);
  if (dateKey) return { [dateKey]: dateValue(rule, args[0]) };
  const numberKey = NUMBER_RULES.get(rule);
  if (numberKey) {
    const value = typeof args[0] === 'string' && args[0].trim() ? Number(args[0]) : args[0];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${rule} needs a number`);
    return { [numberKey]: value };
  }
  switch (rule) {
    case 'HEADER': {
      if (args.length !== 2 || typeof args[0] !== 'string' || !args[0].trim()) {
        throw invalid('HEADER needs a name and a value');
      }
      // fromEntries makes an own property of any name, __proto__ too
      return { header: Object.fromEntries([[args[0], textValue(rule, args[1])]]) };
    }
    case 'UID': {
      const set = String(args[0] ?? '').trim();
      if (!SEQUENCE_SET.test(set)) throw invalid('UID needs a set such as 1:5');
      return { uid: set };
    }
    case 'NOT':
      if (args.length !== 1) throw invalid('NOT needs one rule');
      return { not: parseRule(args[0]) };
    case 'OR':
      if (args.length !== 2) throw invalid('OR needs two rules');
      return { or: [parseRule(args[0]), parseRule(args[1])] };
    default:
      if (SEQUENCE_SET.test(rule) && !args.length) return { seq: rule };
      throw invalid(`unknown rule ${name}`);
  }
}

function parseRule(rule: unknown): SearchObject {
  if (typeof rule === 'number') return { seq: String(rule) };
  if (typeof rule === 'string') return namedRule(rule, []);
  if (Array.isArray(rule) && rule.length > 0) {
    const [first, ...args] = rule as unknown[];
    return typeof first === 'string' ? namedRule(first, args) : allOf(rule.map(parseRule));
  }
  throw invalid(`a rule is not valid: ${JSON.stringify(rule)}`);
}

/**
 * One search object that needs every part to match. An object has room for each key once, so a part whose
 * keys are taken goes one level down, in a one-item `or`: imapflow sends that as a plain group. That leaves
 * no `or` for a real OR at that level, which is sent as NOT NOT (OR a b), the same search.
 */
export function allOf(parts: SearchObject[]): SearchObject {
  const head: SearchObject = {};
  const rest: SearchObject[] = [];
  for (const part of parts) {
    if (Object.keys(part).some((key) => key in head)) rest.push(part);
    else Object.assign(head, part);
  }
  if (rest.length === 0) return head;
  if (head.or) {
    if (head.not) rest.push({ or: head.or });
    else head.not = { not: { or: head.or } };
    delete head.or;
  }
  head.or = [allOf(rest)];
  return head;
}

/** the Custom Email Rules option (its JSON text, or an array from an expression) as a search object */
export function parseCustomRules(value: unknown): SearchObject {
  let rules = value;
  if (typeof value === 'string') {
    try {
      rules = JSON.parse(value);
    } catch {
      throw new Error('Custom email config is not valid JSON.');
    }
  }
  if (!Array.isArray(rules)) throw invalid('it must be a JSON array of search rules');
  return rules.length === 0 ? { all: true } : allOf(rules.map(parseRule));
}
