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
  removeAccount,
} from './registry.js';
import { LoginManager } from './logins.js';
import { checkUsage } from './usage.js';
import type { AccountStatus } from './types.js';

const PORT = Number(process.env.PORT || 3000);
// Defaults to localhost-only (this machine holds live OAuth state for every
// account). Set HOST=0.0.0.0 to bind all interfaces — required inside a
// container / when hosting remotely, where you MUST also set APP_TOKEN.
const HOST = process.env.HOST || '127.0.0.1';

// Optional shared-secret gate. When APP_TOKEN is set, every HTTP request and
// WebSocket upgrade must present it (via ?token=, a token cookie, or a
// Bearer header). Unset = no auth (fine for 127.0.0.1). MUST be set whenever
// HOST is not loopback — this tool exposes live account sessions.
const APP_TOKEN = process.env.APP_TOKEN || '';
if (APP_TOKEN === '' && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.warn(
    `\n⚠  HOST=${HOST} exposes this server beyond localhost but APP_TOKEN is unset — ` +
      `anyone reachable can control your account sessions. Set APP_TOKEN.\n`,
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromReq(req: http.IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams.get('token');
  if (q) return q;
  const cookie = parseCookies(req.headers.cookie)['token'];
  if (cookie) return cookie;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function tokenOk(req: http.IncomingMessage): boolean {
  return APP_TOKEN === '' || tokenFromReq(req) === APP_TOKEN;
}

const app = express();

// Auth gate (no-op when APP_TOKEN is unset). A valid ?token= is promoted to a
// long-lived cookie so the SPA's fetch() and the WS upgrade carry it onward.
app.use((req, res, next) => {
  if (APP_TOKEN === '') return next();
  if (!tokenOk(req)) {
    res.status(401).type('text/plain').send('unauthorized — open this URL once with ?token=YOUR_TOKEN');
    return;
  }
  if (new URL(req.url, 'http://localhost').searchParams.get('token') === APP_TOKEN) {
    res.setHeader('Set-Cookie', `token=${encodeURIComponent(APP_TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(PROJECT_ROOT, 'web')));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, cb) => cb(tokenOk(info.req)),
});

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
  // Label is optional — the UI sends none and we mint a random handle.
  const raw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  if (raw && !isValidLabel(raw)) {
    res.status(400).json({ error: 'label must be 1–32 chars: letters, digits, dot, dash, underscore' });
    return;
  }
  try {
    const acc = addAccount(raw || undefined);
    logins.start(acc.label, acc.configDir);
    res.status(201).json({ account: statusOf(acc.label) });
  } catch (err) {
    res.status(409).json({ error: errMsg(err) });
  }
});

/** Remove an account: stop any login session, un-register it, drop its dir. */
app.delete('/api/accounts/:label', (req, res) => {
  if (!getAccount(req.params.label)) {
    res.status(404).json({ error: `unknown account "${req.params.label}"` });
    return;
  }
  logins.stop(req.params.label);
  removeAccount(req.params.label);
  res.json({ ok: true });
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

/**
 * Submit the OAuth authorization code into a running login session. Needed
 * for headless/remote hosting: the browser redirect can't reach the server's
 * localhost callback, so Claude shows a code that the user pastes here.
 */
app.post('/api/accounts/:label/login/code', (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code) {
    res.status(400).json({ error: 'body must be { code: string }' });
    return;
  }
  if (!logins.write(req.params.label, code + '\r')) {
    res.status(409).json({ error: 'no active sign-in session for this account' });
    return;
  }
  res.json({ ok: true });
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
