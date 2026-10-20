#!/usr/bin/env node
// Entry point of the evaluation scripts. Build first (`pnpm build`); see eval/README.md.
import { evalMain } from '../dist/eval/cli.js';

try {
  evalMain(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
