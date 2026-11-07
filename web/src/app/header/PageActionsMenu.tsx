import { useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Check, ClipboardList, Columns2, Download, ExternalLink, History, Lock, LockOpen, MoreHorizontal, RefreshCw, Share2, SpellCheck, Star, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { Menu } from '../ui/Menu';
import { useCompare } from '../compare/compareContext';
import { isStarred, useStars, useToggleStar } from '../stars';
import { FILE_PAGE_ACCEPT, useReplaceFilePage } from '../files/useReplaceFilePage';
import { unlockAudio } from '../timer/chime';
import { usePageAccess } from './PageAccessButton';
import { useCreateFormFromTable } from './CreateFormButton';
import { useHasWritingRules, useWritingRulesCheck } from './WritingRulesButton';
import '../i18n/register';

/** The surfaces a row of the «⋯» menu opens. Header owns which one is open — see Header.tsx. */
export type HeaderSurface = 'history' | 'export' | 'access' | 'timer' | 'share';

/** The header's icon-button look: 28×28 (p-1.5 + a 15–16px icon); a 40px touch target below md. */
export const HEADER_ICON_BUTTON =
  'inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 max-md:min-h-10 max-md:min-w-10 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

const ROW =
  'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] max-md:h-10 text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

export interface PageActionsMenuProps {
  space: string;
  /** The server page — absent on a folder listing (only the space's timer is left then). */
  pageId?: string;
  pagePath?: string;
  title?: string;
  isTable: boolean;
  /** A pdf/office page: its file actions replace Export. */
  fileActions: boolean;
  isProse: boolean;
  canEdit: boolean;
  /** No timer runs and this person may start one. */
  canStartTimer: boolean;
  /** Opens one of the header's surfaces. The row has already closed this menu. */
  onOpen: (surface: HeaderSurface) => void;
  /** The «⋯» button's wrapper — where Export, Share and the timer are placed from when opened here. */
  anchorRef: RefObject<HTMLDivElement | null>;
}

/**
 * The header's «⋯» (07.11.2026, the owner: «the header is still overloaded»):
 * every page action that is not used every minute, as a labelled vertical
 * menu — at every width, one implementation.
 *
 * Every row is a plain action: it closes this menu and either acts at once
 * (compare, create a form, writing rules, star) or asks Header to open a
 * surface (history, export, access, timer, share). Those surfaces are owned by
 * Header, not by the rows — this menu renders its rows only while it is open,
 * so anything a row mounted itself would die with the menu: the old <md menu
 * held HistoryButton & co. inside it, and their panels vanished on the first
 * click inside them (the outside click closed the menu and unmounted them).
 *
 * The one thing a row needs that must outlive the menu — the hidden file input
 * of «Replace with new version…», whose change event arrives after the picker
 * closes — lives here, outside the render prop, where it stays mounted.
 */
export function PageActionsMenu(props: PageActionsMenuProps) {
  const { t } = useTranslation('app');
  const { pageId, anchorRef } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  // Here, not in its row: the row unmounts when the menu closes, and the
  // navigation to the new form happens after the request settles.
  const createForm = useCreateFormFromTable(pageId ?? '', props.space);
  return (
    <div ref={anchorRef} className="shrink-0" data-tour="page-actions">
      <Menu
        triggerLabel={t('header.moreActions')}
        align="right"
        trigger={<MoreHorizontal size={16} aria-hidden="true" />}
        triggerClassName={HEADER_ICON_BUTTON}
      >
        {(close) => (
          <div className="min-w-[220px]">
            <Rows {...props} close={close} onReplaceFile={() => inputRef.current?.click()} onCreateForm={() => createForm.mutate()} creatingForm={createForm.isPending} />
          </div>
        )}
      </Menu>
      {pageId && props.fileActions && props.canEdit && <ReplaceFileInput space={props.space} pageId={pageId} inputRef={inputRef} />}
    </div>
  );
}

function ReplaceFileInput({ space, pageId, inputRef }: { space: string; pageId: string; inputRef: RefObject<HTMLInputElement | null> }) {
  const replaceFile = useReplaceFilePage(space, pageId);
  return (
    <input
      ref={inputRef}
      type="file"
      accept={FILE_PAGE_ACCEPT}
      className="hidden"
      data-testid="replace-file-input"
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) replaceFile.mutate(file);
      }}
    />
  );
}

function Rows({ space, pageId, pagePath, title, isTable, fileActions, isProse, canEdit, canStartTimer, onOpen, close, onReplaceFile, onCreateForm, creatingForm }: PageActionsMenuProps & { close: () => void; onReplaceFile: () => void; onCreateForm: () => void; creatingForm: boolean }) {
  const { t } = useTranslation('app');
  const open = (surface: HeaderSurface) => () => {
    close();
    onOpen(surface);
  };
  return (
    <>
      {pageId && (
        <>
          {/* Below md, Share and the page star live here; at md+ they are in the header itself. */}
          {canEdit && <Row className="md:hidden" icon={<Share2 size={15} />} label={t('share.button')} onSelect={open('share')} />}
          <StarRow pageId={pageId} close={close} />
          {pagePath !== undefined && <Row className="md:hidden" icon={<History size={15} />} label={t('header.actions.history')} onSelect={open('history')} />}
          {!fileActions && <Row icon={<Download size={15} />} label={t('header.actions.export')} onSelect={open('export')} />}
          <AccessRow pageId={pageId} onSelect={open('access')} />
          {title !== undefined && <CompareRow pageId={pageId} space={space} title={title} close={close} />}
          {((canEdit && isTable) || fileActions) && <Separator />}
          {title !== undefined && isProse && <WritingRulesRow pageId={pageId} space={space} title={title} close={close} />}
          {canEdit && isTable && (
            <Row
              icon={<ClipboardList size={15} />}
              label={t('routes.form.createFromTable')}
              disabled={creatingForm}
              onSelect={() => {
                close();
                onCreateForm();
              }}
            />
          )}
          {fileActions && (
            <>
              <LinkRow href={api.pageFileUrl(pageId)} newTab icon={<ExternalLink size={15} />} label={t('routes.pdf.openInNewTab')} close={close} />
              <LinkRow href={api.pageFileUrl(pageId, true)} icon={<Download size={15} />} label={t('routes.pdf.download')} close={close} />
              {canEdit && (
                <Row
                  icon={<RefreshCw size={15} />}
                  label={t('files.replace.action')}
                  onSelect={() => {
                    close();
                    onReplaceFile();
                  }}
                />
              )}
            </>
          )}
        </>
      )}
      {canStartTimer && (
        <Row
          className="md:hidden"
          icon={<Timer size={15} />}
          label={t('header.actions.timer')}
          title={pageId ? t('timer.buttonTitle') : t('timer.buttonTitleSpace')}
          onSelect={() => {
            // A user gesture: the chime at 00:00 needs the audio unlocked by one.
            void unlockAudio();
            open('timer')();
          }}
        />
      )}
    </>
  );
}

interface RowProps {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  title?: string;
  disabled?: boolean;
  /** Set for a toggle row (compare): shown as a check at the row's end. */
  checked?: boolean;
  active?: boolean;
  className?: string;
}

function Row({ icon, label, onSelect, title, disabled, checked, active, className }: RowProps) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      // aria-disabled, not disabled: the reason stays readable in the tooltip and to a screen reader.
      aria-disabled={disabled || undefined}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onSelect();
      }}
      className={`${ROW} ${disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : ''} ${className ?? ''}`}
    >
      <span aria-hidden="true" className={`flex shrink-0 ${active ? '' : 'text-neutral-500 dark:text-neutral-400'}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check size={14} aria-hidden="true" className="shrink-0 text-blue-600 dark:text-blue-400" />}
    </button>
  );
}

function LinkRow({ href, newTab, icon, label, close }: { href: string; newTab?: boolean; icon: ReactNode; label: string; close: () => void }) {
  return (
    <a
      href={href}
      role="menuitem"
      {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onClick={(e) => {
        e.stopPropagation();
        close();
      }}
      className={ROW}
    >
      <span aria-hidden="true" className="flex shrink-0 text-neutral-500 dark:text-neutral-400">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </a>
  );
}

function StarRow({ pageId, close }: { pageId: string; close: () => void }) {
  const { t } = useTranslation('app');
  const { data: stars } = useStars();
  const toggle = useToggleStar();
  const starred = isStarred(stars, 'page', pageId);
  const label = t(starred ? 'star.remove' : 'star.add', { noun: t('star.noun.page') });
  return (
    <Row
      className="md:hidden"
      active={starred}
      icon={<Star size={15} className={starred ? 'fill-current text-amber-500' : undefined} />}
      label={label}
      onSelect={() => {
        close();
        toggle.mutate({ kind: 'page', id: pageId, starred: !starred });
      }}
    />
  );
}

function AccessRow({ pageId, onSelect }: { pageId: string; onSelect: () => void }) {
  const { t } = useTranslation('app');
  const { restricted, locked } = usePageAccess(pageId);
  return (
    <Row
      icon={locked ? <Lock size={15} /> : <LockOpen size={15} />}
      label={t('header.actions.access')}
      title={restricted ? t('pageAccess.restricted') : locked ? t('pageAccess.restrictedByParent') : t('pageAccess.spaceWide')}
      onSelect={onSelect}
    />
  );
}

function CompareRow({ pageId, space, title, close }: { pageId: string; space: string; title: string; close: () => void }) {
  const { t } = useTranslation('app');
  const compare = useCompare();
  const inList = compare.has({ pageId });
  return (
    <Row
      checked={inList}
      active={inList}
      icon={<Columns2 size={15} className={inList ? 'text-blue-600 dark:text-blue-400' : undefined} />}
      label={t('compare.add')}
      title={t(inList ? 'compare.remove' : 'compare.add')}
      onSelect={() => {
        close();
        if (inList) compare.remove({ pageId });
        else compare.add({ pageId, space, title });
      }}
    />
  );
}

function WritingRulesRow(props: { pageId: string; space: string; title: string; close: () => void }) {
  // The assistant context is only needed where the space has rules (WritingRulesButton.tsx).
  return useHasWritingRules(props.space) ? <WritingRulesAction {...props} /> : null;
}

function WritingRulesAction({ pageId, space, title, close }: { pageId: string; space: string; title: string; close: () => void }) {
  const { label, unavailable, start } = useWritingRulesCheck({ pageId, space, title });
  return (
    <>
    <Separator />
    <Row
      icon={<SpellCheck size={15} />}
      label={label}
      disabled={unavailable !== null}
      title={unavailable ? `${label} — ${unavailable}` : label}
      onSelect={() => {
        close();
        start();
      }}
    />
    </>
  );
}

/** Splits the everyday rows from the occasional ones — at md+ only (below md the menu is one list). */
function Separator() {
  return <div role="separator" className="my-1 h-px bg-neutral-200 max-md:hidden dark:bg-neutral-800" />;
}
