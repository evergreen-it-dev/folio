import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Link2, Share2, Trash2 } from 'lucide-react';
import type { ShareLinkInfo, ShareLinkMode } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useToast } from '../ui/Toast';
import { Menu } from '../ui/Menu';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import '../i18n/register';

export interface ShareButtonProps {
  pageId: string;
}

/**
 * Best-effort clipboard write, as a promise that NEVER rejects — it resolves
 * to whether the text actually made it.
 *
 * Two distinct failure modes, and only one of them was previously handled:
 * `writeText()` can REJECT (permission denied), but on a non-secure origin
 * (plain http://, which a self-hosted Folio may well be) `navigator.clipboard`
 * is `undefined` outright, so `navigator.clipboard.writeText(...)` THROWS
 * synchronously — a `.catch()` on the call never even gets attached. Both are
 * funneled here so every copy affordance in this popover degrades the same
 * way: the link stays visible and selectable in the list either way.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The popover body. Exists as its own component purely so the fetch can hang
 * off a mount effect: `Menu` only calls its children render-prop while the
 * panel is open, so opening the popover is what triggers the request.
 */
function SharePanel({ onOpen, children }: { onOpen: () => Promise<void>; children: ReactNode }) {
  useEffect(() => {
    void onOpen();
  }, [onOpen]);
  return <div className="w-72 p-1">{children}</div>;
}

/**
 * "Share" (round 8). GET/POST /api/pages/:id/shares and DELETE
 * /api/shares/:id are landing on SERVER's side in parallel — built against
 * the contract (ShareLinkInfo/createShareLinkBodySchema), degrading on a
 * 404 by hiding the button entirely (not just the popover contents) —
 * there's nothing useful to click if the feature isn't live yet, and a
 * button that opens to an error is worse than no button.
 */
export function ShareButton({ pageId }: ShareButtonProps) {
  const { t } = useTranslation('app');
  const showToast = useToast();
  const errorText = useApiErrorText();
  const [revoking, setRevoking] = useState<ShareLinkInfo | null>(null);
  const [links, setLinks] = useState<readonly ShareLinkInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creatingMode, setCreatingMode] = useState<ShareLinkMode | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  /**
   * Scope for the very first link creation. Existing links have their own
   * live PATCH-backed checkbox below; keeping this global creation-only
   * control visible beside an existing link made it look as though that
   * link had been widened when only the next link would inherit the value.
   */
  const [includeChildren, setIncludeChildren] = useState(false);
  /**
   * Round 23 tail (the owner's feedback): "for an agent" is NOT a separate
   * button but a display mode of the link, in one row with "Include child
   * pages". The essential difference between the two checkboxes:
   * includeChildren is frozen into the token at creation and immutable
   * afterwards, while this one is purely presentational and applies to
   * already created links too, because mdUrl is the very same token, just
   * another route.
   */
  const [asMarkdown, setAsMarkdown] = useState(false);

  /**
   * Deliberately plain fetch-into-state instead of react-query, and it only
   * runs while the popover is open (SharePanel's mount).
   *
   * Round 25 QA, measured on prod: on BOARD pages the react-query version sat
   * in `fetchStatus: 'fetching'` forever — the network request completed 200,
   * a sibling cache entry for the very same key held the data, yet the
   * component's own hook state never left `pending`, so the popover showed
   * "Loading…" for good. Its observer stops receiving updates on board
   * pages (the one place that mounts a lazy Suspense boundary next to the
   * header), and neither `retry` nor `enabled` touches that: nothing rejects,
   * the subscription is simply dead. Owning the request here sidesteps the
   * whole mechanism, and the data is a two-item list fetched on demand — it
   * never needed a cache to begin with.
   */
  const load = useCallback(async () => {
    if (!pageId) return;
    setFailed(false);
    try {
      const res = await api.getPageShares(pageId);
      setLinks(res.shares);
    } catch {
      setFailed(true);
      setLinks([]);
    }
  }, [pageId]);

  async function createLink(mode: ShareLinkMode) {
    setCreatingMode(mode);
    try {
      const link = await api.createShareLink(pageId, { mode, includeChildren });
      await load();
      // Best-effort AND deliberately not awaited — clipboard access can be
      // denied (permissions, non-secure context) or sit behind a permission
      // prompt, and neither may hold the "Creating…" state open: the link is
      // created and visible in the list regardless of how the copy goes.
      void copyText(link.url).then((copied) =>
        showToast(copied ? t('share.linkCopied') : t('share.linkCreatedNoCopy'), copied ? 'info' : 'error'),
      );
    } catch (err) {
      showToast(errorText(err, 'share.createFailed'));
    } finally {
      setCreatingMode(null);
    }
  }

  /** Copies what is shown now: the ordinary link or its .md variant (the same token, GET /share/:token.md). */
  async function copyPageLink(link: ShareLinkInfo) {
    const copied = await copyText(asMarkdown ? link.mdUrl : link.url);
    if (asMarkdown) {
      showToast(copied ? t('share.mdCopied') : t('share.mdCopyFailed'), copied ? 'info' : 'error');
      return;
    }
    showToast(copied ? t('share.linkCopied') : t('share.copyFailed'), copied ? 'info' : 'error');
  }

  const [scopeBusy, setScopeBusy] = useState<string | null>(null);

  /** Flips includeChildren on a LIVE link (PATCH /api/shares/:id) — see ShareSection's comment for why this stopped being read-only. */
  async function changeScope(link: ShareLinkInfo, includeChildren: boolean) {
    setScopeBusy(link.id);
    try {
      const res = await api.updateShareLink(link.id, { includeChildren });
      setLinks(res.shares);
    } catch (err) {
      showToast(errorText(err, 'share.createFailed'));
    } finally {
      setScopeBusy(null);
    }
  }

  async function revokeLink(id: string) {
    setRevokeBusy(true);
    try {
      await api.revokeShareLink(id);
      setRevoking(null);
      await load();
    } catch (err) {
      showToast(errorText(err, 'share.revokeFailed'));
    } finally {
      setRevokeBusy(false);
    }
  }

  const byMode = (mode: ShareLinkMode) => links?.find((s) => s.mode === mode);

  return (
    <>
      <Menu triggerLabel={t('share.button')} trigger={<Share2 size={15} aria-hidden="true" />}>
        {() => (
          <SharePanel onOpen={load}>
            {failed ? (
              <p className="px-1.5 py-2 text-xs text-neutral-400">{t('share.createFailed')}</p>
            ) : (
              <>
                {(['view', 'edit'] as const).map((mode) => (
                  <ShareSection
                    key={mode}
                    mode={mode}
                    link={byMode(mode)}
                    loading={links === null}
                    creating={creatingMode === mode}
                    onCreate={() => void createLink(mode)}
                    onRevoke={(link) => setRevoking(link)}
                    onCopyLink={(link) => void copyPageLink(link)}
                    onScopeChange={(link, next) => void changeScope(link, next)}
                    busy={scopeBusy !== null}
                    asMarkdown={asMarkdown}
                  />
                ))}

                {/* "For an agent" is a display mode, not a creation option:
                    the link already exists, mdUrl is the same token by
                    another route. So it appears as soon as there is AT LEAST
                    ONE link (unlike the neighboring checkbox below), and
                    stays available after both have been created. */}
                {links !== null && (byMode('view') || byMode('edit')) && (
                  <label className="mt-1 flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={asMarkdown}
                      onChange={(e) => setAsMarkdown(e.target.checked)}
                    />
                    <span>
                      {t('share.asMarkdown')}
                      <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                        {t('share.asMarkdownHint')}
                      </span>
                    </span>
                  </label>
                )}

                {/* Creation-only scope is shown only before the FIRST link.
                    Once any link exists, its own PATCH-backed checkbox is the
                    single unambiguous scope control. A second link can be
                    created narrow and widened immediately from its own row. */}
                {links !== null && !byMode('view') && !byMode('edit') && (
                  <label className="mt-1 flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={includeChildren}
                      disabled={creatingMode !== null}
                      onChange={(e) => setIncludeChildren(e.target.checked)}
                    />
                    <span>
                      {t('share.includeChildren')}
                      {/* One flag, two effects — the caption has to carry both,
                          because which one matters depends on who opens the link. */}
                      <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
                        {t('share.includeChildrenHint')}
                      </span>
                    </span>
                  </label>
                )}
              </>
            )}
          </SharePanel>
        )}
      </Menu>

      {revoking && (
        <ConfirmDialog
          title={t('share.revokeConfirmTitle')}
          destructive
          confirmLabel={t('ui.revoke')}
          busy={revokeBusy}
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revokeLink(revoking.id)}
        >
          {t('share.revokeConfirmBody', { mode: t(`share.mode.${revoking.mode}`) })}
        </ConfirmDialog>
      )}
    </>
  );
}

interface ShareSectionProps {
  mode: ShareLinkMode;
  link: ShareLinkInfo | undefined;
  loading: boolean;
  creating: boolean;
  onCreate: () => void;
  onRevoke: (link: ShareLinkInfo) => void;
  onCopyLink: (link: ShareLinkInfo) => void;
  onScopeChange: (link: ShareLinkInfo, includeChildren: boolean) => void;
  busy: boolean;
  asMarkdown: boolean;
}

function ShareSection({ mode, link, loading, creating, onCreate, onRevoke, onCopyLink, onScopeChange, busy, asMarkdown }: ShareSectionProps) {
  const { t } = useTranslation('app');
  return (
    <div className="mb-1 last:mb-0">
      <div className="px-1.5 pb-1 pt-1.5 text-xs font-medium text-neutral-400 dark:text-neutral-500">
        {t(`share.mode.${mode}`)}
      </div>
      {loading ? (
        <p className="px-1.5 py-1 text-xs text-neutral-400">{t('ui.loading')}</p>
      ) : link ? (
        <>
          <div className="flex items-center gap-1 px-1.5 py-1">
            {/* Round 19 QA fix (#1-client): link.url is the server's
                normalized, absolute https URL as-is — no client prefix built
                here. Was a plain <span>; a real <a> (target=_blank — this is
                the *creator's* own tab, and /share/:token renders OUTSIDE
                AuthProvider entirely, so following it in place would swap this
                tab over to the guest experience) makes it actually clickable
                and, with the scheme visible plus the underline, look it too. */}
            <a
              href={asMarkdown ? link.mdUrl : link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={asMarkdown ? link.mdUrl : link.url}
              className="min-w-0 flex-1 truncate rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-700 underline decoration-dotted underline-offset-2 hover:text-neutral-900 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-100"
            >
              {asMarkdown ? link.mdUrl : link.url}
            </a>
            <button
              type="button"
              title={t('share.copyLink')}
              aria-label={t('share.copyLink')}
              onClick={() => onCopyLink(link)}
              className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <Copy size={13} />
            </button>
            <button
              type="button"
              title={t('share.revokeLink')}
              aria-label={t('share.revokeLink')}
              onClick={() => onRevoke(link)}
              className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
            >
              <Trash2 size={13} />
            </button>
          </div>
          {/* What this token actually grants — and now a CONTROL, not a caption.
              It used to be read-only ("fixed at creation"), which made the
              creation checkbox below a trap: it sits under an already-created
              link, so ticking it read as "apply to this link" while it only
              affected the next one created. The owner hit exactly that.

              The label names what the BOX does and never changes. It used to
              describe the current state instead — an unticked box captioned
              «This page only» — which reads as "not only this page"; the owner
              (01.10.2026) shared a board that way and its child page was
              nowhere to be seen through the link. */}
          <label className="flex cursor-pointer items-start gap-2 px-1.5 pb-1 text-[11px] leading-snug text-neutral-400 dark:text-neutral-500">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={link.includeChildren}
              disabled={busy}
              onChange={(e) => onScopeChange(link, e.target.checked)}
            />
            <span>{t('share.includeChildren')}</span>
          </label>
        </>
      ) : (
        <button
          type="button"
          disabled={creating}
          onClick={onCreate}
          className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <Link2 size={14} aria-hidden="true" />
          {creating ? t('share.creating') : t('share.createLink')}
        </button>
      )}
    </div>
  );
}
