import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ImageOff, ImagePlus } from 'lucide-react';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import '../i18n/register';

export interface PageChromeProps {
  pageId: string;
  space: string;
  icon?: string;
  cover?: string;
  canEdit: boolean;
  /** Hosted inline in the editor's chrome row (cover-less pages): tighter spacing, smaller icon. */
  compact?: boolean;
  /**
   * A board (this round) has an icon but no cover concept — SERVER's board
   * PUT branch only understands `order`/`icon`, never `cover` (see
   * server/routes.ts's board branch of PUT /api/pages/:id), so offering the
   * "add cover"/upload control here would build toward a 400. Default true —
   * every existing (doc) caller is unaffected.
   */
  allowCover?: boolean;
}

/**
 * Round 5 icon/cover banner, rendered above the editor (see PageContent.tsx)
 * as a plain React element rather than baked into markdown/'s rendering
 * pipeline (the way e.g. collapsible sections are): the cover needs a real
 * file upload and interactive hover controls with mutations attached, which
 * a sanitized-HTML string can't easily carry real React event handlers for.
 *
 * Written via PUT { icon, cover } directly (updatePageBodySchema, round-5
 * follow-up) — string sets, null clears, an absent field leaves it
 * untouched; SERVER resolves precedence over any frontmatter. No more
 * client-side frontmatter manipulation here (dropped app/frontmatter.ts's
 * upsert/removeFrontmatterField — nothing else used them, so that module and
 * its test were deleted rather than kept unused).
 *
 * This does mean the icon shown here is visually separate from the page's
 * own title (the first H1 *inside* the body — see contracts.ts's PageMeta
 * comment: "title = first H1 of the body, NOT frontmatter"), rather than
 * sitting inline with it. A deliberate, documented scope choice for this
 * round (noted in the report) — not a restructuring of how titles work.
 *
 * Renders nothing for a viewer on a page with neither an icon nor a cover
 * — zero visual footprint until something is actually set.
 */
export function PageChrome({ pageId, space, icon, cover, canEdit, compact, allowCover = true }: PageChromeProps) {
  const { t } = useTranslation('app');
  const errorText = useApiErrorText();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hoveringCover, setHoveringCover] = useState(false);

  // Optimistic local override: even with the direct PUT { icon, cover }
  // fields, a save is still a round trip — the `icon`/`cover` props below
  // only reflect the change once the mutation resolves and the resulting
  // refetch lands. Without this, picking an icon would look like it
  // silently did nothing for that gap. `undefined` = no override (show the
  // real prop); `null` = optimistically cleared; a string = optimistically
  // set. Reset on pageId change since PageChrome isn't remounted across a
  // same-space page navigation (no `key` on it in PageContent.tsx) — without
  // this, Page A's optimistic pick would incorrectly bleed into Page B.
  const [optimisticCover, setOptimisticCover] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setOptimisticCover(undefined);
  }, [pageId]);
  const displayCover = optimisticCover !== undefined ? (optimisticCover ?? undefined) : cover;

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['page', pageId] });
    queryClient.invalidateQueries({ queryKey: ['tree', space] });
  }

  /** icon/cover: string sets, null clears, an omitted key is left untouched — matches updatePageBodySchema exactly, one field at a time here. */
  const save = useMutation({
    mutationFn: (body: { icon?: string | null; cover?: string | null }) => api.updatePage(pageId, body),
    onSuccess: invalidate,
    onError: (err) => showToast(errorText(err, 'pageChrome.saveFailed')),
  });

  const uploadCover = useMutation({
    mutationFn: (file: File) => api.uploadAsset(space, file),
    onSuccess: (result) => {
      setOptimisticCover(result.url);
      save.mutate({ cover: result.url });
    },
    onError: (err) => showToast(errorText(err, 'pageChrome.uploadFailed')),
  });

  if (!allowCover || (!canEdit && !displayCover)) return null;

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again later (e.g. re-uploading after a revert)
    if (file) uploadCover.mutate(file);
  }

  const busy = save.isPending || uploadCover.isPending;

  return (
    <div className={compact ? undefined : 'mb-1'}>
      {allowCover && canEdit && <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />}

      {allowCover && displayCover && (
        <div
          className="group relative mb-2 h-40 w-full overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800 sm:h-52"
          onMouseEnter={() => setHoveringCover(true)}
          onMouseLeave={() => setHoveringCover(false)}
        >
          {/* eslint-disable-next-line jsx-a11y/img-redundant-alt -- decorative banner, real title is the body's own H1 */}
          <img src={displayCover} alt="" className="h-full w-full object-cover" />
          {canEdit && (hoveringCover || busy) && (
            <div className="absolute inset-0 flex items-end justify-end gap-1.5 bg-black/10 p-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-xs font-medium text-neutral-800 shadow hover:bg-white disabled:opacity-50"
              >
                <ImagePlus size={13} aria-hidden="true" /> {t('pageChrome.change')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setOptimisticCover(null);
                  save.mutate({ cover: null });
                }}
                className="flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-xs font-medium text-neutral-800 shadow hover:bg-white disabled:opacity-50"
              >
                <ImageOff size={13} aria-hidden="true" /> {t('pageChrome.remove')}
              </button>
            </div>
          )}
        </div>
      )}

      {allowCover && canEdit && !displayCover && (
        <div className={`flex items-center gap-2 ${compact ? '' : 'mb-1'}`}>
          {allowCover && canEdit && !displayCover && (
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              <ImagePlus size={13} aria-hidden="true" /> {t('pageChrome.addCover')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
