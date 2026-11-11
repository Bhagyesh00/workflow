/**
 * P6-48 (L1): write-time checks of a document's rules. Warnings (the write goes through): `shadowed` (an
 * earlier rule already matches everything this one does), `notLoaded` (no loaded type or package matches).
 * Refused (400, not a warning): `extends` in a node policy, a rule that is not one action on one selector.
 * `delegate` where the scope cannot hold it is the store's check (`assertNoDelegate`), since a document does
 * not know its scopes.
 */
import { ApiError } from '../../http/errors';
import type { PolicyKind, PolicyRule, PolicySelector, PolicyWarning } from './types';

/** the loaded type names and package names of one kind */
export interface KnownTypes {
  types: ReadonlySet<string>;
  packages: ReadonlySet<string>;
}

const ACTIONS = new Set(['allow', 'deny', 'delegate']);
const SELECTOR_FIELDS = ['name', 'package', 'extends'] as const;
/** a document longer than this is refused (a rule list is read on every check) */
export const MAX_RULES = 500;

/** the one field a selector sets, with its value */
function selectorOf(selector: PolicySelector): { field: (typeof SELECTOR_FIELDS)[number]; value: string } {
  if (!selector || typeof selector !== 'object') throw ApiError.badRequest('A rule needs a selector');
  const set = SELECTOR_FIELDS.filter((field) => selector[field] !== undefined);
  if (set.length !== 1)
    throw ApiError.badRequest('A rule needs exactly one selector: name, package or extends');
  const field = set[0];
  const value = selector[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.badRequest(`The ${field} selector of a rule must be a non-empty text`);
  }
  return { field, value };
}

/** refuses a rule list that is malformed for `kind` (400); the rules are not changed */
export function validateRules(kind: PolicyKind, rules: readonly PolicyRule[]): void {
  if (rules.length > MAX_RULES) throw ApiError.badRequest(`A policy holds at most ${MAX_RULES} rules`);
  const ids = new Set<string>();
  for (const rule of rules) {
    if (typeof rule.id !== 'string' || rule.id === '') throw ApiError.badRequest('A rule needs an id');
    if (ids.has(rule.id)) throw ApiError.badRequest('Two rules of a policy share an id');
    ids.add(rule.id);
    if (!ACTIONS.has(rule.action)) throw ApiError.badRequest('A rule action is allow, deny or delegate');
    const { field } = selectorOf(rule.selector);
    if (kind === 'node' && field === 'extends') {
      throw ApiError.badRequest('A node policy cannot use an extends selector');
    }
  }
}

/** refuses `delegate` in the rules (a project scope cannot hold it) */
export function assertNoDelegate(rules: readonly PolicyRule[]): void {
  if (rules.some((rule) => rule.action === 'delegate')) {
    throw ApiError.badRequest('A project policy cannot delegate');
  }
}

export function lintRules(
  kind: PolicyKind,
  rules: readonly PolicyRule[],
  known: KnownTypes,
): PolicyWarning[] {
  validateRules(kind, rules);
  const warnings: PolicyWarning[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const { field, value } = selectorOf(rule.selector);
    const key = `${field}\u0000${value}`;
    if (seen.has(key)) {
      warnings.push({
        code: 'shadowed',
        ruleId: rule.id,
        message: `An earlier rule already matches the ${field} "${value}", so this rule never decides`,
      });
    }
    seen.add(key);
    const loaded = field === 'package' ? known.packages.has(value) : known.types.has(value);
    if (!loaded) {
      const what = field === 'package' ? 'package' : 'type';
      warnings.push({
        code: 'notLoaded',
        ruleId: rule.id,
        message: `No loaded ${what} is named "${value}", so this rule matches nothing yet`,
      });
    }
  }
  return warnings;
}
