import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState, Text } from '@codemirror/state';
import { GFM, parser } from '@lezer/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MentionableUser } from '@shared/contracts';
import { pageContextFacet } from './live-preview';
import { clearMentionIndex, mentionName } from './mention-index';
import {
  computeMentionSpecs,
  findMentionQuery,
  findMentionTokens,
  mentionCompletions,
  mentionText,
  rankMentions,
} from './mentions';

const md = parser.configure(GFM);

/** Handles this "space" knows; everything else must stay ordinary text. */
const KNOWN: Record<string, string> = {
  ann: 'Ann Lee',
  'bob.smith': 'Bob Smith',
};
const lookup = (handle: string): string | undefined => KNOWN[handle];

function specsOf(source: string) {
  const doc = Text.of(source.split('\n'));
  return computeMentionSpecs({
    doc,
    tree: md.parse(source),
    ranges: [{ from: 0, to: doc.length }],
    lookup,
  });
}

/** What the decoration would actually cover, so offsets are checked too. */
const marked = (source: string): string[] =>
  specsOf(source).map((spec) => source.slice(spec.from, spec.to));

describe('findMentionTokens', () => {
  it('finds a handle after a space', () => {
    expect(findMentionTokens('ping @ann please')).toEqual([{ from: 5, to: 9, handle: 'ann' }]);
  });

  it('finds one at the very start of the line', () => {
    expect(findMentionTokens('@ann hi')).toEqual([{ from: 0, to: 4, handle: 'ann' }]);
  });

  it('accepts ordinary punctuation in front', () => {
    expect(findMentionTokens('(@ann)').map((token) => token.handle)).toEqual(['ann']);
    expect(findMentionTokens('«@ann»').map((token) => token.handle)).toEqual(['ann']);
    expect(findMentionTokens('hello, @ann').map((token) => token.handle)).toEqual(['ann']);
  });

  it('never fires in the middle of a word', () => {
    expect(findMentionTokens('foo@ann')).toEqual([]);
    expect(findMentionTokens('café@ann')).toEqual([]);
  });

  it('leaves e-mail addresses alone', () => {
    expect(findMentionTokens('write to ann@folio.dev')).toEqual([]);
    expect(findMentionTokens('a.b@ann')).toEqual([]);
    expect(findMentionTokens('x-1@ann')).toEqual([]);
    expect(findMentionTokens('me+tag@ann')).toEqual([]);
  });

  it('does not treat a doubled @ as a boundary', () => {
    expect(findMentionTokens('text@@ann')).toEqual([]);
  });

  it('drops sentence punctuation from the end of a handle', () => {
    expect(findMentionTokens('ask @ann.')).toEqual([{ from: 4, to: 8, handle: 'ann' }]);
    expect(findMentionTokens('@bob.smith, please')).toEqual([
      { from: 0, to: 10, handle: 'bob.smith' },
    ]);
  });

  it('lower-cases the handle for lookup while keeping the text as written', () => {
    expect(findMentionTokens('@Ann')).toEqual([{ from: 0, to: 4, handle: 'ann' }]);
  });

  it('ignores handles that cannot exist — too short or too long', () => {
    expect(findMentionTokens('@a')).toEqual([]);
    expect(findMentionTokens(`@${'x'.repeat(40)}`)).toEqual([]);
  });

  it('finds every mention on a line', () => {
    expect(findMentionTokens('@ann and @bob.smith ship it').map((t) => t.handle)).toEqual([
      'ann',
      'bob.smith',
    ]);
  });
});

describe('computeMentionSpecs', () => {
  it('decorates a known handle and reports its full name', () => {
    expect(specsOf('ping @ann please')).toEqual([
      { from: 5, to: 9, handle: 'ann', name: 'Ann Lee' },
    ]);
  });

  it('leaves an unknown handle as plain text', () => {
    expect(specsOf('ping @nobody please')).toEqual([]);
  });

  it('skips code spans', () => {
    expect(marked('install `@ann/cli` today')).toEqual([]);
  });

  it('skips fenced blocks', () => {
    expect(marked('```sh\ncurl @ann\n```\n')).toEqual([]);
  });

  it('skips indented code blocks', () => {
    expect(marked('text\n\n    @ann\n')).toEqual([]);
  });

  it('skips link destinations', () => {
    expect(marked('[docs](https://example.com/@ann)')).toEqual([]);
  });

  it('still decorates inside headings, emphasis and link labels', () => {
    expect(marked('# Owner: @ann')).toEqual(['@ann']);
    expect(marked('**@ann** owns this')).toEqual(['@ann']);
    expect(marked('[ask @ann](notes.md)')).toEqual(['@ann']);
  });

  it('keeps the word-boundary rule the token scan applies', () => {
    expect(marked('write x@ann now')).toEqual([]);
  });

  it('works across lines and reports absolute offsets', () => {
    const source = 'first @ann\nsecond @bob.smith\n';
    expect(specsOf(source).map((spec) => source.slice(spec.from, spec.to))).toEqual([
      '@ann',
      '@bob.smith',
    ]);
    expect(specsOf(source)[1].from).toBe(source.indexOf('@bob.smith'));
  });

  it('reports a mention once even when the scan ranges overlap', () => {
    const source = 'ping @ann';
    const doc = Text.of([source]);
    const specs = computeMentionSpecs({
      doc,
      tree: md.parse(source),
      ranges: [
        { from: 0, to: doc.length },
        { from: 0, to: doc.length },
      ],
      lookup,
    });
    expect(specs).toHaveLength(1);
  });
});

describe('findMentionQuery', () => {
  it('opens on a bare @', () => {
    expect(findMentionQuery('@')).toEqual({ at: 0, query: '' });
  });

  it('reports what has been typed so far', () => {
    expect(findMentionQuery('hi @an')).toEqual({ at: 3, query: 'an' });
  });

  it('opens after punctuation', () => {
    expect(findMentionQuery('see (@a')).toEqual({ at: 5, query: 'a' });
  });

  it('stays shut mid-word and inside an address', () => {
    expect(findMentionQuery('mail me@e')).toBeNull();
    expect(findMentionQuery('foo@')).toBeNull();
  });

  it('closes once the token ends', () => {
    expect(findMentionQuery('@ann bob')).toBeNull();
  });

  it('gives up on a query no handle could ever match', () => {
    expect(findMentionQuery(`@${'x'.repeat(40)}`)).toBeNull();
  });
});

describe('rankMentions', () => {
  const users: MentionableUser[] = [
    { username: 'zed', name: 'Ann Lee' },
    { username: 'ann', name: 'Zed Boy' },
    { username: 'kim', name: 'Kim Cho' },
  ];

  it('returns everyone for an empty query', () => {
    expect(rankMentions('', users)).toHaveLength(3);
  });

  it('ranks a name match above a handle-only match', () => {
    expect(rankMentions('ann', users)[0].name).toBe('Ann Lee');
  });

  it('still finds people by handle', () => {
    expect(rankMentions('ann', users).map((user) => user.username)).toContain('ann');
  });

  it('drops people who match neither', () => {
    expect(rankMentions('qqq', users)).toEqual([]);
  });

  it('honours the limit', () => {
    expect(rankMentions('', users, 2)).toHaveLength(2);
  });
});

describe('mentionText', () => {
  it('writes plain text, never a hidden syntax', () => {
    expect(mentionText({ username: 'ann' })).toBe('@ann');
  });
});

/* ------------------------------------------------------------- palette -- */

const USERS: MentionableUser[] = [
  { username: 'ann', name: 'Ann Lee' },
  { username: 'bob.smith', name: 'Bob Smith' },
];

function stubFetch(payload: unknown = { users: USERS }) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => payload } as unknown as Response;
    }),
  );
  return calls;
}

function contextAt(text: string, space = 'eng'): CompletionContext {
  const state = EditorState.create({
    doc: text,
    selection: { anchor: text.length },
    extensions: [pageContextFacet.of({ space, pagePath: 'a.md', pageId: 'P1' })],
  });
  return new CompletionContext(state, text.length, false);
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearMentionIndex();
});

describe('mentionCompletions', () => {
  it('offers the space members and writes a plain handle', async () => {
    const calls = stubFetch();
    const result = await mentionCompletions(contextAt('ping @a'));

    expect(calls).toEqual(['/api/spaces/eng/mentionable']);
    expect(result?.from).toBe(5); // the `@` itself, so a pick rewrites the token
    expect(result?.options.map((option) => option.apply)).toEqual(['@ann']);
    expect(result?.options[0].displayLabel).toBe('Ann Lee');
  });

  it('keeps the list for the session instead of refetching per keystroke', async () => {
    const calls = stubFetch();
    await mentionCompletions(contextAt('@a'));
    await mentionCompletions(contextAt('@an'));
    expect(calls).toHaveLength(1);
  });

  it('teaches the decoration lookup the handles it fetched', async () => {
    stubFetch();
    await mentionCompletions(contextAt('@a'));
    expect(mentionName('eng', 'ann')).toBe('Ann Lee');
    expect(mentionName('eng', 'ANN')).toBe('Ann Lee');
    expect(mentionName('eng', 'ghost')).toBeUndefined();
  });

  it('stays out of the way when the @ is part of an address', async () => {
    stubFetch();
    expect(await mentionCompletions(contextAt('mail me@a'))).toBeNull();
  });

  it('says nothing without a space — a share view has no member list', async () => {
    const calls = stubFetch();
    expect(await mentionCompletions(contextAt('@a', ''))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('survives an endpoint that answers with nothing usable', async () => {
    stubFetch({});
    expect(await mentionCompletions(contextAt('@a'))).toBeNull();
  });
});
