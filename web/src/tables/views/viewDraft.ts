import type { TableView } from '@shared/contracts';

/**
 * Round 26 (DATA TABLES) — the local view draft (spec §5).
 *
 * THE RULE, quoted because it is the whole reason this module exists:
 * "changes to the filter/sort/hiding are FIRST A DRAFT … The draft lives
 * locally (localStorage, keyed by user+view) and is visible to nobody
 * else — so that 'playing with a filter' does not rewrite the shared view
 * (and does not produce a commit)".
 *
 * That matters more than it first looks. A view is shared state living in a
 * git-committed file; writing to it on every filter keystroke would (a)
 * yank the table out from under everyone else looking at it, (b) produce a
 * commit per keystroke, and (c) make the "two people edit one view" race in
 * spec §6.1 a constant occurrence instead of a rare one. Drafts make the
 * common case (fiddling) purely local, and saving an explicit act.
 *
 * A viewer (role) may hold drafts but may not save them — spec §12.
 */

const STORAGE_PREFIX = 'folio:table-draft';

/** Key is per page + per view, so drafts of different views don't collide. */
export function draftKey(pageId: string, viewId: string): string {
  return `${STORAGE_PREFIX}:${pageId}:${viewId}`;
}

/**
 * Which fields a draft may differ in. Deliberately NOT the whole view:
 * a draft can't rename a view or change its icon — those are explicit,
 * immediate, shared edits, not something you "try out".
 */
export type DraftableFields = Pick<TableView, 'columns' | 'sort' | 'filter' | 'rowHeight' | 'frozen'>;

export function draftableOf(view: TableView): DraftableFields {
  return {
    columns: view.columns,
    sort: view.sort,
    filter: view.filter,
    rowHeight: view.rowHeight,
    frozen: view.frozen,
  };
}

/**
 * Structural comparison of the draftable slice.
 *
 * JSON.stringify is adequate here and not a lurking bug: every field is
 * plain JSON (arrays, records of numbers, string enums) coming from a zod
 * schema, key order is stable because both sides are built by draftableOf
 * from objects with the same construction order, and there are no dates,
 * Maps, undefined-vs-missing distinctions or cycles. A deep-equal helper
 * would be more code for the same answer.
 */
export function isDirty(base: TableView, draft: TableView): boolean {
  return JSON.stringify(draftableOf(base)) !== JSON.stringify(draftableOf(draft));
}

/**
 * Reads a persisted draft. Every failure mode — no localStorage (private
 * mode, or a browser that throws on access), malformed JSON, a draft saved
 * by an older format — degrades to "no draft", never to a thrown error:
 * a corrupt draft must not make the table unopenable.
 */
export function loadDraft(pageId: string, view: TableView): TableView | null {
  try {
    const raw = window.localStorage.getItem(draftKey(pageId, view.id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftableFields>;
    if (!parsed || typeof parsed !== 'object') return null;
    const merged: TableView = {
      ...view,
      columns: parsed.columns ?? view.columns,
      sort: parsed.sort ?? view.sort,
      filter: parsed.filter ?? view.filter,
      rowHeight: parsed.rowHeight ?? view.rowHeight,
      frozen: parsed.frozen ?? view.frozen,
    };
    // A "draft" identical to the saved view is noise — drop it so the
    // Save/Add buttons don't appear for no reason.
    return isDirty(view, merged) ? merged : null;
  } catch {
    return null;
  }
}

/** Persists (or clears) a draft. Silent on storage failure — a lost draft is not worth an error toast. */
export function saveDraft(pageId: string, base: TableView, draft: TableView | null): void {
  try {
    const key = draftKey(pageId, base.id);
    if (!draft || !isDirty(base, draft)) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(draftableOf(draft)));
  } catch {
    // Quota exceeded / storage disabled. The draft still works in memory
    // for this session, which is the part the user actually notices.
  }
}

export function clearDraft(pageId: string, viewId: string): void {
  try {
    window.localStorage.removeItem(draftKey(pageId, viewId));
  } catch {
    /* see saveDraft */
  }
}

/** A fresh view, either empty or copied from the current one ("+" → empty / copy). */
export function makeView(id: string, name: string, from?: TableView): TableView {
  if (from) {
    return {
      ...from,
      id,
      name,
      // Deep-ish copy so editing the new view can't mutate the source's
      // arrays through a shared reference.
      columns: { hidden: [...from.columns.hidden], order: [...from.columns.order], width: { ...from.columns.width } },
      sort: from.sort.map((level) => ({ ...level })),
      filter: { op: from.filter.op, rules: from.filter.rules.map((rule) => ({ ...rule })) },
    };
  }
  return {
    id,
    name,
    columns: { hidden: [], order: [], width: {} },
    sort: [],
    filter: { op: 'and', rules: [] },
    frozen: 0,
    rowHeight: 'short',
  };
}
