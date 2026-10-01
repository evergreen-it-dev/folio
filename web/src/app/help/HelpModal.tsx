import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import '../i18n/register';

/** Static content, owner-specified verbatim (round 6 addendum: "Tips"). Trigger key, then description key. */
const SHORTCUT_KEYS: ReadonlyArray<readonly [triggerKey: string, descKey: string]> = [
  ['help.shortcuts.slash.trigger', 'help.shortcuts.slash.desc'],
  ['help.shortcuts.pageLink.trigger', 'help.shortcuts.pageLink.desc'],
  ['help.shortcuts.emojiPicker.trigger', 'help.shortcuts.emojiPicker.desc'],
  ['help.shortcuts.emojiName.trigger', 'help.shortcuts.emojiName.desc'],
  ['help.shortcuts.quickSwitcher.trigger', 'help.shortcuts.quickSwitcher.desc'],
  ['help.shortcuts.pageSearch.trigger', 'help.shortcuts.pageSearch.desc'],
  ['help.shortcuts.sidebarToggle.trigger', 'help.shortcuts.sidebarToggle.desc'],
  ['help.shortcuts.dragDrop.trigger', 'help.shortcuts.dragDrop.desc'],
  ['help.shortcuts.diagram.trigger', 'help.shortcuts.diagram.desc'],
  ['help.shortcuts.toolbar.trigger', 'help.shortcuts.toolbar.desc'],
  // Removed at the owner's request: `||| / ^^` (cell merging) and
  // `[//]: # (folio-table: …)` (invisible metadata — backgrounds and widths).
  // These are details of the file format, not editor commands: both are done
  // with the mouse in the table itself, and in the "Editor commands" list they
  // were only confusing. The syntax itself is still supported — the display
  // was removed, not the behavior; the help.shortcuts.tableMerge/tableMeta.*
  // strings stay in the dictionaries.
];

export interface HelpModalProps {
  onClose: () => void;
}

/**
 * "Editor commands" — a static reference card, round 6 addendum. Opened
 * from two independent places (UserMenu's "Tips" entry, and the same label
 * at the bottom of the Cmd+K actions section) — each caller just owns its
 * own open/close boolean and renders this when true; no shared state needed
 * for a dialog this simple. Esc-to-close comes from ui/Modal.tsx itself.
 */
export function HelpModal({ onClose }: HelpModalProps) {
  const { t } = useTranslation('app');
  return (
    <Modal title={t('help.title')} onClose={onClose}>
      <dl className="flex flex-col gap-2.5">
        {SHORTCUT_KEYS.map(([triggerKey, descKey]) => (
          <div key={triggerKey} className="grid grid-cols-[minmax(0,auto)_1fr] items-baseline gap-x-3">
            <dt className="shrink-0 whitespace-nowrap rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              {t(triggerKey)}
            </dt>
            <dd className="text-sm text-neutral-600 dark:text-neutral-400">{t(descKey)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
