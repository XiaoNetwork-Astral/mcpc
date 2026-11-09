// Stand-in for npm's npm-cli.js in installer tests. It records every call and
// imitates the few commands the installer uses, without network access or a
// real global prefix:
//   MCPC_FAKE_NPM_LOG   file that receives one JSON line per call
//   MCPC_FAKE_NPM_ROOT  directory playing the global node_modules

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = process.env.MCPC_FAKE_NPM_ROOT;
const link = root ? path.join(root, 'mcpc') : null;

if (process.env.MCPC_FAKE_NPM_LOG)
  fs.appendFileSync(
    process.env.MCPC_FAKE_NPM_LOG,
    `${JSON.stringify({ cwd: process.cwd(), args })}\n`,
  );

const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const removeLink = () => {
  if (!link || !exists(link)) return;
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link);
  }
};

switch (args[0]) {
  case '--version':
    console.log('10.0.0-fake');
    break;
  case 'root':
    console.log(root);
    break;
  case 'ci':
    fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
    break;
  case 'link':
    fs.mkdirSync(root, { recursive: true });
    removeLink();
    fs.symlinkSync(process.cwd(), link, 'junction');
    break;
  case 'ls':
    process.exitCode = link && exists(link) ? 0 : 1;
    break;
  case 'uninstall':
    removeLink();
    break;
  default:
    break;
}
