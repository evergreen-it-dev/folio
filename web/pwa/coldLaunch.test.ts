// @vitest-environment node
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executablePath, launch, type Browser } from 'puppeteer-core';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { offlineReaderWorker } from './buildWorker';

it('renders the reader after the browser restarts with the server unreachable', async (ctx) => {
  const chromium = process.env.CHROMIUM_PATH || await executablePath('chrome').catch(() => undefined);
  if (!chromium) return ctx.skip();
  const root = await mkdtemp(path.join(tmpdir(), 'folio-cold-launch-'));
  const openBrowser = () => launch({ executablePath: chromium, headless: true, userDataDir: path.join(root, 'profile'), args: ['--no-sandbox'] });
  let browser: Browser | undefined;
  const server = createServer(async (req, res) => {
    const file = req.url === '/' ? '/index.html' : req.url!;
    try {
      const body = await readFile(path.join(root, 'dist', file));
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      // Folio reflects Origin and sets Vary on static responses as well as API responses.
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', vary: 'Origin', ...(req.headers.origin ? { 'access-control-allow-origin': req.headers.origin } : {}) }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  try {
    const input = ['index.html', 'offline.html'].map((name) => path.join(root, name));
    await Promise.all([
      writeFile(input[0], '<script type="module" src="/install.js"></script>'),
      writeFile(input[1], '<main></main><script type="module" src="/reader.js"></script>'),
      writeFile(path.join(root, 'install.js'), "navigator.serviceWorker.register('/sw.js');"),
      writeFile(path.join(root, 'reader.js'), "import './reader.css'; document.querySelector('main').textContent = 'Available offline';"),
      writeFile(path.join(root, 'reader.css'), 'main { color: rgb(1, 2, 3); }'),
    ]);
    await build({ root, configFile: false, logLevel: 'silent', plugins: [offlineReaderWorker()],
      build: { manifest: 'assets/manifest.json', rolldownOptions: { input } } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    const url = 'http://127.0.0.1:' + address.port;
    browser = await openBrowser();
    const online = await browser.newPage();
    await online.goto(url);
    await online.evaluate(async () => { await navigator.serviceWorker.ready; });
    await browser.close();
    browser = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    browser = await openBrowser();
    const cold = await browser.newPage();
    await cold.setCacheEnabled(false);
    const navigation = await cold.goto(url + '/s/notes/p/one', { waitUntil: 'load' });
    expect(navigation?.fromServiceWorker()).toBe(true);
    expect(await cold.$eval('main', (main) => [main.textContent, getComputedStyle(main).color])).toEqual(['Available offline', 'rgb(1, 2, 3)']);
  } finally {
    await browser?.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
