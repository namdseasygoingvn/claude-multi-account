// ── macOS update install step — mount the .dmg and swap the .app in place ─────
// Split out of updater-mac so each file keeps one job (and stays under the line
// cap). Given a downloaded .dmg, this mounts it, hands a detached helper the
// bundle swap, and quits so the (no-longer-running) bundle can be replaced and
// the new version relaunched — no Finder drag, no "replace?"/"in use" dialogs.
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { getAvailableUpdate, notify, setUpdateState } from './updater-shared.js';
import { RELAUNCH_SCRIPT } from './updater-mac-relaunch.js';

const execFileP = promisify(execFile);

/**
 * Install the downloaded .dmg in place and relaunch. Returns true if the
 * relauncher was launched (app is about to quit); false to fall back to opening
 * the dmg (not packaged / no write access / unexpected layout).
 */
export async function applyDmg(dmgPath: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged) return false;

  const exe = app.getPath('exe');
  const i = exe.indexOf('.app/');
  if (i === -1) return false;
  const appBundle = exe.slice(0, i + 4); // e.g. /Applications/Claude Quota Monitor.app

  // We need to replace the bundle without elevation; if not, fall back to manual.
  try {
    await access(path.dirname(appBundle), fsConstants.W_OK);
  } catch {
    return false;
  }

  const mount = path.join(os.tmpdir(), `cqm-mnt-${process.pid}-${Date.now()}`);
  try {
    await mkdir(mount, { recursive: true });
    await execFileP('hdiutil', ['attach', dmgPath, '-nobrowse', '-noverify', '-mountpoint', mount]);
  } catch {
    return false;
  }

  let srcApp: string | null = null;
  try {
    const appName = (await readdir(mount)).find((n) => n.endsWith('.app'));
    if (appName) srcApp = path.join(mount, appName);
  } catch {
    /* fall through to detach + bail */
  }
  if (!srcApp) {
    await execFileP('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
    return false;
  }

  const staging = appBundle.replace(/\.app$/, '.update.app');
  const scriptPath = path.join(os.tmpdir(), `cqm-relaunch-${process.pid}-${Date.now()}.sh`);
  await writeFile(scriptPath, RELAUNCH_SCRIPT, { mode: 0o755 });

  notify('Installing update', `Updating to ${getAvailableUpdate()?.tag ?? 'the latest version'} and restarting…`);

  setUpdateState({ installing: true });
  spawn('/bin/bash', [scriptPath, String(process.pid), srcApp, appBundle, staging, mount, dmgPath, scriptPath], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  // Let the notification render, then quit so the helper can swap the
  // (no-longer-running) bundle and relaunch the new version.
  setTimeout(() => app.quit(), 500);
  return true;
}
