// The package version, read once from package.json.

import fs from 'node:fs';

/** Version of this mcpc installation. */
export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
