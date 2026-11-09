// @vitest-environment jsdom
/**
 * The comments panel against a mocked fetch: each control must call the right
 * endpoint of the contract (shared/comments.ts) with the right body.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { CommentThread } from '@shared/comments';
import { CommentsPanel, type CommentsPanelProps } from './CommentsPanel';
import { useCommentActions } from './usePageComments';
import '../i18n/register';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

const author = (id: string, name: string) => ({ id, name, username: name.toLowerCase() });
const at = new Date(Date.now() - 5 * 60_000).toISOString();

function thread(id: string, over: Partial<CommentThread> = {}): CommentThread {
  return {
    id,
    pageId: 'p1',
    anchorFrom: 'a',
    anchorTo: 'b',
    quotedText: `quote of ${id}`,
    target: null,
    status: 'open',
    createdBy: author('me', 'Me'),
    createdAt: at,
    resolvedBy: null,
    resolvedAt: null,
    comments: [
      { id: `${id}-c1`, threadId: id, author: author('me', 'Me'), body: 'First line\nsecond line, ping @ann', createdAt: at, editedAt: null },
      { id: `${id}-c2`, threadId: id, author: author('ann', 'Ann'), body: 'A reply', createdAt: at, editedAt: null },
    ],
    ...over,
  };
}

let calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
      return { ok: true, status: 204, statusText: '', json: async () => ({}) } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness(props: Partial<CommentsPanelProps>) {
  const actions = useCommentActions('p1', null);
  return (
    <CommentsPanel
      openThreads={[thread('t1')]}
      resolvedThreads={[]}
      anchors={new Map()}
      draft={null}
      meId="me"
      canComment
      canModerate={false}
      activeId={null}
      focus={null}
      actions={actions}
      onHover={() => {}}
      onSelect={() => {}}
      onDraftDone={() => {}}
      onClose={() => {}}
      {...props}
    />
  );
}

const mount = (props: Partial<CommentsPanelProps> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness {...props} />
    </QueryClientProvider>,
  );

describe('CommentsPanel', () => {
  it('marks itself so the floating outline button can step aside (styles.css)', () => {
    mount();
    expect(document.querySelector('aside[data-comments-panel]')).not.toBeNull();
  });

  it('shows the quote, the comments as plain text and styles @mentions', () => {
    mount();
    expect(screen.getByText('quote of t1')).toBeTruthy();
    expect(screen.getByText('A reply')).toBeTruthy();
    const mention = screen.getByText('@ann');
    expect(mention.tagName).toBe('SPAN');
    expect(mention.closest('p')?.textContent).toBe('First line\nsecond line, ping @ann');
  });

  it('a board thread names its element, says so when the element was deleted, and a draft posts a target', async () => {
    const onBoard = thread('b1', { quotedText: null, anchorFrom: null, anchorTo: null, target: { kind: 'board_element', elementId: 'e1', label: 'Checkout box' } });
    const gone = { id: 'b1', state: 'detached' as const, from: 0, to: 0 };
    mount({ openThreads: [onBoard], anchors: new Map([['b1', gone]]) });
    expect(screen.getByText('Checkout box')).toBeTruthy();
    expect(screen.getByText('The commented element was deleted')).toBeTruthy();
    cleanup();

    mount({ openThreads: [], draft: { target: { kind: 'board_element', elementId: 'e2' }, preview: 'Login box' } });
    expect(screen.getByText('Login box')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment…' }), { target: { value: 'Needs a retry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/pages/p1/comments', body: { target: { kind: 'board_element', elementId: 'e2' }, body: 'Needs a retry' } });
  });

  it('a table thread names its cell, says so when its row or column was deleted, and a draft posts a cell target', async () => {
    const onCell = thread('c1', { quotedText: null, anchorFrom: null, anchorTo: null, target: { kind: 'table_cell', rowId: 'r1', columnId: 'owner', label: 'alice' } });
    const gone = { id: 'c1', state: 'detached' as const, from: 0, to: 0 };
    mount({ openThreads: [onCell], anchors: new Map([['c1', gone]]) });
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('The row or column of the commented cell was deleted')).toBeTruthy();
    cleanup();

    mount({ openThreads: [], draft: { target: { kind: 'table_cell', rowId: 'r2', columnId: 'week' }, preview: 'W8' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment…' }), { target: { value: 'Check the week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ body: { target: { kind: 'table_cell', rowId: 'r2', columnId: 'week' }, body: 'Check the week' } });
  });

  it('posts a reply to the thread', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reply…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply…' }), { target: { value: '  Thanks!  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls[0]).toEqual({ url: '/api/comment-threads/t1/comments', method: 'POST', body: { body: 'Thanks!' } });
  });

  it('sends with Ctrl+Enter', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reply…' }));
    const field = screen.getByRole('textbox', { name: 'Reply…' });
    fireEvent.change(field, { target: { value: 'quick' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toMatchObject({ url: '/api/comment-threads/t1/comments', body: { body: 'quick' } });
  });

  it('resolves a thread its creator opened', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toEqual({ url: '/api/comment-threads/t1', method: 'PATCH', body: { status: 'resolved' } });
  });

  it("does not offer Resolve on someone else's thread to a non-moderator, but does to a moderator", () => {
    const theirs = thread('t2', { createdBy: author('ann', 'Ann') });
    mount({ openThreads: [theirs] });
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    cleanup();
    mount({ openThreads: [theirs], canModerate: true });
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });

  it('keeps resolved threads behind the toggle and reopens one', async () => {
    mount({ openThreads: [], resolvedThreads: [thread('t3', { status: 'resolved', resolvedBy: author('me', 'Me') })] });
    expect(screen.queryByText('quote of t3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show resolved (1)' }));
    expect(screen.getByText('quote of t3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toEqual({ url: '/api/comment-threads/t3', method: 'PATCH', body: { status: 'open' } });
  });

  it('deletes one of my replies straight away from the comment menu', async () => {
    const mine = thread('t4');
    mine.comments[1] = { ...mine.comments[1], author: author('me', 'Me') };
    mount({ openThreads: [mine] });
    const item = document.querySelector('[data-comment-id="t4-c2"]') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: 'Comment actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toEqual({ url: '/api/comments/t4-c2', method: 'DELETE', body: undefined });
  });

  it('asks before deleting the opening comment (it takes the thread with it)', async () => {
    mount();
    const item = document.querySelector('[data-comment-id="t1-c1"]') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: 'Comment actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toMatchObject({ url: '/api/comments/t1-c1', method: 'DELETE' });
  });

  it('a read-only commenter-less viewer gets no reply box and no menu on others\' comments', () => {
    mount({ canComment: false, meId: 'someone' });
    expect(screen.queryByRole('button', { name: 'Reply…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment actions' })).toBeNull();
  });

  it('creates a thread from the draft with its anchors', async () => {
    mount({ openThreads: [], draft: { anchorFrom: 'AAA', anchorTo: 'BBB', quotedText: 'picked words' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment…' }), { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toEqual({ url: '/api/pages/p1/comments', method: 'POST', body: { anchorFrom: 'AAA', anchorTo: 'BBB', quotedText: 'picked words', body: 'Why?' } });
  });

  it('labels a thread whose text is gone', () => {
    mount({ anchors: new Map([['t1', { id: 't1', state: 'detached', from: 0, to: 0 }]]) });
    expect(screen.getByText('The commented text was deleted')).toBeTruthy();
  });
});
