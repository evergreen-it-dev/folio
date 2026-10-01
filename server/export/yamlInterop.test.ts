/**
 * js-yaml through an ESM import — a regression that cost a 500 in production.
 *
 * `import * as yaml from 'js-yaml'` worked locally (Node 20) and gave an
 * object WITHOUT functions in the production image (Node 22): js-yaml is a
 * CJS package, and which named exports ESM sees in it is decided by
 * cjs-module-lexer, whose behavior depends on the Node version. On top of
 * that the package itself was not declared in package.json — the code relied
 * on a transitive copy from gray-matter, and which version would surface was
 * a matter of chance too.
 *
 * These tests hold both halves: the package is declared, and its API is
 * really callable THROUGH THE SAME import the production code uses.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as yamlModule from 'js-yaml';

const yaml = (yamlModule as unknown as { default?: typeof yamlModule }).default ?? yamlModule;

describe('js-yaml interop', () => {
  it('is a DECLARED dependency, not a transitive accident', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['js-yaml']).toBeTruthy();
  });

  it('exposes dump/load through the exact import shape production uses', () => {
    expect(typeof yaml.dump).toBe('function');
    expect(typeof yaml.load).toBe('function');
  });

  it('round-trips a document with the options the exporters pass', () => {
    const doc = { frames: [{ label: 'A very long caption — do not wrap it' }], edges: [{ from: 'a', to: 'b' }] };
    const text = yaml.dump(doc, { lineWidth: -1, sortKeys: false, noRefs: true });
    expect(text).not.toContain('\n  A very'); // lineWidth: -1 — no wrapping inside a scalar
    expect(yaml.load(text)).toEqual(doc);
  });

  it('no longer references the v3-only safeDump/safeLoad anywhere in shipped code', () => {
    for (const f of ['boardText.ts', 'yaml.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toContain('safeDump');
      expect(src).not.toContain('safeLoad');
    }
  });
});
