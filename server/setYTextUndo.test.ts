/**
 * Issue #18: after an agent rewrites a page through REST/MCP, the browser user's Undo must still be
 * able to remove their own earlier typing. setYText has to keep unchanged text between two edited
 * passages under its original Yjs identity; the result must always equal the requested body exactly.
 */
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { setYText } from './collab.js';

const LOCAL = Symbol('local');

function setup(initial: string) {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, initial);
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  return { doc, text, undo };
}

describe('setYText keeps text between edits (issue #18)', () => {
  it('Undo removes only the person sentence after an API edit of two separate passages', () => {
    const { doc, text, undo } = setup('# Two passages\n\nFirst: old.\n\nMiddle: original.\n\nLast: old.');
    const typed = '\n\nBrowser note: keep this sentence.';
    const at = text.toString().indexOf('Middle: original.') + 'Middle: original.'.length;
    doc.transact(() => text.insert(at, typed), LOCAL);
    const body = text.toString().replace('First: old.', 'First: new.').replace('Last: old.', 'Last: new.');
    doc.transact(() => setYText(text, body)); // API path: no tracked origin
    expect(text.toString()).toBe(body);
    undo.undo();
    expect(text.toString()).toBe('# Two passages\n\nFirst: new.\n\nMiddle: original.\n\nLast: new.');
  });

  it('unchanged text yields no ops', () => {
    const { doc, text } = setup('same text');
    let updates = 0;
    doc.on('update', () => updates++);
    setYText(text, 'same text');
    expect(updates).toBe(0);
  });

  it('is byte-exact for random edits, emoji and over-cap rewrites', () => {
    let seed = 12345;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const alphabet = ['a', 'b', ' ', '\n', '😀', '𝒳', 'é', 'ñ'];
    const gen = (len: number) => Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join('');
    for (let i = 0; i < 300; i++) {
      const base = gen(rnd(60));
      const chars = Array.from(base);
      for (let e = rnd(6); e > 0 && chars.length; e--) chars.splice(rnd(chars.length), rnd(3), gen(rnd(4)));
      const next = i % 50 === 0 ? gen(3000) : chars.join('');
      const { doc, text } = setup(i % 50 === 0 ? gen(3000) : base);
      doc.transact(() => setYText(text, next));
      expect(text.toString()).toBe(next);
    }
  });

  it('falls back to a single replace above the cap and stays exact', () => {
    const a = `${'x'.repeat(5)}${'a'.repeat(3000)}${'y'.repeat(5)}`;
    const b = `${'x'.repeat(5)}${'b'.repeat(3000)}${'y'.repeat(5)}`;
    const { doc, text } = setup(a);
    doc.transact(() => setYText(text, b));
    expect(text.toString()).toBe(b);
  });
});
