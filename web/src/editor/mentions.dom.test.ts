// @vitest-environment jsdom
/**
 * The half of `@mentions` that only exists in a running editor: the view
 * plugin, its facet reads and the refresh that follows the fetched list.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MentionableUser } from '@shared/contracts';
import { livePreviewConfig } from './live-preview';
import { markdownEditorExtensions } from './markdown-setup';
import { clearMentionIndex } from './mention-index';
import { mentions } from './mentions';

const USERS: MentionableUser[] = [{ username: 'ann', name: 'Ann Lee' }];

function stubFetch(users: MentionableUser[] = USERS): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ users }) }) as unknown as Response),
  );
}

function mount(doc: string, space = 'eng'): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdownEditorExtensions(),
        mentions(),
        livePreviewConfig(true, { space, pagePath: 'a.md', pageId: 'P1' }),
      ],
    }),
    parent: document.body,
  });
}

/** Lets the stubbed request settle and the follow-up dispatch land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const pills = (view: EditorView): { text: string; title: string }[] =>
  [...view.dom.querySelectorAll<HTMLElement>('.folio-mention')].map((node) => ({
    text: node.textContent ?? '',
    title: node.title,
  }));

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  clearMentionIndex();
});

describe('mentions view plugin', () => {
  it('draws a pill for a known handle once the list arrives', async () => {
    stubFetch();
    view = mount('ping @ann please');
    expect(pills(view)).toEqual([]); // nothing known yet — plain text

    await settle();
    expect(pills(view)).toEqual([{ text: '@ann', title: 'Ann Lee' }]);
  });

  it('leaves unknown handles, code spans and addresses alone', async () => {
    stubFetch();
    view = mount('`@ann` and me@ann and @ghost, but @ann counts');
    await settle();
    expect(pills(view)).toEqual([{ text: '@ann', title: 'Ann Lee' }]);
  });

  it('picks up handles typed after the list was loaded', async () => {
    stubFetch();
    view = mount('start');
    await settle();

    view.dispatch({ changes: { from: 0, to: 5, insert: 'hi @ann' } });
    expect(pills(view).map((pill) => pill.text)).toEqual(['@ann']);
  });

  it('asks for nothing until it knows which space it is in', async () => {
    stubFetch();
    view = mount('@ann', '');
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(pills(view)).toEqual([]);
  });
});
