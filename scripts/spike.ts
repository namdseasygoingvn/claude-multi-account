/**
 * Milestone-1 spike: spawn ONE `claude` REPL in a PTY, send /usage, dump the
 * cleaned capture and the parse result. Proves end-to-end capture works on
 * this machine / Claude Code version before involving the server.
 *
 *   npm run spike                          # default config dir (~/.claude)
 *   npm run spike -- --config-dir /path    # a specific account dir
 *   npm run spike -- --save capture.txt    # also write the cleaned capture to a file
 */
import fs from 'node:fs';
import { runUsageOnce } from '../src/usage.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configDir = argValue('--config-dir') ?? process.env.CLAUDE_CONFIG_DIR ?? null;
const savePath = argValue('--save');

console.error(`[spike] config dir: ${configDir ?? '(default ~/.claude)'}`);

const result = await runUsageOnce(configDir, {
  onPhase: (phase) => console.error(`[spike] ${phase}…`),
});

console.error(`[spike] done in ${result.durationMs}ms — ok=${result.ok} loggedIn=${result.loggedIn}`);
if (result.error) console.error(`[spike] error: ${result.error}`);

console.log('────────── cleaned capture ──────────');
console.log(result.raw);
console.log('────────── parse result ──────────');
console.log(JSON.stringify(result.parsed, null, 2));

if (savePath) {
  fs.writeFileSync(savePath, result.raw);
  console.error(`[spike] cleaned capture saved to ${savePath}`);
}

process.exit(result.ok ? 0 : 1);
