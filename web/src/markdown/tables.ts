import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, ElementContent } from 'hast';
import { t } from './i18n/register';

/**
 * Threaded through every segment's renderMarkdownToHtml call for one page —
 * mirrors headingIds.ts's HeadingIdCursor exactly, and for the same reason:
 * a mermaid fence can split one page's tables across several independent
 * pipeline runs (see pipeline.ts's docblock), and without a shared cursor
 * each call would restart numbering from zero, colliding two different
 * tables on the same "table 0" persistence key (tableFit.ts keys the
 * fit/scroll override by this index — see index.tsx's own doc comment for
 * why an index, rather than something edit-stable, is an accepted and
 * explicitly documented tradeoff here).
 */
export interface TableIndexCursor {
  index: number;
}

export function createTableIndexCursor(): TableIndexCursor {
  return { index: 0 };
}

// hast's own Properties type has className as Array<string> | undefined —
// every writer in this zone (addClass in tableExtensions.ts included) only
// ever produces that shape, never a bare string, so there's nothing else to
// branch on here.
function hasClassName(node: Element, name: string): boolean {
  return node.properties?.className?.includes(name) ?? false;
}

/**
 * Rehype plugin: wraps every <table> in a `<div class="folio-table-wrap">`
 * so wide tables scroll horizontally instead of blowing out the reading
 * column (the table itself keeps its natural table layout by default).
 *
 * Fit/scroll toggle: a table that does NOT already carry `folio-table-sized`
 * (tableExtensions.ts — a pipe table with an explicit `w=` column-width
 * metadata line, which is already permanently `table-layout: fixed` by
 * deliberate author choice, see markdown.css) also gets a quiet
 * `<button class="folio-table-toggle" data-table-toggle="N">` appended
 * AFTER the table — never before: pipeline.test.ts asserts
 * `<div class="folio-table-wrap"><table>` as an exact prefix in several
 * places, and putting the button after the closing `</table>` keeps that
 * true without editing those tests.
 *
 * Whether the table is actually wide enough to need fitting can't be known
 * here — there is no viewport at render time, and this renderer has no SSR
 * step to defer to. This plugin only ever bakes the STRUCTURE (wrapper +
 * button, both inert until scripted); index.tsx measures each wrapper
 * client-side after mount and toggles `folio-table-wrap--wide`/`--fit`,
 * exactly the same split rehypeCollapsibleSections/collapsible.ts already
 * use for the collapse toggle — the pipeline bakes the DOM shape once, a
 * post-mount effect only ever flips classes on top of it (safe against
 * React's reconciliation of the surrounding dangerouslySetInnerHTML region,
 * see collapsible.ts's own doc comment for why).
 */
export function rehypeWrapTables(cursor: TableIndexCursor = createTableIndexCursor()) {
  return (tree: Root) => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'table' || !parent || index === undefined) return;

      const tableIndex = cursor.index++;
      const children: ElementContent[] = [node];
      if (!hasClassName(node, 'folio-table-sized')) {
        children.push({
          type: 'element',
          tagName: 'button',
          properties: {
            type: 'button',
            className: ['folio-table-toggle'],
            dataTableToggle: String(tableIndex),
            // Baked default assumes the common case (a wide table defaults
            // to fit). index.tsx's applyTableFitState corrects this the
            // moment it knows both whether the table is actually wide and
            // whether this reader previously chose scroll for it, before
            // the reader can plausibly interact with it.
            ariaLabel: t('table.switchToScroll'),
          },
          children: [],
        });
      }

      const wrapper: Element = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['folio-table-wrap'] },
        children,
      };
      parent.children[index] = wrapper;
      // Skip back into the (unchanged) table node's own children and resume
      // the walk right after the wrapper so it isn't visited a second time.
      return [SKIP, index + 1];
    });
  };
}
