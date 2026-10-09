import { api } from '../api';

export interface PdfViewProps {
  pageId: string;
  title: string;
  /** The page's updatedAt: a replaced file has a new one, which changes the url and so reloads the frame instead of showing a cached copy. */
  version?: string;
}

/**
 * Read-only pdf page view. No editor, no live-edit toggle, no outline/notes
 * panel — a pdf is content Folio streams from the repo, never edits (see
 * server/storage.ts's "PDF pages").
 *
 * Just the file, full height: «open in a new tab» and «download» live in the
 * page header next to history/share (Header.tsx, kind === 'pdf'), where the
 * other page actions already are — a separate toolbar row here only ate
 * vertical space (owner, 15.09).
 *
 * The <iframe> (not <object>: Safari/iOS render an <object type="application/
 * pdf"> as a blank box with no fallback UI at all, while an <iframe> gets the
 * platform's own pdf viewer chrome) points at GET /api/pages/:id/file — the
 * same url the header's actions use.
 */
export function PdfView({ pageId, title, version }: PdfViewProps) {
  return (
    <div className="h-full bg-neutral-100 dark:bg-neutral-950">
      <iframe src={api.pageFileUrl(pageId, false, version)} title={title} className="h-full w-full border-0 bg-white" />
    </div>
  );
}
