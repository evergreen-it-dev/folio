// @vitest-environment jsdom
/**
 * The content-loss bug of 06.10.2026 and its fix (collab-sync.ts).
 *
 * Production: text typed in Live edit vanished on switching to Reading and was
 * nowhere — not on the server, not in the history. Cause: one exception from a
 * Y.Doc 'update' handler (y-indexeddb writing to a connection another tab had
 * closed) escaped y-codemirror's sync plugin, CodeMirror switched the plugin
 * off, and from then on the editor kept text the document never got.
 *
 * These tests drive a REAL EditorView over a real Y.Doc, the way index.tsx
 * builds it, and check the one thing that matters: the Y.Text — what Reading
 * renders and the server stores — ends up with everything the editor showed.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { differingSpan, folioCollab, FULL_CHECK_DELAY_MS, normalizeEol, normalizedToRaw } from './collab-sync';

const views: EditorView[] = [];

function mount(doc: Y.Doc, binding: typeof folioCollab | typeof yCollab = folioCollab) {
  const ytext = doc.getText('content');
  const undoManager = new Y.UndoManager(ytext);
  const view = new EditorView({
    state: EditorState.create({ doc: ytext.toString(), extensions: [binding(ytext, new Awareness(doc), { undoManager })] }),
    parent: document.body.appendChild(document.createElement('div')),
  });
  views.push(view);
  return { view, ytext };
}

const typeAtEnd = (view: EditorView, text: string) =>
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('differingSpan', () => {
  it('finds the one span that differs', () => {
    expect(differingSpan('abcXYdef', 'abcQdef')).toEqual({ start: 3, endA: 5, endB: 4 });
    expect(differingSpan('same', 'same')).toEqual({ start: 4, endA: 4, endB: 4 });
    expect(differingSpan('', 'new')).toEqual({ start: 0, endA: 0, endB: 3 });
  });
});

describe('the production failure: an update handler throws', () => {
  it('upstream yCollab: one throw switches syncing off and later typing never reaches the Y.Text (the bug)', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, '# Page\n');
    const { view, ytext } = mount(doc, yCollab);
    const boom = () => {
      throw new Error('The database connection is closing.');
    };
    doc.on('update', boom);
    typeAtEnd(view, 'a');
    doc.off('update', boom);
    typeAtEnd(view, 'fter the failure');
    expect(view.state.doc.toString()).toBe('# Page\nafter the failure');
    // Everything after the first character exists only in the editor.
    expect(ytext.toString()).toBe('# Page\na');
  });

  it('folioCollab: every character reaches the Y.Text while the handler keeps throwing, and after', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, '# Page\n');
    const { view, ytext } = mount(doc);
    const boom = () => {
      throw new Error('The database connection is closing.');
    };
    doc.on('update', boom);
    for (const ch of 'typed while failing ') typeAtEnd(view, ch);
    doc.off('update', boom);
    typeAtEnd(view, 'and after');
    expect(ytext.toString()).toBe('# Page\ntyped while failing and after');
    expect(ytext.toString()).toBe(view.state.doc.toString());
  });
});

describe('repairs', () => {
  it('a change the Y.Text refused is put back from the editor, in place', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'start\nend\n');
    const { view, ytext } = mount(doc);
    const realInsert = ytext.insert.bind(ytext);
    let failures = 2;
    ytext.insert = ((...args: Parameters<Y.Text['insert']>) => {
      if (failures-- > 0) throw new Error('refused');
      return realInsert(...args);
    }) as Y.Text['insert'];
    vi.useFakeTimers();
    view.dispatch({ changes: { from: 6, insert: 'middle\n' }, userEvent: 'input.type' });
    ytext.insert = realInsert;
    // The immediate repair was refused too; the follow-up check gets it in.
    expect(ytext.toString()).toBe('start\nend\n');
    vi.advanceTimersByTime(FULL_CHECK_DELAY_MS + 10);
    expect(ytext.toString()).toBe('start\nmiddle\nend\n');
  });

  it('a refused change is put back immediately when the repair can land', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'start\nend\n');
    const { view, ytext } = mount(doc);
    const realInsert = ytext.insert.bind(ytext);
    let failures = 1;
    ytext.insert = ((...args: Parameters<Y.Text['insert']>) => {
      if (failures-- > 0) throw new Error('refused');
      return realInsert(...args);
    }) as Y.Text['insert'];
    view.dispatch({ changes: { from: 6, insert: 'middle\n' }, userEvent: 'input.type' });
    ytext.insert = realInsert;
    expect(ytext.toString()).toBe('start\nmiddle\nend\n');
  });

  it('a same-length divergence is caught by the delayed full comparison', () => {
    vi.useFakeTimers();
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'abc');
    const { view, ytext } = mount(doc);
    const realDelete = ytext.delete.bind(ytext);
    const realInsert = ytext.insert.bind(ytext);
    // A replace of one character by another where only the delete lands: lengths
    // still differ… so make both silently do nothing instead: equal lengths, different text.
    ytext.delete = (() => undefined) as Y.Text['delete'];
    ytext.insert = (() => undefined) as Y.Text['insert'];
    view.dispatch({ changes: { from: 1, to: 2, insert: 'X' } });
    ytext.delete = realDelete;
    ytext.insert = realInsert;
    expect(ytext.toString()).toBe('abc');
    vi.advanceTimersByTime(FULL_CHECK_DELAY_MS + 10);
    expect(ytext.toString()).toBe('aXc');
  });

  it('closing the editor (switching to Reading) hands the Y.Text whatever only the editor had', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, '# Page\n');
    const { view, ytext } = mount(doc);
    const realInsert = ytext.insert.bind(ytext);
    ytext.insert = (() => undefined) as Y.Text['insert'];
    // Make the immediate repair fail too, so only destroy() is left to save it.
    typeAtEnd(view, 'typed, never synced');
    ytext.insert = realInsert;
    expect(ytext.toString()).toBe('# Page\n');
    view.destroy();
    views.splice(views.indexOf(view), 1);
    expect(ytext.toString()).toBe('# Page\ntyped, never synced');
  });

  it('a remote change the editor could not take is shown once it can (Y.Text -> editor)', async () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'local\n');
    const { view, ytext } = mount(doc);
    const realDispatch = view.dispatch.bind(view);
    let failOnce = true;
    view.dispatch = ((...args: Parameters<EditorView['dispatch']>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('Calls to EditorView.update are not allowed while an update is in progress');
      }
      return realDispatch(...args);
    }) as EditorView['dispatch'];
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.getText('content').insert(6, 'remote\n');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), 'remote-peer');
    expect(ytext.toString()).toBe('local\nremote\n');
    expect(view.state.doc.toString()).toBe('local\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(view.state.doc.toString()).toBe('local\nremote\n');
    // And nothing was deleted from the shared text on the way.
    expect(ytext.toString()).toBe('local\nremote\n');
  });
});

describe('carriage returns in the Y.Text (review of 54d4e76)', () => {
  /** Two clients behind a relay that delivers only when told to — concurrent edits, like two people typing at once. */
  function twoClients(initial: string) {
    const server = new Y.Doc();
    server.getText('content').insert(0, initial);
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(server), 'relay');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(server), 'relay');
    const sync = () => {
      for (let i = 0; i < 3; i++) {
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'relay');
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'relay');
      }
    };
    return { a: mount(a), b: mount(b), sync };
  }

  it('normalizedToRaw maps every normalized position to where its source starts', () => {
    expect(normalizeEol('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizedToRaw('a\r\nb\rc')).toEqual([0, 1, 3, 4, 5, 6]);
  });

  it('two clients typing at once into a CRLF document: no doubling, both edits kept', () => {
    vi.useFakeTimers();
    const { a, b, sync } = twoClients('# T\r\n\r\nalpha\r\nbeta\r\ngamma\r\n');
    expect(a.view.state.doc.toString()).toBe('# T\n\nalpha\nbeta\ngamma\n');
    typeAtEnd(a.view, 'A');
    b.view.dispatch({ changes: { from: 0, insert: 'B' }, userEvent: 'input.type' });
    sync();
    vi.advanceTimersByTime(FULL_CHECK_DELAY_MS + 10);
    sync();
    vi.advanceTimersByTime(FULL_CHECK_DELAY_MS + 10);
    sync();
    const expected = 'B# T\n\nalpha\nbeta\ngamma\nA';
    expect(normalizeEol(a.ytext.toString())).toBe(expected);
    expect(normalizeEol(b.ytext.toString())).toBe(expected);
    expect(a.view.state.doc.toString()).toBe(expected);
    expect(b.view.state.doc.toString()).toBe(expected);
  });

  it('a CRLF text arriving in a live room (an old server PUT) lands in the right place, and later edits from both sides survive', () => {
    vi.useFakeTimers();
    const { a, b, sync } = twoClients('# T\n\nend\n');
    // Peer B's Y.Text gets a CRLF paragraph inserted remotely, the way an API write used to do it.
    const injector = new Y.Doc();
    Y.applyUpdate(injector, Y.encodeStateAsUpdate(a.ytext.doc!));
    injector.getText('content').insert(5, 'one\r\ntwo\r\n\r\n');
    Y.applyUpdate(a.ytext.doc!, Y.encodeStateAsUpdate(injector, Y.encodeStateVector(a.ytext.doc!)), 'relay');
    sync();
    expect(a.view.state.doc.toString()).toBe('# T\n\none\ntwo\n\nend\n');
    expect(b.view.state.doc.toString()).toBe('# T\n\none\ntwo\n\nend\n');
    // Edits after the CRs, from both sides at once.
    b.view.dispatch({ changes: { from: b.view.state.doc.length - 4, insert: 'B ' }, userEvent: 'input.type' });
    typeAtEnd(a.view, 'A');
    sync();
    vi.advanceTimersByTime(FULL_CHECK_DELAY_MS + 10);
    sync();
    const expected = '# T\n\none\ntwo\n\nB end\nA';
    expect(a.view.state.doc.toString()).toBe(expected);
    expect(b.view.state.doc.toString()).toBe(expected);
    expect(normalizeEol(a.ytext.toString())).toBe(expected);
    expect(normalizeEol(b.ytext.toString())).toBe(expected);
  });

  it('deleting a line break never leaves half of a CRLF behind', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'one\r\ntwo\r\n');
    const { view, ytext } = mount(doc);
    // Join the two lines.
    view.dispatch({ changes: { from: 3, to: 4 }, userEvent: 'delete' });
    expect(ytext.toString()).toBe('onetwo\r\n');
  });
});
