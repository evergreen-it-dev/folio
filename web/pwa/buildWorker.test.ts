import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { offlineReaderWorker } from './buildWorker';

it('builds a standalone reader worker with the full offline entry graph and no wiki bundle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'folio-reader-build-'));
  try {
    await mkdir(path.join(root, 'src'));
    const input = ['index.html', 'offline.html'].map((name) => path.join(root, name));
    await Promise.all([
      writeFile(input[0], '<script type="module" src="/src/wiki.js"></script>'),
      writeFile(input[1], '<main>Offline library</main><script type="module" src="/src/reader.js"></script>'),
      writeFile(path.join(root, 'src/wiki.js'), 'document.title = "Wiki";'),
      writeFile(path.join(root, 'src/reader.js'), "import './reader.css'; document.onclick = () => import('./detail.js');"),
      writeFile(path.join(root, 'src/reader.css'), 'body { color: #333; }'),
      writeFile(path.join(root, 'src/detail.js'), 'document.title = "Detail";'),
    ]);
    await build({ root, configFile: false, logLevel: 'silent', plugins: [offlineReaderWorker()],
      build: { manifest: 'assets/manifest.json', rolldownOptions: { input } },
    });
    const dist = path.join(root, 'dist');
    const script = await readFile(path.join(dist, 'sw.js'), 'utf8');
    const reader = runInNewContext(script + '\nREADER;', { self: { addEventListener() {} } }) as {
      html: string; assets: Record<string, string>;
    };
    expect(reader.html).toBe(await readFile(path.join(dist, 'offline.html'), 'utf8'));
    const paths = Object.keys(reader.assets);
    expect(paths).toEqual(expect.arrayContaining([expect.stringMatching(/\/offline-.*\.js$/), expect.stringMatching(/\.css$/), expect.stringMatching(/\/detail-.*\.js$/)]));
    expect(paths.some((file) => file.startsWith('/assets/index-'))).toBe(false);
    for (const [file, integrity] of Object.entries(reader.assets)) {
      const bytes = await readFile(path.join(dist, file));
      expect(integrity).toBe('sha256-' + createHash('sha256').update(bytes).digest('base64'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
