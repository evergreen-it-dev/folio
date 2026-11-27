import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSessionCookie } from './session.js';
import { requestOrigin } from './sso.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import { parseTrustProxy } from '../trustProxy.js';

/**
 * Home-server catalogs (Unraid, Umbrel, CasaOS) open Folio at http://IP:port and have no address to put in
 * PUBLIC_URL. Without it the session cookie must follow the request's own scheme (a `Secure` cookie on plain
 * http is dropped by the browser: sign-in fails silently), and links must carry the request's host WITH its port.
 */
describe('no PUBLIC_URL: session cookie and links follow the request', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, PUBLIC_URL: process.env.PUBLIC_URL };
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ trustProxy: parseTrustProxy('true') });
    await app.register(cookie);
    app.post('/login', async (_request, reply) => {
      setSessionCookie(reply, 'token');
      return { ok: true };
    });
    app.get('/origin', async (request) => ({ origin: publicUrlOrOrigin(requestOrigin(request)) }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_URL;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function login(headers: Record<string, string>, remoteAddress = '192.168.1.50'): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/login', headers, remoteAddress });
    expect(res.statusCode).toBe(200);
    return String(res.headers['set-cookie']);
  }

  async function origin(headers: Record<string, string>, remoteAddress = '192.168.1.50'): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/origin', headers, remoteAddress });
    return res.json<{ origin: string }>().origin;
  }

  it('plain http: the cookie has no Secure, and the origin is the Host with its port', async () => {
    const setCookie = await login({ host: '192.168.1.20:4870' });
    expect(setCookie).toMatch(/^folio_session=token;/);
    expect(setCookie).not.toMatch(/;\s*Secure/i);
    expect(await origin({ host: '192.168.1.20:4870' })).toBe('http://192.168.1.20:4870');
  });

  it('https behind a trusted proxy (X-Forwarded-Proto): Secure, and the origin is https', async () => {
    const headers = { host: 'folio.home.lan', 'x-forwarded-proto': 'https' };
    expect(await login(headers, '127.0.0.1')).toMatch(/;\s*Secure/i);
    expect(await origin(headers, '127.0.0.1')).toBe('https://folio.home.lan');
  });

  it('X-Forwarded-Proto from an untrusted client is ignored: no Secure, http origin', async () => {
    const headers = { host: '203.0.113.7:4870', 'x-forwarded-proto': 'https' };
    expect(await login(headers, '203.0.113.99')).not.toMatch(/;\s*Secure/i);
    expect(await origin(headers, '203.0.113.99')).toBe('http://203.0.113.7:4870');
  });

  it('an explicit https PUBLIC_URL keeps Secure and wins over the request, even on plain http', async () => {
    process.env.PUBLIC_URL = 'https://folio.example.com';
    expect(await login({ host: '192.168.1.20:4870' })).toMatch(/;\s*Secure/i);
    expect(await origin({ host: '192.168.1.20:4870' })).toBe('https://folio.example.com');
  });

  it('an explicit http PUBLIC_URL keeps the cookie without Secure, even over https', async () => {
    process.env.PUBLIC_URL = 'http://192.168.1.20:4870';
    expect(await login({ host: 'folio.home.lan', 'x-forwarded-proto': 'https' }, '127.0.0.1')).not.toMatch(/;\s*Secure/i);
  });

  it('outside production the cookie is never Secure', async () => {
    process.env.NODE_ENV = 'development';
    expect(await login({ host: 'folio.home.lan', 'x-forwarded-proto': 'https' }, '127.0.0.1')).not.toMatch(/;\s*Secure/i);
  });
});

describe('server code builds request origins with the port', () => {
  it('no `${request.protocol}://${request.hostname}` (Fastify 5 hostname drops the port)', () => {
    const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          if (/:\/\/\$\{(?:request|req)\.hostname\}/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(serverDir, full));
        }
      }
    };
    walk(serverDir);
    expect(offenders).toEqual([]);
  });
});
