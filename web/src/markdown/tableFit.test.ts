// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTableFitState,
  measureWideTables,
  readTableScrollOverrides,
  writeTableScrollOverrides,
} from './tableFit';

const LABELS = { switchToScroll: 'switch to scroll', switchToFit: 'switch to fit' };

afterEach(() => {
  document.body.innerHTML = '';
});

/** One wrapper/table/button, the same shape rehypeWrapTables (tables.ts)
 * bakes into the rendered HTML — built by hand here since these are pure DOM
 * functions, no rendering pipeline involved. */
function wrapHtml(index: number): string {
  return (
    `<div class="folio-table-wrap"><table><tr><td>x</td></tr></table>` +
    `<button type="button" class="folio-table-toggle" data-table-toggle="${index}"></button></div>`
  );
}

function buildWrap(index: number): { container: HTMLDivElement; wrap: HTMLDivElement; button: HTMLButtonElement } {
  const container = document.createElement('div');
  container.innerHTML = wrapHtml(index);
  document.body.appendChild(container);
  return {
    container,
    wrap: container.querySelector<HTMLDivElement>('.folio-table-wrap')!,
    button: container.querySelector<HTMLButtonElement>('[data-table-toggle]')!,
  };
}

/** Two independent tables in one container, indices 0 and 1. */
function buildTwoWraps(): { container: HTMLDivElement; wraps: HTMLDivElement[]; buttons: HTMLButtonElement[] } {
  const container = document.createElement('div');
  container.innerHTML = wrapHtml(0) + wrapHtml(1);
  document.body.appendChild(container);
  return {
    container,
    wraps: Array.from(container.querySelectorAll<HTMLDivElement>('.folio-table-wrap')),
    buttons: Array.from(container.querySelectorAll<HTMLButtonElement>('[data-table-toggle]')),
  };
}

describe('measureWideTables', () => {
  // jsdom never actually lays anything out — scrollWidth/clientWidth both
  // report 0 for every element, so "not overflowing" (0 > 0 is false) is the
  // one verdict reachable without stubbing. That's still a real assertion of
  // the DOM contract: a wrapper with no natural overflow never gets --wide.
  it('leaves a wrapper without --wide when it does not overflow (jsdom default: both 0)', () => {
    const { wrap } = buildWrap(0);
    measureWideTables(wrap.parentElement!);
    expect(wrap.classList.contains('folio-table-wrap--wide')).toBe(false);
  });

  it('adds --wide when the wrapper reports more scroll width than client width', () => {
    const { wrap } = buildWrap(0);
    Object.defineProperty(wrap, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, value: 400 });
    measureWideTables(wrap.parentElement!);
    expect(wrap.classList.contains('folio-table-wrap--wide')).toBe(true);
  });
});

describe('applyTableFitState', () => {
  it('never marks a non-wide wrapper --fit, even with no override on record', () => {
    const { container, wrap, button } = buildWrap(0);
    applyTableFitState(container, new Set(), LABELS);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(LABELS.switchToFit);
  });

  it('defaults a wide table to --fit when there is no override for its index', () => {
    const { container, wrap, button } = buildWrap(0);
    wrap.classList.add('folio-table-wrap--wide');
    applyTableFitState(container, new Set(), LABELS);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe(LABELS.switchToScroll);
  });

  it('honours a scroll override for a wide table, dropping --fit and swapping the label', () => {
    const { container, wrap, button } = buildWrap(2);
    wrap.classList.add('folio-table-wrap--wide');
    applyTableFitState(container, new Set([2]), LABELS);
    expect(wrap.classList.contains('folio-table-wrap--fit')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(LABELS.switchToFit);
  });

  it('only applies an override to the table whose index it names', () => {
    const { container, wraps, buttons } = buildTwoWraps();
    for (const wrap of wraps) wrap.classList.add('folio-table-wrap--wide');
    applyTableFitState(container, new Set([1]), LABELS);
    expect(wraps[0].classList.contains('folio-table-wrap--fit')).toBe(true);
    expect(buttons[0].getAttribute('aria-label')).toBe(LABELS.switchToScroll);
    expect(wraps[1].classList.contains('folio-table-wrap--fit')).toBe(false);
    expect(buttons[1].getAttribute('aria-label')).toBe(LABELS.switchToFit);
  });
});

describe('readTableScrollOverrides / writeTableScrollOverrides', () => {
  const PAGE = 'page-1';

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('reads back exactly what was written, round-tripped through JSON', () => {
    writeTableScrollOverrides(PAGE, new Set([0, 3, 7]));
    expect(readTableScrollOverrides(PAGE)).toEqual(new Set([0, 3, 7]));
  });

  it('returns an empty set for a page with nothing stored', () => {
    expect(readTableScrollOverrides('never-written')).toEqual(new Set());
  });

  it('returns an empty set instead of throwing on corrupt JSON', () => {
    localStorage.setItem('folio:tableScroll:' + PAGE, '{not json');
    expect(readTableScrollOverrides(PAGE)).toEqual(new Set());
  });

  it('is scoped per page id — writing one page does not touch another', () => {
    writeTableScrollOverrides('page-a', new Set([1]));
    writeTableScrollOverrides('page-b', new Set([2]));
    expect(readTableScrollOverrides('page-a')).toEqual(new Set([1]));
    expect(readTableScrollOverrides('page-b')).toEqual(new Set([2]));
  });
});
