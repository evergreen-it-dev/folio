import { Copy, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TableView } from '@shared/contracts';
import { Tabs } from '../ui/Tabs';
import { Button } from '../ui/Button';
import { Menu, MenuItem } from '../../app/ui/Menu';

/**
 * Round 26 (DATA TABLES) — the view tab strip (spec §5).
 *
 * Carries the draft affordance the spec is specific about: once the current
 * view has unsaved local changes, "Save changes" and "Add as a new
 * view" appear. Until then neither is shown — an always-present Save button
 * invites people to overwrite a shared view by reflex.
 *
 * A viewer sees neither button (spec §12: "can play with filters locally,
 * but cannot save views") but keeps the tabs and the draft itself.
 */

export interface ViewTabsProps {
  views: TableView[];
  activeId: string;
  dirty: boolean;
  canSave: boolean;
  onSelect: (id: string) => void;
  onSaveDraft: () => void;
  onSaveAsNew: () => void;
  onResetDraft: () => void;
  onCreate: (copyCurrent: boolean) => void;
  onRename: (view: TableView) => void;
  onDelete: (view: TableView) => void;
  onDuplicate: (view: TableView) => void;
}

export function ViewTabs({
  views,
  activeId,
  dirty,
  canSave,
  onSelect,
  onSaveDraft,
  onSaveAsNew,
  onResetDraft,
  onCreate,
  onRename,
  onDelete,
  onDuplicate,
}: ViewTabsProps) {
  const { t } = useTranslation('tables');

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 dark:border-neutral-700">
      <Tabs
        label={t('view.tabs')}
        activeId={activeId}
        onSelect={onSelect}
        className="min-w-0 flex-1"
        items={views.map((view) => ({
          id: view.id,
          label: view.name,
          icon: view.icon ? <span aria-hidden>{view.icon}</span> : undefined,
          trailing:
            view.id === activeId && canSave ? (
              <Menu
                align="right"
                className="w-auto shrink-0"
                triggerLabel={t('view.menu', { name: view.name })}
                trigger={<MoreHorizontal size={13} />}
              >
                {(close) => (
                  <>
                    <MenuItem
                      icon={<Pencil size={13} />}
                      onSelect={() => {
                        close();
                        onRename(view);
                      }}
                    >
                      {t('view.rename')}
                    </MenuItem>
                    <MenuItem
                      icon={<Copy size={13} />}
                      onSelect={() => {
                        close();
                        onDuplicate(view);
                      }}
                    >
                      {t('view.duplicate')}
                    </MenuItem>
                    <MenuItem
                      destructive
                      // Spec §5: the last view can't be deleted. Disabled
                      // rather than hidden, so the reason is discoverable.
                      disabled={views.length <= 1}
                      icon={<Trash2 size={13} />}
                      onSelect={() => {
                        close();
                        onDelete(view);
                      }}
                    >
                      {t('view.delete')}
                    </MenuItem>
                  </>
                )}
              </Menu>
            ) : undefined,
        }))}
        actions={
          canSave ? (
            <Menu
              align="left"
              className="w-auto shrink-0"
              triggerLabel={t('view.add')}
              trigger={<Plus size={14} />}
            >
              {(close) => (
                <>
                  <MenuItem
                    onSelect={() => {
                      close();
                      onCreate(false);
                    }}
                  >
                    {t('view.addEmpty')}
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      close();
                      onCreate(true);
                    }}
                  >
                    {t('view.addCopy')}
                  </MenuItem>
                </>
              )}
            </Menu>
          ) : undefined
        }
      />

      {dirty && (
        <div className="flex shrink-0 items-center gap-1.5 pb-1">
          <span className="text-[11px] text-neutral-400">{t('view.draft')}</span>
          <Button size="sm" variant="ghost" icon={<RotateCcw size={11} />} onClick={onResetDraft}>
            {t('view.reset')}
          </Button>
          {canSave && (
            <>
              <Button size="sm" variant="primary" onClick={onSaveDraft}>
                {t('view.saveChanges')}
              </Button>
              <Button size="sm" onClick={onSaveAsNew}>
                {t('view.saveAsNew')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
