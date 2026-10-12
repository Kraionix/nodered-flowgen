/**
 * The palette augmentations this repository type-checks itself against.
 *
 * `npx tsc --noEmit` covers `src/`, `test/` and `examples/`, and those programs call
 * `tab.node('inject', …)` — which only compiles because the generated augmentations add `inject`
 * to `KnownTypes`. Those files used to be produced as a side effect of the integration suite and
 * `.gitignore`d, so a fresh clone did not type-check at all: moving `test/types/palettes/` aside
 * produces twenty-odd errors in `src/`, `examples/acceptance/flowgen.config.ts` and the tests.
 * They are committed now, and `types.spec.ts` regenerates them and compares byte for byte, so
 * they cannot drift from the generator or from the pinned installation without a red test.
 *
 * The input is the installation in `node_modules` (pinned by `package-lock.json`:
 * `node-red@5.0.8`, `node-red-dashboard@3.6.6`) rather than a raw `GET /nodes` fixture. It is
 * still completely offline — no instance is involved — and it keeps one copy of the core node set
 * in the repository instead of two: the committed fixtures under `test/fixtures/palettes/` stay
 * core-only, because a capture with user modules is an order of magnitude larger and says nothing
 * about the extractor.
 *
 * Regenerate with `npm run types:regen` after changing the extractor, the generator, or the
 * pinned Node-RED version.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitTypes, type GeneratedFile } from '../../src/palette/codegen/emitTypes.ts';
import { filesystemSource } from '../../src/palette/sources/filesystem.ts';
import type { PaletteSnapshot } from '../../src/palette/snapshot.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directory of the committed augmentations, relative to the repository root. */
export const LOCAL_TYPES_DIRECTORY = 'test/types/palettes/local.d';

export async function pinnedPalette(): Promise<PaletteSnapshot> {
  return filesystemSource({
    coreNodesDir: path.join(REPO_ROOT, 'node_modules', '@node-red', 'nodes'),
    userDir: REPO_ROOT,
  }).load();
}

/** The augmentation files for the pinned installation, as they should be on disk. */
export async function generateLocalTypes(directory = LOCAL_TYPES_DIRECTORY): Promise<readonly GeneratedFile[]> {
  return emitTypes(await pinnedPalette(), { directory });
}
