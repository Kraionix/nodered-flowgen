#!/usr/bin/env node
/**
 * The `bin` entry — a separate file, and that is the whole point.
 *
 * This used to live at the bottom of `index.ts` behind a guard:
 *
 * ```ts
 * const invokedDirectly =
 *   process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
 * if (invokedDirectly) await main();
 * ```
 *
 * The guard's job was to keep `import { runCli } from './index.ts'` — which every CLI test does —
 * from also executing the CLI. But the comparison is wrong for the one path that matters most:
 * `argv[1]` keeps the path the interpreter was given, while `import.meta.url` is the resolved real
 * path. `node_modules/.bin/flowgen` **is a symlink**, and npm, npx and pnpm all run the bin
 * through it, so on every real installation the guard evaluated to false and the CLI exited `0`
 * having printed nothing at all:
 *
 * ```
 * $ node link/src/cli/index.ts --help
 * $ echo $?
 * 0
 * ```
 *
 * No message, no exit code, no clue. Every "it does nothing" report is this line.
 *
 * Rather than repair the comparison, the entry point is now a file whose only purpose is to run
 * the CLI: there is no condition to get wrong, and `index.ts` is a pure module with no import side
 * effects. The shebang is preserved by `tsc` into `dist/cli/bin.js`, which is what `bin` points at.
 */

import { main } from './index.ts';

await main();
