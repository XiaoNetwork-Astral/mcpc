#!/usr/bin/env node
import { main } from '../lib/main.mjs';

// A reader that stops early (`mcpc tools | head`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
}

process.exitCode = await main(process.argv.slice(2));
