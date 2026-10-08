// @vitest-environment jsdom
/**
 * Other people's selections over Live edit (remote-selections.ts).
 *
 * Production, 08.10.2026: someone selected a numbered item and its sub-list;
 * everybody else watching in Live edit saw the selected lines turn into a
 * blank gap — the text was intact, but upstream's plugin put the selection
 * class ON the lines (and on marks wrapping the text), and the presence fade
 * set that class to `opacity: 0`.
 *
 * These tests drive a real EditorView with the live preview (bullets, numbers,
 * tags, highlights, tasks) and a second "peer" whose selection arrives through
 * real awareness updates, and check: nothing throws, no decoration restyles a
 * whole line, the text is all still in the lines, and nothing is written.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folioCollab } from './collab-sync';
import { livePreview, livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import editorCss from './editor.css?raw';
import { remoteSelectionDecorations } from './remote-selections';

const DOC = `# Goals Q4 2026

Intro with **bold** and ==highlight==.

1. First goal with **bold** text
2. ==SELECTED== Product Ops handover :status[In progress]{color=green}
   - Sub one with **bold** word
   - Sub two ==highlight== inside
     - Nested level three with \`code\`
   - [ ] A task in the sub-list
   - Sub five with a [link](https://example.com)
3. Third goal

Paragraph after the list.

- Bullet list
  - Second level
    - Third level
- Back to the first
`;

const views: EditorView[] = [];
let errors: unknown[][] = [];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
  vi.spyOn(console, 'warn').mockImplementation((...args) => void errors.push(args));
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** A viewer's editor and a peer that shares its document and can select. */
function setup(text = DOC, binding: typeof folioCollab | typeof yCollab = folioCollab, live = true) {
  const viewerDoc = new Y.Doc();
  viewerDoc.getText('content').insert(0, text);
  const peerDoc = new Y.Doc();
  Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(viewerDoc));
  const viewerAwareness = new Awareness(viewerDoc);
  const peerAwareness = new Awareness(peerDoc);
  peerAwareness.setLocalStateField('user', { name: 'Owner', color: '#ee6352' });

  const ytext = viewerDoc.getText('content');
  const view = new EditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        markdownEditorExtensions(),
        livePreview,
        livePreviewConfig(live, { space: 'eng', pagePath: 'goals.md', pageId: 'P1' }),
        binding(ytext, viewerAwareness, { undoManager: new Y.UndoManager(ytext) }),
      ],
      selection: EditorSelection.single(0),
    }),
    parent: document.body.appendChild(document.createElement('div')),
  });
  views.push(view);

  const peerText = peerDoc.getText('content');
  /** The peer selects [anchor, head] (its own Y.Text indices); the viewer receives it. */
  const select = (anchor: number, head: number) => {
    peerAwareness.setLocalStateField('cursor', {
      anchor: Y.createRelativePositionFromTypeIndex(peerText, anchor),
      head: Y.createRelativePositionFromTypeIndex(peerText, head),
    });
    applyAwarenessUpdate(viewerAwareness, encodeAwarenessUpdate(peerAwareness, [peerDoc.clientID]), 'remote');
  };
  return { view, ytext, select, peerText };
}

/** Text of every `.cm-line`, as the reader sees it (widgets' glyphs included). */
const lineTexts = (view: EditorView) =>
  [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => {
    const clone = line.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.cm-ySelectionCaret').forEach((caret) => caret.remove());
    return clone.textContent;
  });

const crashed = () => errors.filter((args) => args.some((a) => /plugin crashed|Ranges must be added sorted|remote selections/i.test(String(a))));

describe('a remote selection over the live preview', () => {
  it('reproduces the cause with upstream yCollab: the selection class lands on whole lines', () => {
    const { view, select } = setup(DOC, yCollab);
    const from = DOC.indexOf('2. ==SELECTED');
    select(from, DOC.indexOf('\n3. Third'));
    // The class the presence fade set to opacity 0 sits on the .cm-line itself.
    expect(view.contentDOM.querySelectorAll('.cm-line.cm-yLineSelection').length).toBeGreaterThan(0);
  });

  it('draws the selection across numbers, bullets, tags and highlights without touching the lines', () => {
    const { view, ytext, select } = setup();
    const before = lineTexts(view);
    const from = DOC.indexOf('2. ==SELECTED');
    const to = DOC.indexOf('\n3. Third');
    select(from, to);

    expect(view.contentDOM.querySelectorAll('.cm-ySelection').length).toBeGreaterThan(0);
    expect(view.contentDOM.querySelectorAll('.cm-ySelectionCaret')).toHaveLength(1);
    // Nothing restyles a whole line: the selection is marks only.
    expect(view.contentDOM.querySelector('.cm-yLineSelection')).toBeNull();
    // Every line still shows all of its text (the caret's name label aside).
    expect(lineTexts(view)).toEqual(before);
    // The colour travels as a variable the presence fade can switch off, not as a fixed background.
    const mark = view.contentDOM.querySelector('.cm-ySelection') as HTMLElement;
    expect(mark.style.getPropertyValue('--folio-ysel-bg')).toBe('#ee635233');
    expect(mark.style.backgroundColor).toBe('');
    // The live preview is intact under it.
    expect(view.contentDOM.querySelectorAll('.cm-md-bullet').length).toBeGreaterThan(0);
    expect(view.contentDOM.querySelector('.cm-md-li')).not.toBeNull();

    expect(crashed()).toEqual([]);
    expect(view.state.doc.toString()).toBe(DOC);
    expect(ytext.toString()).toBe(DOC);
  });

  it('survives every combination of ends: inside markers, on line edges, across levels, both directions', () => {
    const { view, ytext, select } = setup();
    const points = new Set<number>([0, DOC.length]);
    // Every line start/end and the first few characters of each line — where
    // the replaced list markers, task boxes and heading marks are.
    let pos = 0;
    for (const line of DOC.split('\n')) {
      for (let i = 0; i <= Math.min(line.length, 8); i++) points.add(pos + i);
      points.add(pos + line.length);
      pos += line.length + 1;
    }
    // Inside the inline syntax: highlight, status tag, bold, code, link.
    for (const needle of ['==SELECTED==', ':status[', ']{color=green}', '**bold** word', '`code`', '](https://']) {
      const at = DOC.indexOf(needle);
      for (let i = 0; i <= needle.length; i += 2) points.add(at + i);
    }
    const all = [...points].filter((p) => p >= 0 && p <= DOC.length).sort((a, b) => a - b);
    const sample = all.filter((_, i) => i % 4 === 0);
    const before = lineTexts(view);
    for (const anchor of sample) {
      for (const head of sample) {
        select(anchor, head);
        expect(view.contentDOM.querySelectorAll('.cm-ySelectionCaret').length).toBeLessThanOrEqual(1);
      }
    }
    expect(lineTexts(view)).toEqual(before);
    expect(view.contentDOM.querySelector('.cm-yLineSelection')).toBeNull();
    expect(crashed()).toEqual([]);
    expect(view.state.doc.toString()).toBe(DOC);
    expect(ytext.toString()).toBe(DOC);
  }, 60_000);

  it('keeps working while the viewer edits and the peer selects, in Source mode too', () => {
    for (const live of [true, false]) {
      const { view, ytext, select } = setup(DOC, folioCollab, live);
      select(DOC.indexOf('- Sub one'), DOC.indexOf('- Sub five'));
      view.dispatch({ changes: { from: DOC.indexOf('Sub two'), insert: 'X' }, userEvent: 'input.type' });
      select(DOC.indexOf('1. First'), DOC.length);
      expect(crashed()).toEqual([]);
      expect(ytext.toString()).toBe(view.state.doc.toString());
      expect(view.state.doc.toString()).toBe(DOC.replace('Sub two', 'XSub two'));
    }
  });

  it('a caret that would sit inside a replaced list marker is moved to its edge and stays visible', () => {
    const { view, select } = setup();
    const marker = DOC.indexOf('   - Sub one');
    select(marker + 3, marker + 4); // head between "-" and the space
    const caret = view.contentDOM.querySelector('.cm-ySelectionCaret') as HTMLElement;
    expect(caret).not.toBeNull();
    // Drawn at an edge of the replaced marker, not swallowed inside it.
    expect([marker + 3, marker + 5]).toContain(view.posAtDOM(caret));
    expect(crashed()).toEqual([]);
  });
});

describe('positions the editor does not have', () => {
  it('a peer position past the end of the editor is clamped, not thrown', () => {
    const state = EditorState.create({ doc: 'short\ntext' });
    const set = remoteSelectionDecorations(state, [
      { clientId: 1, anchor: -5, head: 9999, color: '#000', colorLight: '#0003', name: 'A' },
      { clientId: 2, anchor: Number.NaN, head: 3, color: '#000', colorLight: '#0003', name: 'B' },
    ]);
    const ranges: [number, number][] = [];
    set.between(0, state.doc.length, (from, to) => void ranges.push([from, to]));
    expect(ranges.every(([from, to]) => from >= 0 && to <= state.doc.length)).toBe(true);
  });

  it('a Y.Text with "\\r\\n" (old documents): the peer at its end is the editor end', () => {
    const raw = '# Old\r\n\r\n- one\r\n- two\r\n';
    const { view, select, peerText } = setup(raw);
    expect(view.state.doc.toString()).toBe(raw.replace(/\r\n/g, '\n'));
    select(0, peerText.length);
    expect(crashed()).toEqual([]);
    // Without the "\r" mapping the head would land 4 characters past the end and be thrown away or clamped wrongly.
    const caret = view.contentDOM.querySelector('.cm-ySelectionCaret') as HTMLElement;
    expect(view.posAtDOM(caret)).toBe(view.state.doc.length);
    expect(view.contentDOM.querySelectorAll('.cm-ySelection').length).toBeGreaterThan(0);
  });
});

describe('the presence fade', () => {
  it('never hides anything that holds document text (only the selection background and the caret)', () => {
    const css = editorCss;
    const rules = css.match(/[^{}]*\{[^{}]*\}/g) ?? [];
    for (const rule of rules) {
      const [selector, body] = rule.split('{');
      if (!/cm-ySelection(?!Caret|Info)|cm-yLineSelection/.test(selector)) continue;
      expect(body, selector.trim()).not.toMatch(/(?<![-\w])(opacity|visibility|display|color)\s*:/);
    }
  });
});
