#!/usr/bin/env node
import { main } from '../lib/main.mjs';

const code = await main(process.argv.slice(2));
// `mcpc daemon` keeps running and returns null; every other command sets its exit code.
if (code !== null) process.exitCode = code;
