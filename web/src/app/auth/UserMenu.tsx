import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bot, Building2, CircleHelp, GitBranch, HardDriveDownload, KeyRound, LogOut, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { Menu, MenuItem } from '../ui/Menu';
import { SettingsDialog } from './SettingsDialog';
import { HelpModal } from '../help/HelpModal';
import { ApiTokensModal } from '../tokens/ApiTokensModal';
import { GitCredentialsSettings } from '../git/GitCredentialsSettings';
import { ConfluenceImportDialog } from '../import/ConfluenceImportDialog';
import { AssistantSettingsModal } from '../assistant/AssistantSettingsModal';
import '../i18n/register';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}

export interface UserMenuProps {
  /**
   * The space the sidebar is currently showing, if any — threaded through to
   * ConfluenceImportDialog so it can preselect "import into the space I'm
   * already in" instead of defaulting to nothing (owner report 22.09.2026).
   * Optional/defaulted because SettingsDialog.test.tsx renders <UserMenu />
   * standalone, outside any space context.
   */
  space?: string;
}

/** Sidebar-bottom user menu: avatar initials + name, opens to personal settings, the tools/administration sections (the latter instance-admin only), and sign-out. */
export function UserMenu({ space = '' }: UserMenuProps) {
  const { t } = useTranslation('app');
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [gitCredentialsOpen, setGitCredentialsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [assistantSettingsOpen, setAssistantSettingsOpen] = useState(false);

  return (
    <div className="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
      <Menu
        triggerLabel={t('auth.userMenu.label')}
        className="w-full"
        trigger={
          <span className="flex w-full items-center gap-2 px-1 py-0.5 text-left">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs font-semibold text-white dark:bg-neutral-200 dark:text-neutral-900">
              {initials(user.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {user.name}
            </span>
          </span>
        }
      >
        {(close) => (
          <div className="w-56">
            {/* Round 22 (menu-reorg) set up three labeled sections; round 28
                dissolved the first one. The personal section used to hold the
                width/theme/language/username controls inline — four stacked
                widgets inside a dropdown — and the owner asked for them in a
                window of their own, so they now live in SettingsDialog and
                this is the single item that opens it. It leads the menu
                UNLABELED on purpose: a section heading over exactly one item
                is noise, and it mirrors the Help/Sign-out group at the
                bottom, which has always been an unlabeled group too.
                The tools section (tokens/git) and the administration section
                (instance-admin only, same gate Users already had) are
                untouched. Import from Confluence still sits alongside Users/
                Spaces in that last section VISUALLY while deliberately
                keeping its own current (non-admin-gated) availability —
                DEV-PLAN's own wording is "leave it with the present rights,
                just regroup": it renders unconditionally, only the
                heading+Users+Spaces above it are admin-only. */}
            <MenuItem
              icon={<SlidersHorizontal size={14} />}
              onSelect={() => {
                close();
                setSettingsOpen(true);
              }}
            >
              {t('auth.userMenu.settings')}
            </MenuItem>

            <SectionLabel>{t('auth.userMenu.sections.tools')}</SectionLabel>
            <MenuItem
              icon={<KeyRound size={14} />}
              onSelect={() => {
                close();
                setTokensOpen(true);
              }}
            >
              {t('tokens.title')}
            </MenuItem>
            <MenuItem
              icon={<GitBranch size={14} />}
              onSelect={() => {
                close();
                setGitCredentialsOpen(true);
              }}
            >
              {t('git.credentials.title')}
            </MenuItem>
            <MenuItem
              icon={<Bot size={14} />}
              onSelect={() => {
                close();
                setAssistantSettingsOpen(true);
              }}
            >
              {t('assistant.menu.label')}
            </MenuItem>

            {user.isAdmin && <SectionLabel>{t('auth.userMenu.sections.admin')}</SectionLabel>}
            {user.isAdmin && (
              <MenuItem
                icon={<Users size={14} />}
                onSelect={() => {
                  close();
                  navigate('/admin/users');
                }}
              >
                {t('auth.userMenu.users')}
              </MenuItem>
            )}
            {user.isAdmin && (
              <MenuItem
                icon={<Building2 size={14} />}
                onSelect={() => {
                  close();
                  navigate('/admin/spaces');
                }}
              >
                {t('auth.userMenu.spaces')}
              </MenuItem>
            )}
            {/* Trash round: instance-wide trash. Space admins reach the same
                page scoped to their space via the space menu (Sidebar.tsx). */}
            {user.isAdmin && (
              <MenuItem
                icon={<Trash2 size={14} />}
                onSelect={() => {
                  close();
                  navigate('/trash');
                }}
              >
                {t('trash.title')}
              </MenuItem>
            )}
            <MenuItem
              icon={<HardDriveDownload size={14} />}
              onSelect={() => {
                close();
                setImportOpen(true);
              }}
            >
              {t('import.title')}
            </MenuItem>

            <div className="border-t border-neutral-200 pt-1 dark:border-neutral-700">
              <MenuItem
                icon={<CircleHelp size={14} />}
                onSelect={() => {
                  close();
                  setHelpOpen(true);
                }}
              >
                {t('auth.userMenu.help')}
              </MenuItem>
              <MenuItem
                icon={<LogOut size={14} />}
                destructive
                onSelect={() => {
                  close();
                  logout();
                }}
              >
                {t('auth.userMenu.signOut')}
              </MenuItem>
            </div>
          </div>
        )}
      </Menu>

      {settingsOpen && <SettingsDialog user={user} onClose={() => setSettingsOpen(false)} />}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {tokensOpen && <ApiTokensModal onClose={() => setTokensOpen(false)} />}
      {gitCredentialsOpen && <GitCredentialsSettings onClose={() => setGitCredentialsOpen(false)} />}
      {importOpen && <ConfluenceImportDialog currentSpace={space} onClose={() => setImportOpen(false)} />}
      {assistantSettingsOpen && <AssistantSettingsModal onClose={() => setAssistantSettingsOpen(false)} />}
    </div>
  );
}

/** Round 22 (menu-reorg): a section-grouping heading inside the user menu — a border-top divider + small caption, same visual language each individual field label here already used, just one level up (groups several items/controls, not one). */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-neutral-200 px-2.5 pt-2 pb-1.5 dark:border-neutral-700">
      <div className="text-xs font-medium text-neutral-400 dark:text-neutral-500">{children}</div>
    </div>
  );
}
