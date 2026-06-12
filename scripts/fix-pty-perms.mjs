// node-pty's published prebuilds ship spawn-helper without the executable
// bit, which makes every spawn on macOS fail with "posix_spawnp failed.".
// Runs as postinstall to restore it. Safe no-op everywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');

if (fs.existsSync(prebuilds)) {
  for (const platform of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`fix-pty-perms: chmod 755 ${path.relative(root, helper)}`);
    }
  }
}
