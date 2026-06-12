import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  PROJECT_ROOT,
  addAccount,
  getAccount,
  isValidLabel,
  loadRegistry,
  probeLogin,
} from './registry.js';
import { LoginManager } from './logins.js';
import { checkUsage } from './usage.js';
import type { AccountStatus } from './types.js';

const PORT = Number(process.env.PORT || 3000);
// Local only — this machine holds live OAuth state for every registered
// account. Never bind this to a LAN/public interface.
const HOST = '127.0.0.1';

const app = express();
app.use(express.json());
app.use(express.static(path.join(PROJECT_ROOT, 'web')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const logins = new LoginManager({
  onSnapshot: (label, snapshot) => broadcast({ type: 'login-output', label, snapshot }),
  onUrl: (label, url) => broadcast({ type: 'login-url', label, url }),
  onStatus: (label, status) => broadcast({ type: 'login-status', label, status }),
  onSuccess: (label, email) => broadcast({ type: 'login-success', label, email }),
  onExit: (label, exitCode) => broadcast({ type: 'login-exit', label, exitCode }),
});

function statusOf(label: string): AccountStatus | null {
  const acc = getAccount(label);
  if (!acc) return null;
  return { ...acc, ...probeLogin(acc), loginActive: logins.isActive(acc.label) };
}

app.get('/api/accounts', (_req, res) => {
  const accounts = loadRegistry().map((acc) => ({
    ...acc,
    ...probeLogin(acc),
    loginActive: logins.isActive(acc.label),
  }));
  res.json({ accounts });
});

app.post('/api/accounts', (req, res) => {
  const label = String(req.body?.label ?? '').trim();
  if (!isValidLabel(label)) {
    res.status(400).json({ error: 'label must be 1–32 chars: letters, digits, dot, dash, underscore' });
    return;
  }
  try {
    const acc = addAccount(label);
    logins.start(acc.label, acc.configDir);
    res.status(201).json({ account: statusOf(label) });
  } catch (err) {
    res.status(409).json({ error: errMsg(err) });
  }
});

/** Start (or report already-running) the interactive login PTY for an account. */
app.post('/api/accounts/:label/login', (req, res) => {
  const acc = getAccount(req.params.label);
  if (!acc) {
    res.status(404).json({ error: `unknown account "${req.params.label}"` });
    return;
  }
  const alreadyActive = logins.isActive(acc.label);
  if (!alreadyActive) logins.start(acc.label, acc.configDir);
  res.json({ account: statusOf(acc.label), alreadyActive });
});

app.post('/api/accounts/:label/login/stop', (req, res) => {
  const stopped = logins.stop(req.params.label);
  res.json({ stopped });
});

let checking = false;
app.post('/api/usage/check', async (req, res) => {
  if (checking) {
    res.status(409).json({ error: 'a usage check is already running' });
    return;
  }
  const labels: unknown = req.body?.labels;
  const all = loadRegistry();
  const targets =
    Array.isArray(labels) && labels.length > 0 ? all.filter((a) => labels.includes(a.label)) : all;
  if (targets.length === 0) {
    res.json({ results: [] });
    return;
  }
  checking = true;
  broadcast({ type: 'check-start', labels: targets.map((t) => t.label) });
  try {
    // Fan out in parallel — one ephemeral claude PTY per account.
    const results = await Promise.all(
      targets.map((acc) =>
        checkUsage(acc, {
          onPhase: (phase) => broadcast({ type: 'usage-status', label: acc.label, phase }),
        }).then((result) => {
          broadcast({ type: 'usage-result', result });
          return result;
        }),
      ),
    );
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  } finally {
    checking = false;
    broadcast({ type: 'check-done' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`claude quota monitor → http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  logins.stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  logins.stopAll();
  process.exit(0);
});
