#!/usr/bin/env node
// Entry point of the `workflow` command: registers tsx so the TypeScript sources run as they are.
import { register } from 'tsx/esm/api';

register();

const { run } = await import('../src/index.ts');
const { nodeIo } = await import('../src/io.ts');

process.exitCode = await run(process.argv.slice(2), nodeIo());
