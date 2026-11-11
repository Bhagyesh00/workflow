/**
 * The command dispatcher (P6-77): `workflow <group> <command> [words] [flags]`. Every effect goes through the
 * CliIo it is given. Exit codes are in client.ts (EXIT).
 */
import { type Args, flagOn, flagText, parseArgs, UsageError } from './args';
import { buildApi, CliError, type Command, type CommandGroup, type Ctx, EXIT, readJsonInput } from './client';
import { auditCommand } from './commands/audit';
import { loginCommand, logoutCommand } from './commands/auth';
import { configCommands } from './commands/config';
import { credentialCommands } from './commands/credential';
import { dataTableCommands } from './commands/data-table';
import { executionCommands } from './commands/execution';
import { projectCommands } from './commands/project';
import { skillCommands } from './commands/skill';
import { sourceControlCommands } from './commands/source-control';
import { tagCommands } from './commands/tag';
import { userCommands } from './commands/user';
import { variableCommands } from './commands/variable';
import { workflowCommands } from './commands/workflow';
import { ENV_API_KEY } from './config';
import type { CliIo } from './index';
import { outputOptions, render } from './output';

export const VERSION = '0.1.0';

const GROUPS: Record<string, CommandGroup> = {
  workflow: workflowCommands,
  execution: executionCommands,
  credential: credentialCommands,
  project: projectCommands,
  tag: tagCommands,
  variable: variableCommands,
  'data-table': dataTableCommands,
  user: userCommands,
  'source-control': sourceControlCommands,
  config: configCommands,
  skill: skillCommands,
};

/** commands that are a word of their own, with no sub-command */
const SINGLES: Record<string, Command> = {
  audit: auditCommand,
  login: loginCommand,
  logout: logoutCommand,
};

const GLOBAL_FLAGS = [
  '--format table|json|id-only   output format (json when piped)',
  '--json                        same as --format json',
  '--pick <path>                 keep one part of the result, such as data[0].id or [].name',
  '--quiet                       print nothing on success',
  '--no-header                   no header line in a table',
  '--url <url>, --api-key <key>  server and key (the environment and ~/.workflow/config.json come next)',
  '--help, --version',
];

function topHelp(): string {
  const lines = [
    'workflow: command line client for the public API',
    '',
    'Usage: workflow <group> <command> [words] [flags]',
    '',
  ];
  lines.push('Groups:');
  for (const [name, group] of Object.entries(GROUPS)) {
    lines.push(`  ${name.padEnd(16)}${Object.keys(group).join(', ')}`);
  }
  lines.push('', 'Commands:');
  for (const [name, command] of Object.entries(SINGLES)) lines.push(`  ${name.padEnd(16)}${command.summary}`);
  lines.push('', 'Flags for every command:', ...GLOBAL_FLAGS.map((line) => `  ${line}`));
  lines.push('', 'Run `workflow <group> --help` for the commands of a group.');
  return `${lines.join('\n')}\n`;
}

function groupHelp(name: string, group: CommandGroup): string {
  const lines = [`workflow ${name}`, ''];
  for (const [sub, command] of Object.entries(group)) lines.push(`  ${sub.padEnd(16)}${command.summary}`);
  lines.push('', 'Run `workflow <group> <command> --help` for the flags of one command.');
  return `${lines.join('\n')}\n`;
}

const commandHelp = (command: Command): string => `${command.summary}\n\nUsage: ${command.usage}\n`;

/** the message with every secret the run knows cut out (the flag and the env key; the client cuts its own) */
function scrub(text: string, args: Args | undefined, io: CliIo): string {
  let out = text;
  for (const secret of [args ? flagText(args, 'api-key') : undefined, io.env[ENV_API_KEY]]) {
    if (secret) out = out.split(secret).join('[key]');
  }
  return out;
}

function contextFor(args: Args, io: CliIo): Ctx {
  const output = outputOptions(args, io.isTTY);
  let api: ReturnType<typeof buildApi> | undefined;
  return {
    io,
    args,
    output,
    api: () => {
      api ??= buildApi(args, io);
      return api;
    },
    print(value, columns) {
      if (!output.quiet) io.stdout(render(value, output, columns));
    },
    note(text) {
      if (!output.quiet) io.stderr(`${text}\n`);
    },
    body: () => readJsonInput(args, io),
  };
}

/** runs one command line; returns the exit code */
export async function execute(argv: string[], io: CliIo): Promise<number> {
  let parsed: Args | undefined;
  try {
    parsed = parseArgs(argv);
    const words = parsed.positionals;
    if (flagOn(parsed, 'version') && !words.length) {
      io.stdout(`${VERSION}\n`);
      return EXIT.ok;
    }
    if (!words.length) {
      io.stdout(topHelp());
      return EXIT.ok;
    }
    const [name, sub] = words;
    const single = Object.hasOwn(SINGLES, name) ? SINGLES[name] : undefined;
    if (single) {
      if (flagOn(parsed, 'help')) {
        io.stdout(commandHelp(single));
        return EXIT.ok;
      }
      await single.run(contextFor({ positionals: words.slice(1), flags: parsed.flags }, io));
      return EXIT.ok;
    }
    const group = Object.hasOwn(GROUPS, name) ? GROUPS[name] : undefined;
    if (!group) throw new UsageError(`Unknown command "${name}". Run \`workflow --help\` for the list`);
    if (!sub || (flagOn(parsed, 'help') && !Object.hasOwn(group, sub))) {
      io.stdout(groupHelp(name, group));
      return sub && !flagOn(parsed, 'help') ? EXIT.usage : EXIT.ok;
    }
    const command = Object.hasOwn(group, sub) ? group[sub] : undefined;
    if (!command) throw new UsageError(`Unknown command "${name} ${sub}". Run \`workflow ${name} --help\``);
    if (flagOn(parsed, 'help')) {
      io.stdout(commandHelp(command));
      return EXIT.ok;
    }
    await command.run(contextFor({ positionals: words.slice(2), flags: parsed.flags }, io));
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`Error: ${scrub(error.message, parsed, io)}\n`);
      return EXIT.usage;
    }
    if (error instanceof CliError) {
      io.stderr(`Error: ${scrub(error.message, parsed, io)}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : 'unknown error';
    io.stderr(`Error: ${scrub(message, parsed, io)}\n`);
    return EXIT.general;
  }
}
