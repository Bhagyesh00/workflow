/**
 * P6-78 (L11): `export:nodes`. Dispatched by cli.ts inside `createContext`, the context closed after it; the
 * result is the exit code (0 ok), which cli.ts sets as `process.exitCode`. Output goes through `io` (default
 * `processIo()`), so tests capture it.
 * - export:nodes: `--output <path>`, no tenant
 * The descriptions of every node type this server has loaded, as a JSON list (the list GET /node-types gives).
 */
import type { ServerContext } from '../context';
import { parseCommandArgs, runCommand, toJson } from './command-args';
import type { CommandIo } from './command-io';

export const EXPORT_NODES_USAGE = 'Usage: export:nodes [--output <path>] [--pretty]';

export function exportNodesCommand(ctx: ServerContext, argv: string[], io?: CommandIo): Promise<number> {
  return runCommand(io, EXPORT_NODES_USAGE, async (out) => {
    const args = parseCommandArgs(argv, { values: ['output'], flags: ['pretty'] });
    const descriptions = ctx.registries.nodeTypes.list().map((type) => type.description);
    const text = toJson(descriptions, args.flag('pretty'));
    const output = args.value('output');
    if (output === undefined) {
      out.stdout(text);
      return 0;
    }
    await out.writeFile(output, text, {});
    out.stdout(`Exported ${descriptions.length} node type(s) to ${output}\n`);
    return 0;
  });
}
