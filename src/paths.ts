import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Repo root. Works from both src/ (tsx) and dist/ (compiled) since each sits
 * one level below the root. Also where the bundled web/ assets live.
 */
export const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Where mutable data lives: accounts.json, accounts/<label>/, .scratch/.
 * Defaults to the repo root (dev: `electron .` / `npm run spike`), but a
 * packaged .app must write outside its read-only app.asar — so main.ts calls
 * setDataRoot(app.getPath('userData')) before any registry access there.
 *
 * Kept overridable (rather than importing 'electron' here) so registry.ts
 * stays usable from plain Node — tests and the spike script have no Electron.
 */
let dataRoot: string = REPO_ROOT;

export function setDataRoot(root: string): void {
  dataRoot = root;
}

export function getDataRoot(): string {
  return dataRoot;
}
