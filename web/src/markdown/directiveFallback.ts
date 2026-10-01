import type { Root } from 'mdast';
import type { VFile } from 'vfile';
import { visit } from 'unist-util-visit';
import { t } from './i18n/register';

/**
 * Defense-in-depth: the primary path for `::pagetree` is pagetreeSplit.ts,
 * which extracts it into its own segment (a real React island) before this
 * string-based pipeline ever sees it. This plugin exists so that if a
 * directive somehow still reaches here — a future caller of
 * renderMarkdownToHtml that skips the pre-split, or a directive kind added
 * later that doesn't need an island — it never falls through to
 * unhandled/raw output. Product spec's normative rule (docs/spec.md §3.2):
 * "a directive without a defined text fallback is not accepted into the
 * codebase" — this is what makes that true at the rendering level, not just
 * by convention in how directives are authored.
 *
 * Extend FALLBACKS as later rounds add the rest of the spec's directive
 * table (::toc, ::include, ::status, ::embed, :::plugin — each with its own
 * fallback text there).
 *
 * 11.09 — the other half of "never falls through to raw output": a directive
 * nobody DECLARED is usually not a directive at all. `remark-directive` is a
 * parser extension, so it claims `:name` anywhere in prose — including the
 * `:16` inside a plain `15:16`. Every time in the owner's incident log came
 * out as `15::16` in a dimmed span: one colon invented by the `::${name}`
 * text below, and the dimming by the fallback class. An undeclared directive
 * now degrades to its EXACT original source, taken from the file by the
 * node's own position, with no wrapper element at all — so text that was
 * never meant as markup renders as what the author typed. The `position`
 * slice is what makes that exact: reconstructing `:name[label]{attrs}` from
 * the parsed node would be a second, drifting implementation of the syntax.
 */
const FALLBACKS: Record<string, () => string> = {
  pagetree: () => t('pagetree.fallback'),
  form: () => t('form.fallback'),
};

interface DirectiveNode {
  type: string;
  name?: string;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    hChildren?: Array<{ type: string; value: string }>;
  } | null;
}

/** The exact characters the author typed for this node, or null when position info is missing. */
function sourceOf(node: { position?: { start: { offset?: number }; end: { offset?: number } } }, file: VFile): string | null {
  const from = node.position?.start?.offset;
  const to = node.position?.end?.offset;
  if (from === undefined || to === undefined) return null;
  const value = String(file.value ?? '');
  return value.slice(from, to) || null;
}

export function remarkDirectiveFallback() {
  return (tree: Root, file: VFile) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'leafDirective' && node.type !== 'containerDirective' && node.type !== 'textDirective') return;
      const directive = node as unknown as DirectiveNode;
      const fallbackFor = directive.name ? FALLBACKS[directive.name] : undefined;

      // Nobody declared this one AND it is the inline form: put the author's
      // own characters back and get out of the way (see the module docblock).
      //
      // Deliberately `textDirective` only. The authored directive forms in
      // Folio are the leaf `::name` and the container `:::name` — those keep
      // the visible fallback the product spec requires (§3.2: a directive
      // without a defined text fallback is not accepted), because a `::foo`
      // in a document really is someone reaching for markup. The single-colon
      // inline form is the one nobody writes on purpose here, and the one
      // that collides with ordinary prose (`15:16`, `3:1`) — there, silence
      // is the correct fallback.
      if (!fallbackFor && node.type === 'textDirective' && parent && typeof index === 'number') {
        const original = sourceOf(node as never, file);
        if (original) {
          (parent.children as unknown[])[index] = { type: 'text', value: original };
          return;
        }
      }

      const text = fallbackFor ? fallbackFor() : directive.name ? `::${directive.name}` : '';
      const data = directive.data ?? (directive.data = {});

      if (node.type === 'containerDirective') {
        // A `:::name … :::` block OWNS the content between its fences —
        // everything the author wrote inside it is this node's children.
        // Setting hChildren here (as the leaf/text branch below does) would
        // replace them with the fallback text and silently DELETE the body,
        // which is how an imported `:::info` / `:::warning` / `:::note` from
        // Confluence or another wiki used to lose every word inside it.
        // So: degrade the directive itself into a neutral labelled block and
        // let mdast-util-to-hast convert the body normally (no hChildren =
        // "render my real children"). The name still shows, via
        // data-directive-label + a CSS ::before, the same data-not-CSS-text
        // scheme alerts.ts uses for its callout labels.
        data.hName = 'div';
        data.hProperties = { className: 'folio-directive-fallback-block', dataDirectiveLabel: text };
        return;
      }

      // `::name` / `:name[…]`: no body to lose (`::pagetree{depth=2}` is the
      // real case), so the whole node collapses to its fallback text inline.
      data.hName = 'span';
      data.hProperties = { className: 'folio-directive-fallback' };
      data.hChildren = [{ type: 'text', value: text }];
    });
  };
}
