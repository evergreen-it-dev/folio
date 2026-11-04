import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createAnchors, eolMap, resolveThreads, sortByPosition, type AnchoredThread } from './comment-anchors';

function docWith(text: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, text);
  return { doc, ytext };
}

function thread(ytext: Y.Text, from: number, to: number, quotedText: string, id = 't1'): AnchoredThread {
  return { id, quotedText, ...createAnchors(ytext, from, to) };
}

describe('resolveThreads', () => {
  it('follows the range through edits before and inside it', () => {
    const { doc, ytext } = docWith('alpha beta gamma');
    const t = thread(ytext, 6, 10, 'beta');
    ytext.insert(0, '>>> ');
    expect(resolveThreads(doc, ytext, [t])).toEqual([{ id: 't1', state: 'anchor', from: 10, to: 14 }]);
    ytext.insert(11, 'XX');
    expect(resolveThreads(doc, ytext, [t])[0]).toMatchObject({ state: 'anchor', from: 10, to: 16 });
  });

  it('does not grow when text is typed at either edge', () => {
    const { doc, ytext } = docWith('alpha beta gamma');
    const t = thread(ytext, 6, 10, 'beta');
    ytext.insert(6, 'AAA');
    ytext.insert(13, 'ZZZ');
    expect(resolveThreads(doc, ytext, [t])[0]).toMatchObject({ state: 'anchor', from: 9, to: 13 });
    expect(ytext.toString().slice(9, 13)).toBe('beta');
  });

  it('survives a CRLF document: editor positions skip the "\\r"', () => {
    const raw = 'one\r\ntwo\r\nthree four';
    const { doc, ytext } = docWith(raw);
    // Editor text is "one\ntwo\nthree four": "four" is 14..18 there, 16..20 in the Y.Text.
    const t = thread(ytext, 14, 18, 'four');
    expect(t.anchorFrom).toBe(createAnchors(ytext, 14, 18).anchorFrom);
    const resolved = resolveThreads(doc, ytext, [t])[0];
    expect(resolved).toMatchObject({ state: 'anchor', from: 14, to: 18 });
    expect(raw.slice(16, 20)).toBe('four');
    const map = eolMap(raw);
    expect(map.toRaw(14)).toBe(16);
    expect(map.toEditor(16)).toBe(14);
    // Pointing at the "\n" of a "\r\n" is the start of that line break.
    expect(map.toEditor(4)).toBe(3);
  });

  it('is the identity without a "\\r"', () => {
    const map = eolMap('plain');
    expect([map.toRaw(3), map.toEditor(3)]).toEqual([3, 3]);
  });

  it('falls back to the quoted text when the range was deleted', () => {
    const { doc, ytext } = docWith('alpha beta gamma');
    const t = thread(ytext, 6, 10, 'beta');
    ytext.delete(6, 5);
    // Re-typed elsewhere: the quote finds it.
    ytext.insert(0, 'beta ');
    expect(resolveThreads(doc, ytext, [t])[0]).toEqual({ id: 't1', state: 'quote', from: 0, to: 4 });
  });

  it('marks a thread detached when neither the range nor the quote is left', () => {
    const { doc, ytext } = docWith('alpha beta gamma');
    const t = thread(ytext, 6, 10, 'beta');
    ytext.delete(6, 5);
    expect(resolveThreads(doc, ytext, [t])[0]).toEqual({ id: 't1', state: 'detached', from: 0, to: 0 });
  });

  it('finds the quote in a doc that never saw the anchors (reseeded from the file)', () => {
    const { ytext } = docWith('alpha beta gamma');
    const t = thread(ytext, 6, 10, 'beta');
    const fresh = docWith('alpha beta gamma');
    expect(resolveThreads(fresh.doc, fresh.ytext, [t])[0]).toEqual({ id: 't1', state: 'quote', from: 6, to: 10 });
  });

  it('treats garbage anchors as unresolvable, not as an error', () => {
    const { doc, ytext } = docWith('alpha beta');
    const bad: AnchoredThread = { id: 'x', anchorFrom: '!!', anchorTo: '', quotedText: 'beta' };
    expect(resolveThreads(doc, ytext, [bad])[0]).toMatchObject({ state: 'quote', from: 6, to: 10 });
  });
});

describe('sortByPosition', () => {
  it('orders by position and puts detached threads last', () => {
    const resolved = new Map([
      ['a', { id: 'a', state: 'detached' as const, from: 0, to: 0 }],
      ['b', { id: 'b', state: 'anchor' as const, from: 9, to: 12 }],
      ['c', { id: 'c', state: 'quote' as const, from: 2, to: 4 }],
    ]);
    expect(sortByPosition([{ id: 'a' }, { id: 'b' }, { id: 'c' }], resolved).map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });
});
