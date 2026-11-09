// Syntax-check every module in the package with `node --check`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function modules(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...modules(full));
    else if (entry.name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

const files = ['bin', 'lib', 'scripts', 'test']
  .map((name) => path.join(root, name))
  .filter((directory) => fs.existsSync(directory))
  .flatMap(modules)
  .sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr);
  }
}

console.log(`${files.length - failed}/${files.length} modules passed node --check`);
process.exitCode = failed ? 1 : 0;
