// @vitest-environment jsdom
/**
 * Round 19 QA fix (#2-shell): clicking an outline entry in source/live used
 * to be a deliberate no-op (see this file's own former docblock in
 * OutlinePanel.tsx) — the owner didn't want that. EDITOR now exports
 * scrollActiveEditorToHeading(slug) from web/src/editor (DEV-PLAN.md's
 * Round 19 SHELL section carries the exact signature EDITOR left there),
 * which reaches whichever CodeMirror view is actually mounted without this
 * panel ever touching an EditorView itself. Mocked here rather than using
 * the real editor/ module: that module pulls in the full CodeMirror/y-
 * codemirror.next stack, which is unrelated to what this test is pinning
 * down (the fallback CHAIN, not editor/'s own scrolling behavior — that's
 * scroll-to-heading.test.ts's job).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import { OutlinePanel } from './OutlinePanel';
import { clearLiveDocText, publishLiveDocText } from '../liveDocText';

const scrollActiveEditorToHeading = vi.fn();
const scrollActiveEditorToOffset = vi.fn();
vi.mock('../../editor', () => ({
  scrollActiveEditorToHeading: (slug: string) => scrollActiveEditorToHeading(slug) as boolean,
  scrollActiveEditorToOffset: (pos: number) => scrollActiveEditorToOffset(pos) as boolean,
}));

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MARKDOWN = '# First Heading\n\ntext\n\n## Second Heading\n\nmore text\n';

describe('OutlinePanel — editor scroll handoff (Round 19 #2-shell)', () => {
  it('hands the click to scrollActiveEditorToHeading first, with the bare slug (no HEADING_ID_PREFIX)', () => {
    scrollActiveEditorToHeading.mockReturnValue(true);
    render(<OutlinePanel markdown={MARKDOWN} />);

    const getByIdSpy = vi.spyOn(document, 'getElementById');
    fireEvent.click(screen.getByText('First Heading'));

    expect(scrollActiveEditorToHeading).toHaveBeenCalledWith('first-heading');
    // Handled by the editor — must NOT also fall back to the reading-view scroll.
    expect(getByIdSpy).not.toHaveBeenCalled();
  });

  it('falls back to the reading view\'s getElementById scroll when the editor reports it did not handle it (reading mode, or no such heading)', () => {
    scrollActiveEditorToHeading.mockReturnValue(false);
    render(<OutlinePanel markdown={MARKDOWN} />);

    const target = document.createElement('div');
    target.id = 'user-content-second-heading';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    fireEvent.click(screen.getByText('Second Heading'));

    expect(scrollActiveEditorToHeading).toHaveBeenCalledWith('second-heading');
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

    document.body.removeChild(target);
  });

  it('is a true no-op (no throw, no scroll) when neither the editor nor the reading DOM has the heading', () => {
    scrollActiveEditorToHeading.mockReturnValue(false);
    render(<OutlinePanel markdown={MARKDOWN} />);
    expect(() => fireEvent.click(screen.getByText('First Heading'))).not.toThrow();
  });
});

/**
 * Round 22 (owner prod QA, real tablet/narrow viewport): the docked panel
 * above is CSS-hidden below ~1100px (min-[1100px]:), and until this fix
 * that meant there was no way at all to reach the outline below that width
 * — this floating trigger + overlay drawer is the fix, entirely additional
 * to (and independent of) the docked panel's own `open` persisted state.
 * `within(dialog)` scopes every query to the drawer specifically: the
 * always-mounted docked <nav> (CSS-hidden here, but jsdom applies no real
 * layout/CSS) renders the SAME heading text, so an unscoped screen.getByText
 * would ambiguously match both once the drawer is open.
 */
describe('OutlinePanel — <1100px floating trigger + overlay drawer (Round 22)', () => {
  beforeEach(() => {
    localStorage.clear(); // keep the docked panel's own `open` state at its default regardless of test order
  });

  it('opens an overlay drawer listing every heading when the floating trigger is clicked', () => {
    render(<OutlinePanel markdown={MARKDOWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show outline' }));

    const dialog = screen.getByRole('dialog', { name: 'Outline' });
    // getByText throws if no match — reaching the assertions below IS the check.
    expect(within(dialog).getByText('First Heading')).toBeTruthy();
    expect(within(dialog).getByText('Second Heading')).toBeTruthy();
  });

  it('clicking a heading in the drawer scrolls to it and closes the drawer', () => {
    scrollActiveEditorToHeading.mockReturnValue(true);
    render(<OutlinePanel markdown={MARKDOWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show outline' }));

    const dialog = screen.getByRole('dialog', { name: 'Outline' });
    fireEvent.click(within(dialog).getByText('Second Heading'));

    expect(scrollActiveEditorToHeading).toHaveBeenCalledWith('second-heading');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', () => {
    render(<OutlinePanel markdown={MARKDOWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show outline' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when the backdrop is clicked', () => {
    render(<OutlinePanel markdown={MARKDOWN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show outline' }));

    const dialog = screen.getByRole('dialog', { name: 'Outline' });
    // The backdrop is a plain aria-hidden div (not queryable by role/text) — it's the dialog's first child, see OutlinePanel.tsx.
    fireEvent.click(dialog.firstChild as Element);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/**
 * The "Notes" section (owner ask): a compact list of every callout/checklist
 * item on the page, below the heading list. Covers just the two structural
 * requirements the task called out explicitly — the section's presence is
 * driven by entries existing at all, independently of whether there are any
 * headings — plus the click handoff, which mirrors the heading one tested
 * above almost exactly (scrollActiveEditorToOffset first, data-note-index
 * DOM lookup as the reading-mode fallback).
 */
describe('OutlinePanel — Notes section', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders no Notes section at all when the page has no callouts/checklist items', () => {
    render(<OutlinePanel markdown={MARKDOWN} />);
    expect(screen.queryByText('Notes')).toBeNull();
  });

  it('renders the panel — with a Notes section, no Outline entries — for a page with entries but no headings', () => {
    const markdown = '> [!TIP]\n> Try this.\n\n- [ ] Buy milk\n';
    render(<OutlinePanel markdown={markdown} />);

    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.getByText('Try this.')).toBeTruthy();
    expect(screen.getByText('Buy milk')).toBeTruthy();
  });

  it('hides completed checklist items by default but shows a done/total counter', () => {
    const markdown = '- [ ] todo one\n- [x] done one\n- [x] done two\n';
    render(<OutlinePanel markdown={markdown} />);

    expect(screen.getByText('todo one')).toBeTruthy();
    expect(screen.queryByText('done one')).toBeNull();
    expect(screen.queryByText('done two')).toBeNull();
    expect(screen.getByText('2 of 3 checked')).toBeTruthy();
  });

  it('clicking a note entry hands off to scrollActiveEditorToOffset first', () => {
    scrollActiveEditorToOffset.mockReturnValue(true);
    const markdown = '> [!WARNING]\n> Careful here.\n';
    render(<OutlinePanel markdown={markdown} />);

    const getByIdSpy = vi.spyOn(document, 'querySelector');
    fireEvent.click(screen.getByText('Careful here.'));

    expect(scrollActiveEditorToOffset).toHaveBeenCalledWith(markdown.indexOf('> [!WARNING]'));
    expect(getByIdSpy).not.toHaveBeenCalled();
  });

  it('falls back to the data-note-index DOM lookup when the editor reports it did not handle it', () => {
    scrollActiveEditorToOffset.mockReturnValue(false);
    const markdown = '> [!WARNING]\n> Careful here.\n';
    render(<OutlinePanel markdown={markdown} />);

    const target = document.createElement('div');
    target.setAttribute('data-note-index', '0');
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);

    fireEvent.click(screen.getByText('Careful here.'));

    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    document.body.removeChild(target);
  });

  /**
   * The owner, 11.09: "notes open only together with the outline, and they
   * have to be independent". Two lists — two toggles; what is hidden comes
   * back through its own icon on the rail, without touching the neighbor.
   */
  describe('independent toggles', () => {
    const BOTH = '# Heading\n\ntext\n\n> [!NOTE]\n> a note\n';

    it('a hidden outline leaves the notes in place and gives an icon to bring it back', () => {
      // The docked column is the first child; further in the tree there is also
      // the floating button of the narrow screen with the same name, so the
      // queries are narrowed to the column.
      const { container } = render(<OutlinePanel markdown={BOTH} />);
      const docked = () => within(container.firstElementChild as HTMLElement);

      fireEvent.click(docked().getByRole('button', { name: 'Hide outline' }));

      expect(screen.queryByText('Heading')).toBeNull();
      expect(screen.getByText('a note')).toBeTruthy();
      expect(docked().getByRole('button', { name: 'Show outline' })).toBeTruthy();
    });

    it('hidden notes leave the outline in place and give an icon to bring them back', () => {
      render(<OutlinePanel markdown={BOTH} />);

      fireEvent.click(screen.getByRole('button', { name: 'Hide the notes' }));

      expect(screen.getByText('Heading')).toBeTruthy();
      expect(screen.queryByText('a note')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show notes' })).toBeTruthy();
    });

    it('both hidden — a rail of two icons stays', () => {
      const { container } = render(<OutlinePanel markdown={BOTH} />);
      const docked = () => within(container.firstElementChild as HTMLElement);

      fireEvent.click(docked().getByRole('button', { name: 'Hide outline' }));
      fireEvent.click(docked().getByRole('button', { name: 'Hide the notes' }));

      expect(docked().getByRole('button', { name: 'Show outline' })).toBeTruthy();
      expect(docked().getByRole('button', { name: 'Show notes' })).toBeTruthy();
      expect(screen.queryByText('Heading')).toBeNull();
      expect(screen.queryByText('a note')).toBeNull();
    });

    it('a page without headings shows the notes alone, without an empty outline', () => {
      render(<OutlinePanel markdown={'> [!NOTE]\n> hi\n'} />);

      expect(screen.getByText('hi')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Hide outline' })).toBeNull();
    });
  });
});

/**
 * The owner, 11.09: "the outline is not rebuilt when headings are added in
 * live edit". The panel was fed a snapshot from the server; now the editor
 * publishes the live text (app/liveDocText.ts), and it has to win.
 */
describe('live text from the editor', () => {
  afterEach(() => clearLiveDocText('p1'));

  it('takes the headings from the live document, not from the server snapshot', () => {
    publishLiveDocText('p1', '# Live heading\n');
    render(<OutlinePanel markdown={'# Old heading\n'} pageId="p1" />);

    expect(screen.getByText('Live heading')).toBeTruthy();
    expect(screen.queryByText('Old heading')).toBeNull();
  });

  it('without live text (another page or no editor) the snapshot stays', () => {
    publishLiveDocText('other', '# Foreign\n');
    render(<OutlinePanel markdown={'# Old heading\n'} pageId="p1" />);

    expect(screen.getByText('Old heading')).toBeTruthy();
    expect(screen.queryByText('Foreign')).toBeNull();
    clearLiveDocText('other');
  });

  it('new notes from the live text are picked up too', () => {
    publishLiveDocText('p1', '> [!NOTE]\n> a fresh note\n');
    render(<OutlinePanel markdown={''} pageId="p1" />);

    expect(screen.getByText('a fresh note')).toBeTruthy();
  });
});
