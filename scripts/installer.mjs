#!/usr/bin/env node
// Installer core entry, run by installer.sh and installer.ps1 once the checkout
// exists.
//
//   node scripts/installer.mjs install [--skills DIR]
//     Upgrade the checkout to the latest release when it is newer, then run
//     `sync` from the (possibly new) checkout.
//   node scripts/installer.mjs sync [--skills DIR] [--recorded] [--fresh]
//     Install dependencies, link the global command and copy the skill.
//
// `--skills DIR` installs into that skills directory only, in addition to the
// recorded ones; without it every known harness present is used. `--recorded`
// keeps to the recorded harnesses; `--fresh` reinstalls dependencies.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { APP_ROOT, InstallError, sync, upgrade } from '../lib/install.mjs';

const MARKS = { ok: '✓', warn: '!', fail: '✗' };

function log(kind, message, detail) {
  process.stdout.write(`  ${MARKS[kind]} ${message}${detail ? `  ${detail}` : ''}\n`);
}

function fail(message, fix) {
  process.stderr.write(`  ${MARKS.fail} ${message}\n${fix ? `    -> ${fix}\n` : ''}`);
  process.exitCode = 1;
}

function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      skills: { type: 'string' },
      recorded: { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
    },
  });
  const [command, ...extra] = positionals;
  if (!['install', 'sync'].includes(command) || extra.length)
    return fail(
      'Usage: node scripts/installer.mjs install|sync [--skills DIR] [--recorded] [--fresh]',
    );
  if (values.skills !== undefined && !path.isAbsolute(values.skills))
    return fail(`The skills directory must be absolute: ${values.skills}`);
  const skillsArgs = values.skills ? ['--skills', values.skills] : [];

  if (command === 'install') {
    let result = { changed: false };
    try {
      result = upgrade(APP_ROOT);
      log(
        'ok',
        result.changed
          ? `Updated mcpc from ${result.current} to ${result.version}`
          : `mcpc ${result.current} is the latest release`,
        APP_ROOT,
      );
    } catch (error) {
      // Offline, or nothing released yet: install the checkout as it is.
      if (!(error instanceof InstallError) || !error.unreachable) throw error;
      log(
        'warn',
        `Cannot check for a newer release (${error.message}); installing this checkout as it is`,
        APP_ROOT,
      );
    }
    // Run the rest from the checkout as it is now, which may be newer than this process.
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        'sync',
        ...skillsArgs,
        ...(result.changed ? ['--fresh'] : []),
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    process.exitCode = child.status ?? 1;
    return;
  }

  sync({
    skillsDirs: values.skills ? [values.skills] : [],
    recordedOnly: values.recorded,
    freshDependencies: values.fresh,
    log,
  });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof InstallError) fail(error.message, error.fix);
  else fail(error?.message ?? String(error));
}
