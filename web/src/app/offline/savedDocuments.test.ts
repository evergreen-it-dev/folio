// @vitest-environment node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import { executablePath, launch, type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as savedDocuments from './savedDocuments';

declare global {
  interface Window {
    readerStore: typeof savedDocuments;
    readerChanged: boolean;
  }
}

const document = { id: 'first', space: 'notes', title: 'Reading list', markdown: '# Notes', savedAt: 1 };

// Use two real browser tabs: jsdom does not implement IndexedDB's transaction
// scheduling or the browser's cross-tab message delivery.
describe('saved offline documents', () => {
  let browser: Browser | undefined;
  let first: Page;
  let second: Page;
  const server = createServer();
  beforeAll(async () => {
    const chromium = process.env.CHROMIUM_PATH || await executablePath('chrome').catch(() => undefined);
    if (!chromium) return;
    const source = await readFile(new URL('./savedDocuments.ts', import.meta.url), 'utf8');
    const module = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    server.on('request', (request, response) => {
      if (request.url === '/store.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(module);
      else response.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<script type="module">import * as store from "/store.js"; window.readerStore = store;</script>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = await launch({ executablePath: chromium, headless: true, args: ['--no-sandbox'] });
    first = await browser.newPage();
    second = await browser.newPage();
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    await Promise.all([first.goto(url), second.goto(url)]);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('upgrades previously saved snapshots into the library index and reads the requested document by its space and id', async (ctx) => {
    if (!browser) return ctx.skip();
    await first.evaluate(async (doc) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('folio-offline-reader', 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore('account').put('alice', 'current');
          const docs = open.result.createObjectStore('documents', { keyPath: 'id' });
          docs.put(doc);
          docs.put({ ...doc, id: 'other', title: 'Work', markdown: 'Another document' });
        };
        open.onsuccess = () => { open.result.close(); resolve(); };
        open.onerror = () => reject(open.error);
      });
    }, document);
    expect(await first.evaluate(() => window.readerStore.listOfflineDocuments())).toEqual([
      { id: 'first', space: 'notes', title: 'Reading list' }, { id: 'other', space: 'notes', title: 'Work' },
    ]);
    expect(await first.evaluate(() => window.readerStore.getOfflineDocument('notes', 'first'))).toEqual(document);
    expect(await first.evaluate(() => window.readerStore.getOfflineDocument('other', 'first'))).toBeUndefined();
    await first.evaluate(() => window.readerStore.clearOfflineDocuments());
  });

  it('keeps explicit pins across reloads and same-account checks; removing a pin drops it', async (ctx) => {
    if (!browser) return ctx.skip();
    await first.evaluate(async (doc) => {
      await window.readerStore.setOfflineReaderAccount('alice');
      await window.readerStore.saveOfflineDocument('alice', doc);
    }, document);
    await first.reload();
    await first.evaluate(() => window.readerStore.setOfflineReaderAccount('alice'));
    expect(await first.evaluate(() => window.readerStore.getOfflineDocument('notes', 'first'))).toEqual(document);
    expect(await first.evaluate(() => window.readerStore.listOfflineDocumentIds('alice'))).toEqual(['first']);
    expect(await first.evaluate(() => window.readerStore.hasOfflineDocument('bob', 'first'))).toBe(false);
    await first.evaluate(() => window.readerStore.removeOfflineDocument('alice', 'first'));
    expect(await first.evaluate(() => window.readerStore.listOfflineDocuments('alice'))).toEqual([]);
  });

  it('changes the owner atomically with clearing pins and rejects late writes from another tab', async (ctx) => {
    if (!browser) return ctx.skip();
    await first.evaluate(async (doc) => {
      await window.readerStore.setOfflineReaderAccount('alice');
      await window.readerStore.saveOfflineDocument('alice', doc);
    }, document);
    await Promise.allSettled([
      first.evaluate((doc) => window.readerStore.saveOfflineDocument('alice', { ...doc, id: 'late' }), document),
      second.evaluate(() => window.readerStore.setOfflineReaderAccount('bob')),
    ]);
    expect(await second.evaluate(() => window.readerStore.listOfflineDocuments('bob'))).toEqual([]);
    await expect(first.evaluate((doc) => window.readerStore.saveOfflineDocument('alice', doc), document)).rejects.toThrow();
    await second.evaluate((doc) => window.readerStore.saveOfflineDocument('bob', doc), document);
    await first.evaluate(() => window.readerStore.removeOfflineDocument('alice', 'first'));
    await first.evaluate(() => window.readerStore.clearOfflineReaderAccount('alice'));
    expect(await first.evaluate(() => window.readerStore.hasOfflineDocument('bob', 'first'))).toBe(true);
    await second.evaluate(() => window.readerStore.clearOfflineReaderAccount('bob'));
    expect(await second.evaluate(() => window.readerStore.listOfflineDocuments())).toEqual([]);
    expect(await first.evaluate(() => window.readerStore.listOfflineDocuments('alice'))).toEqual([]);
  });

  it('notifies the local and other open reader after clearing a device', async (ctx) => {
    if (!browser) return ctx.skip();
    await first.evaluate(async (doc) => {
      await window.readerStore.setOfflineReaderAccount('alice');
      await window.readerStore.saveOfflineDocument('alice', doc);
    }, document);
    for (const page of [first, second]) {
      await page.evaluate(() => {
        window.readerChanged = false;
        window.readerStore.subscribeOfflineDocuments(() => { window.readerChanged = true; });
      });
    }
    await first.evaluate(() => window.readerStore.clearOfflineDocuments());
    for (const page of [first, second]) {
      await page.waitForFunction(() => window.readerChanged);
      expect(await page.evaluate(() => window.readerStore.listOfflineDocuments())).toEqual([]);
    }
    await expect(first.evaluate((doc) => window.readerStore.saveOfflineDocument('alice', doc), document)).rejects.toThrow();
  });
});

it('fails a save when the browser cannot provide durable storage', async () => {
  const { saveOfflineDocument } = await import('./savedDocuments');
  await expect(saveOfflineDocument('alice', document)).rejects.toThrow();
});
