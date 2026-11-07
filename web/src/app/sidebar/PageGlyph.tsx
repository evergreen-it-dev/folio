import { AppWindow, ChevronRight, ClipboardList, Database, FileText, FileType2, Folder, LayoutDashboard, Presentation, Sheet, Table2, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import { officeFormat, type PageKind } from '@shared/contracts';

/** Every sidebar row starts with the same 18x18 box, so titles share one x. */
export const GLYPH_BOX = 'flex h-[18px] w-[18px] shrink-0 items-center justify-center';
const KIND_ICON = 'shrink-0 text-neutral-500 dark:text-neutral-400';
const DOC_ICON = 'shrink-0 text-neutral-400 dark:text-neutral-500';
const SIZE = 15;
const STROKE = 1.75;

export interface PageGlyphProps {
  kind?: PageKind | 'folder';
  /** Frontmatter icon (emoji). */
  icon?: string | null;
  path?: string;
}

/** The page's glyph inside the unified icon box: emoji, a kind icon, or a faint doc icon. */
export function PageGlyph({ kind, icon, path }: PageGlyphProps) {
  return <span className={GLYPH_BOX}>{glyphContent(kind, icon, path)}</span>;
}

/** Same box around any lucide icon (Home, Search, Graph…), in the kind-icon colour. */
export function RowIconBox({ children }: { children: ReactNode }) {
  return <span className={GLYPH_BOX}>{children}</span>;
}

export const kindIconProps = { size: SIZE, strokeWidth: STROKE, className: KIND_ICON, 'aria-hidden': true } as const;

/*
 * Round 14 dropped the glyph of a plain doc because an empty slot beat a repeated
 * grey icon. Owner, 07.11.2026: empty slots read as holes, and the few emoji rows
 * hung in the air. A consistent icon column wins, so the doc glyph is back, faint.
 */
function glyphContent(kind: PageGlyphProps['kind'], icon: string | null | undefined, path: string | undefined): ReactNode {
  if (kind === 'folder') return <Folder {...kindIconProps} />;
  if (icon) return <span className="text-[15px] leading-none" aria-hidden="true">{icon}</span>;
  switch (kind) {
    case 'board':
      return <LayoutDashboard {...kindIconProps} />;
    case 'table':
      return <Table2 {...kindIconProps} />;
    case 'pdf':
      return <FileType2 {...kindIconProps} />;
    case 'office': {
      const format = path ? officeFormat(path) : undefined;
      if (format === 'xlsx') return <Sheet {...kindIconProps} />;
      if (format === 'pptx') return <Presentation {...kindIconProps} />;
      return <FileText {...kindIconProps} />;
    }
    case 'form':
      return <ClipboardList {...kindIconProps} />;
    case 'canvas':
      return <Waypoints {...kindIconProps} />;
    case 'base':
      return <Database {...kindIconProps} />;
    case 'artifact':
      return <AppWindow {...kindIconProps} />;
    default:
      return <FileText size={SIZE} strokeWidth={STROKE} className={DOC_ICON} aria-hidden="true" />;
  }
}

/** The expand/collapse toggle at the right end of a row: always visible, turns 90 degrees when open. */
export function DisclosureChevron({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-tour="tree-chevron"
      aria-label={label}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
    >
      <ChevronRight size={13} aria-hidden="true" className={`transition-transform duration-100 ${open ? 'rotate-90' : ''}`} />
    </button>
  );
}

/** Decorative twin of DisclosureChevron for section rows where the whole row is the toggle. */
export function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <span aria-hidden="true" className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-neutral-400 dark:text-neutral-500">
      <ChevronRight size={13} className={`transition-transform duration-100 ${open ? 'rotate-90' : ''}`} />
    </span>
  );
}
