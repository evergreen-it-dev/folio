import type { Root, PhrasingContent } from 'mdast';
import type { VFile } from 'vfile';
import { visit } from 'unist-util-visit';
import { resolveStatusColor, statusClassNames } from '@shared/status';

/**
 * `:status[Selected]{color=green}` -> `<span class="folio-status folio-status--green">Selected</span>`
 * (see shared/status.ts for the syntax and why it is a text directive).
 *
 * Runs right after remark-directive and BEFORE remarkDirectiveFallback: that
 * plugin turns every undeclared text directive back into its raw source, so a
 * status has to stop being a `textDirective` node first. It becomes a custom
 * `folioStatus` node that mdast-util-to-hast renders as the hinted `<span>`
 * (its unknown-node path honours `data.hName` / `hProperties`), keeping the
 * label's own inline children — `:status[**Go**]` still bolds.
 *
 * The upper case is CSS (`text-transform`), never applied to the text here, so
 * search, copy and every non-visual consumer see the characters as typed.
 * A tag with an empty label has nothing to show; it stays as the source text.
 */
export function remarkStatus() {
  return (tree: Root, file: VFile) => {
    visit(tree, 'textDirective', (node, index, parent) => {
      if (node.name !== 'status' || !parent || typeof index !== 'number') return;
      const from = node.position?.start?.offset;
      const to = node.position?.end?.offset;
      if (node.children.length === 0) {
        if (from === undefined || to === undefined) return;
        (parent.children as PhrasingContent[])[index] = { type: 'text', value: String(file.value ?? '').slice(from, to) };
        return;
      }
      const color = resolveStatusColor(node.attributes?.color ?? node.attributes?.colour);
      const status = {
        type: 'folioStatus',
        children: node.children,
        position: node.position,
        data: { hName: 'span', hProperties: { className: statusClassNames(color) } },
      };
      (parent.children as unknown[])[index] = status;
    });
  };
}
