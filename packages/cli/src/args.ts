/**
 * Command line parsing (P6-77). No dependency: `--name value`, `--name=value`, `--flag`, `--no-header`,
 * a few short flags, and `--` to end the flags. A flag that takes no value is in BOOLEAN_FLAGS, so it never
 * swallows the word after it.
 */

/** an error the user can fix by changing the command line; the process exits with code 2 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'quiet',
  'no-header',
  'stdin',
  'help',
  'version',
  'global',
  'force',
  'all',
  'active',
  'include-data',
  'include-role',
  'use-current-workflow',
  'allow-http',
  'empty',
  'dry-run',
]);

const SHORT_FLAGS: Readonly<Record<string, string>> = { h: 'help', q: 'quiet', j: 'json', v: 'version' };

export interface Args {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** splits `argv` into words and flags; throws UsageError for a flag that needs a value and has none */
export function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    i += 1;
    if (word === '--') {
      positionals.push(...argv.slice(i));
      break;
    }
    if (word.startsWith('--') && word.length > 2) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word.slice(2) : word.slice(2, eq);
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq === -1) {
          flags[name] = true;
        } else {
          const value = word.slice(eq + 1).toLowerCase();
          if (value !== 'true' && value !== 'false') {
            throw new UsageError(`--${name} takes no value (or true or false)`);
          }
          flags[name] = value === 'true';
        }
        continue;
      }
      if (eq !== -1) {
        flags[name] = word.slice(eq + 1);
        continue;
      }
      const next = argv[i];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        throw new UsageError(`--${name} needs a value`);
      }
      flags[name] = next;
      i += 1;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(word)) {
      const name = SHORT_FLAGS[word.slice(1)];
      if (!name) throw new UsageError(`Unknown flag ${word}`);
      flags[name] = true;
      continue;
    }
    positionals.push(word);
  }
  return { positionals, flags };
}

/** a text flag, or undefined */
export function flagText(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** a switch: true when given (and not `=false`) */
export function flagOn(args: Args, name: string): boolean {
  return args.flags[name] === true;
}

/** a switch given as `--name` (true) or `--name=false`; undefined when not given */
export function flagBool(args: Args, name: string): boolean | undefined {
  const value = args.flags[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** a text flag that must be there */
export function flagRequired(args: Args, name: string): string {
  const value = flagText(args, name);
  if (value === undefined || value === '') throw new UsageError(`Missing --${name}`);
  return value;
}

/** a whole number flag in [min, max], or undefined */
export function flagInt(args: Args, name: string, min: number, max: number): number | undefined {
  const value = flagText(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  }
  return Number(value);
}

/** the n-th word after the command, or a usage error naming it */
export function wordRequired(args: Args, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new UsageError(`Missing <${label}>`);
  return value;
}
