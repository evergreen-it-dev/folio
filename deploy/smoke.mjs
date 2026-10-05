#!/usr/bin/env node
// Checks a fresh Folio instance end to end: health, first-account setup, a
// space, a page, and a real-time (WebSocket) connection to that page.
//
//   node deploy/smoke.mjs https://wiki.example.com
//
// Needs Node 18+. It creates the first account, so run it only on an instance
// nobody has used yet, and delete the instance (or the space) afterwards.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const base = (process.argv[2] ?? process.env.FOLIO_URL ?? 'http://localhost:4870').replace(/\/$/, '');
const email = `smoke-${crypto.randomBytes(3).toString('hex')}@example.com`;
const password = crypto.randomBytes(12).toString('hex');
let cookie = '';

const step = (msg) => console.log(`- ${msg}`);
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) if (c.startsWith('folio_session=')) cookie = c.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const health = await call('GET', '/api/health');
if (!health?.ok) throw new Error('health check failed');
step('health: ok');

const state = await call('GET', '/api/auth/state');
if (!state.needsSetup) throw new Error('this instance already has an account; run the smoke test on a fresh one');
await call('POST', '/api/auth/setup', { email, name: 'Smoke Test', password });
if (!cookie) throw new Error('setup did not set a session cookie (check PUBLIC_URL: http vs https)');
step('first account created and signed in');

const space = await call('POST', '/api/spaces', { name: 'Smoke test' });
step(`space created: ${space.slug}`);
const page = await call('POST', '/api/pages', { space: space.slug, parentPath: '', title: 'Hello' });
await call('PUT', `/api/pages/${page.id}`, { markdown: '# Hello\n\nWritten by smoke.mjs.\n' });
const back = await call('GET', `/api/pages/${page.id}`);
if (!JSON.stringify(back).includes('Written by smoke.mjs')) throw new Error('the page did not keep its text');
step('page written and read back');

// A bare WebSocket handshake (no dependencies, any Node 18+): the server must
// answer "101 Switching Protocols", then send its first frame.
const target = new URL(base + `/collab/${encodeURIComponent(page.id)}`);
await new Promise((resolve, reject) => {
  const req = (target.protocol === 'https:' ? https : http).request(target, {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      Cookie: cookie,
    },
  });
  const timer = setTimeout(() => { req.destroy(); reject(new Error('WebSocket: no answer from /collab within 10 s (does your proxy pass Upgrade headers?)')); }, 10_000);
  req.on('upgrade', (_res, socket, head) => {
    const done = () => { clearTimeout(timer); socket.destroy(); resolve(); };
    if (head.length) done(); else socket.once('data', done);
  });
  req.on('response', (res) => { clearTimeout(timer); reject(new Error(`WebSocket: /collab answered ${res.statusCode} instead of 101 (the proxy drops Upgrade headers, or the session is not accepted)`)); });
  req.on('error', (err) => { clearTimeout(timer); reject(new Error(`WebSocket: ${err.message}`)); });
  req.end();
});
step('WebSocket (real-time editing): connected, data received');
console.log('\nAll checks passed.');
