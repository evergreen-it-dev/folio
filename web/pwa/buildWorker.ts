import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Manifest, Plugin } from 'vite';

/** Embed the neutral HTML and fingerprint only the assets the offline reader can load. */
export function offlineReaderWorker(): Plugin {
  let output: string;
  return {
    name: 'folio-offline-reader',
    apply: 'build',
    configResolved(config) {
      output = path.resolve(config.root, config.build.outDir);
    },
    writeBundle: {
      order: 'post',
      async handler() {
        const [html, manifestJson, worker] = await Promise.all([
          readFile(path.join(output, 'offline.html'), 'utf8'),
          readFile(path.join(output, 'assets/manifest.json'), 'utf8'),
          readFile(new URL('./worker.js', import.meta.url), 'utf8'),
        ]);
        const manifest: Manifest = JSON.parse(manifestJson);
        const seen = new Set<string>();
        const files = new Set<string>();
        function collect(key: string) {
          if (seen.has(key)) return;
          seen.add(key);
          const chunk = manifest[key];
          for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(file);
          for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) collect(dependency);
        }
        collect('offline.html');
        const assets: Record<string, string> = {};
        for (const file of [...files].sort()) {
          const bytes = await readFile(path.join(output, file));
          assets['/' + file] = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
        }
        const version = createHash('sha256').update(html).update(JSON.stringify(assets)).digest('hex');
        await writeFile(path.join(output, 'sw.js'), 'const READER = ' + JSON.stringify({ version, html, assets }) + ';\n' + worker);
      },
    },
  };
}
