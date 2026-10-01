import type { Root, Element, ElementContent } from 'hast';
import { t } from './i18n/register';

const HEADING_RANK: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/**
 * Wraps every h2/h3 (that got an id from rehypeAssignHeadingIds — must run
 * after it) and its following siblings, up to the next heading of equal or
 * higher rank (or the end of this segment), into:
 *
 *   <div class="folio-collapsible" data-collapse-slug="...">
 *     <h2 id="...">...<button class="folio-collapse-toggle" data-collapse-toggle="..." aria-label="..."/></h2>
 *     <div class="folio-collapsible-body">...</div>
 *     <div class="folio-collapsible-stub">N hidden blocks</div>
 *   </div>
 *
 * The toggle's aria-label and the stub's count text are both resolved via
 * the SAME non-React `t()` this zone's alerts.ts/directiveFallback.ts
 * already use (this runs inside a plain unified transform, not a component
 * — see alerts.ts's own doc comment for why). The stub count goes through
 * i18next's count-based plural key selection (`collapsible.hiddenBlocks_one`
 * / `_few` / `_many` / `_other` in i18n/*.json) rather than one fixed
 * string, since ru/uk need up to four distinct plural forms.
 *
 * The stub's count is baked in at render time; CSS alone (markdown.css)
 * shows either the body or the stub based on a `folio-collapsible--collapsed`
 * class — index.tsx only ever toggles that one class after render, it never
 * rebuilds this structure. That split is deliberate: this plugin runs
 * within ONE mermaid-split segment's own tree, so a mermaid fence inside
 * what would otherwise be a single collapsible section acts as an implicit
 * boundary (the fence, and anything after it up to the real next heading,
 * stays outside any wrapper and is always visible) — chosen over doing this
 * as a post-render DOM pass across segments, which would mean physically
 * moving/removing the <div class="folio-md-segment"> wrapper elements and
 * the real <MermaidBlock> React component inside .folio-mermaid-segment
 * *out from under React's own reconciliation*, risking exactly the kind of
 * "not a child of this node" breakage that pattern is known for.
 */
export function rehypeCollapsibleSections() {
  return (tree: Root) => {
    tree.children = groupSiblings(tree.children as ElementContent[]) as Root['children'];
  };
}

function groupSiblings(children: ElementContent[]): ElementContent[] {
  const output: ElementContent[] = [];
  let i = 0;

  while (i < children.length) {
    const node = children[i];
    const rank = headingRank(node);
    const slug = rank !== undefined ? headingId(node as Element) : undefined;

    if ((rank === 2 || rank === 3) && slug) {
      const heading = node as Element;
      const body: ElementContent[] = [];
      let j = i + 1;
      while (j < children.length) {
        const candidateRank = headingRank(children[j]);
        if (candidateRank !== undefined && candidateRank <= rank) break;
        body.push(children[j]);
        j++;
      }

      const toggle: Element = {
        type: 'element',
        tagName: 'button',
        properties: { type: 'button', className: ['folio-collapse-toggle'], dataCollapseToggle: slug, ariaLabel: t('collapsible.toggleLabel') },
        children: [],
      };
      heading.children = [toggle, ...heading.children];

      const bodyEl: Element = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['folio-collapsible-body'] },
        children: body,
      };
      // Count only real content blocks, not the whitespace-only text nodes
      // remark-rehype inserts between block elements for HTML formatting —
      // otherwise a section with a single paragraph would misreport as
      // 3 hidden blocks instead of 1.
      const blockCount = body.filter((child) => child.type === 'element').length;
      const stub: Element = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['folio-collapsible-stub'] },
        children: [{ type: 'text', value: t('collapsible.hiddenBlocks', { count: blockCount }) }],
      };
      const wrapper: Element = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['folio-collapsible'], dataCollapseSlug: slug },
        children: [heading, bodyEl, stub],
      };

      output.push(wrapper);
      i = j;
      continue;
    }

    output.push(node);
    i++;
  }

  return output;
}

function headingRank(node: ElementContent): number | undefined {
  return node.type === 'element' ? HEADING_RANK[node.tagName] : undefined;
}

function headingId(node: Element): string | undefined {
  return typeof node.properties.id === 'string' ? node.properties.id : undefined;
}
