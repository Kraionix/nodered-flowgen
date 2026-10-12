/**
 * `npm run types:regen` — rewrite the committed augmentations in `test/types/palettes/local.d/`.
 *
 * Run it after changing the extractor or the generator, or after moving the pinned Node-RED
 * version. `types.spec.ts` fails whenever the committed files and this generator disagree, so a
 * forgotten regeneration is a red test rather than a mystery in somebody's editor.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { generateLocalTypes, LOCAL_TYPES_DIRECTORY, REPO_ROOT } from './generate.ts';

const directory = path.join(REPO_ROOT, LOCAL_TYPES_DIRECTORY);
await rm(directory, { recursive: true, force: true });

const files = await generateLocalTypes();
for (const file of files) {
  const full = path.join(REPO_ROOT, file.path);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, file.content, 'utf8');
  console.log(`${file.path} (${file.types.length} types)`);
}

console.log(`${files.length} file(s) written from the pinned installation`);
