/**
 * Wiring between the pure decoration computation and CodeMirror's view layer.
 *
 * Split in two on purpose: CodeMirror refuses block-level replacements coming
 * from a ViewPlugin ("Block decorations may not be specified via plugins"), so
 * mermaid/image blocks live in a StateField while the cheap, viewport-bound
 * inline decorations live in a ViewPlugin.
 */
import { syntaxTree } from '@codemirror/language';
import { Facet, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import {
  computeBlockSpecs,
  computeInlineSpecs,
  type BlockSpec,
  type InlineSpec,
} from './live-decorations';
import { blockWidgetNav } from './block-nav';
import { blockAnchorField } from './editor-services';
import { DetailsWidget } from './details-widget';
import { emptyPageHint } from './empty-hint';
import { currentLanguage, languageChangedEffect } from './i18n-reload';
import { HtmlBlockWidget } from './html-widget';
import { linkEditingGuard } from './link-guard';
import { PagetreeWidget } from './pagetree-widget';
import { MermaidWidget } from './mermaid-widgets';
import { resolveAssetSrc } from './paths';
import { TableWidget, tableCellRescue } from './table-widget';
import { StatusWidget } from './status-widget';
import { BulletWidget, CalloutLabelWidget, ImageWidget, TaskCheckboxWidget } from './widgets';

export interface PageContext {
  space: string;
  /** Page path relative to the space root — relative image srcs resolve against its directory. */
  pagePath: string;
  /** Current page's ULID — the `::pagetree` widget fetches its subtree by id. */
  pageId: string;
  /**
   * Share-link token when this editor is a session-free guest's (round 8).
   * Asset URLs need it appended or /files answers 401 — see resolveAssetSrc.
   */
  shareToken?: string;
}

const EMPTY_CONTEXT: PageContext = { space: '', pagePath: '', pageId: '' };

/** True in live mode; false in source mode (styling only, no folding or widgets). */
export const liveModeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.length > 0 && values[values.length - 1],
});

export const pageContextFacet = Facet.define<PageContext, PageContext>({
  combine: (values) => values[values.length - 1] ?? EMPTY_CONTEXT,
});

const hidden = Decoration.replace({});

function inlineDecoration(spec: InlineSpec, lang: string): Range<Decoration> | null {
  switch (spec.kind) {
    case 'hide':
      return hidden.range(spec.from, spec.to);
    case 'mark':
      return Decoration.mark({ class: spec.cls }).range(spec.from, spec.to);
    case 'line':
      return Decoration.line(spec.style ? { class: spec.cls, attributes: { style: spec.style } } : { class: spec.cls }).range(
        spec.pos,
      );
    case 'bullet':
      return Decoration.replace({ widget: new BulletWidget(spec.level) }).range(spec.from, spec.to);
    case 'task':
      return Decoration.replace({ widget: new TaskCheckboxWidget(spec.checked) }).range(spec.from, spec.to);
    case 'status':
      return Decoration.replace({ widget: new StatusWidget(spec.label, spec.color, lang) }).range(spec.from, spec.to);
    case 'callout':
      // Carries the language for the same reason the block widgets do: the
      // label is translated text baked into the widget's DOM (round 22).
      return Decoration.replace({ widget: new CalloutLabelWidget(spec.type, lang) }).range(spec.from, spec.to);
  }
}

function blockDecoration(spec: BlockSpec, ctx: PageContext, lang: string): Range<Decoration> {
  switch (spec.kind) {
    case 'mermaid':
      return Decoration.replace({ widget: new MermaidWidget(spec.code), block: true }).range(spec.from, spec.to);
    case 'table':
      return Decoration.replace({ widget: new TableWidget(spec.source, lang), block: true }).range(spec.from, spec.to);
    case 'html': {
      const widget = new HtmlBlockWidget(spec.html, ctx.space, ctx.pagePath, lang);
      return Decoration.replace({ widget, block: true }).range(spec.from, spec.to);
    }
    case 'pagetree': {
      const widget = new PagetreeWidget(ctx.pageId, spec.depth, lang);
      return Decoration.replace({ widget, block: true }).range(spec.from, spec.to);
    }
    case 'details': {
      const widget = new DetailsWidget(
        spec.summary,
        spec.body,
        spec.open,
        ctx.space,
        ctx.pagePath,
        lang,
      );
      return Decoration.replace({ widget, block: true }).range(spec.from, spec.to);
    }
    case 'image': {
      const widget = new ImageWidget(
        spec.alt,
        spec.src,
        resolveAssetSrc(spec.src, ctx.space, ctx.pagePath, ctx.shareToken),
        spec.width,
      );
      return Decoration.replace({ widget, block: true }).range(spec.from, spec.to);
    }
  }
}

function buildBlockDecorations(state: EditorState): DecorationSet {
  if (!state.facet(liveModeFacet)) return Decoration.none;
  const ctx = state.facet(pageContextFacet);
  const specs = computeBlockSpecs({
    doc: state.doc,
    tree: syntaxTree(state),
    selection: state.selection.ranges,
    // Block widgets change the editor's vertical layout, so they cannot be
    // limited to the viewport; the scan only descends into block containers.
    ranges: [{ from: 0, to: state.doc.length }],
    live: true,
  });
  return Decoration.set(
    specs.map((spec) => blockDecoration(spec, ctx, currentLanguage())),
    true,
  );
}

const blockWidgets = StateField.define<DecorationSet>({
  create: (state) => buildBlockDecorations(state),
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      tr.effects.some((effect) => effect.is(languageChangedEffect)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    ) {
      return buildBlockDecorations(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface InlineDecorations {
  /** Everything rendered: hidden markers, styling marks, checkboxes, callout labels. */
  decorations: DecorationSet;
  /**
   * Just the hidden ('hide') ranges — the ones with nothing rendered in their
   * place. Fed to `EditorView.atomicRanges` so the caret can't rest strictly
   * inside a folded marker, where it would look identical to a legal
   * position but split the raw markdown if the user typed or hit Enter.
   */
  atomic: DecorationSet;
}

function buildInlineDecorations(view: EditorView): InlineDecorations {
  const state = view.state;
  const specs = computeInlineSpecs({
    doc: state.doc,
    tree: syntaxTree(state),
    selection: state.selection.ranges,
    ranges: view.visibleRanges,
    live: state.facet(liveModeFacet),
  });
  const lang = currentLanguage();
  const ranges: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  for (const spec of specs) {
    const deco = inlineDecoration(spec, lang);
    if (!deco) continue;
    ranges.push(deco);
    // 'bullet' is the list marker's glyph: same story, the caret must not rest
    // inside the `-` it replaces.
    // 'status' is the badge of a `:status[…]` tag: one atom, the caret steps
    // over it and Backspace/Delete remove the whole tag (editing is the popover).
    // 'hide' ranges are the folded markers link-guard.ts/block-nav.ts guard;
    // 'callout' is the `[!NOTE]` label widget — not hidden (it renders an
    // icon + name), but just as much a trap: without this, the caret can
    // still rest strictly inside the label's own two characters' worth of
    // text, which looks exactly like "on the label" (see block-nav.ts for the
    // rest of that fix — this alone only keeps the caret off the label
    // itself, not off the whole line it sits on).
    if (spec.kind === 'hide' || spec.kind === 'callout' || spec.kind === 'bullet' || spec.kind === 'status') atomicRanges.push(deco);
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomicRanges, true) };
}

const inlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;

    constructor(view: EditorView) {
      ({ decorations: this.decorations, atomic: this.atomic } = buildInlineDecorations(view));
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some(
          (tr) => tr.reconfigured || tr.effects.some((effect) => effect.is(languageChangedEffect)),
        ) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        ({ decorations: this.decorations, atomic: this.atomic } = buildInlineDecorations(update.view));
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Extensions that render the live preview; `liveModeFacet` switches folding on and off. */
export const livePreview: Extension = [
  blockAnchorField,
  emptyPageHint,
  blockWidgets,
  inlineDecorations,
  // Folded markers (link brackets, emphasis/strikethrough marks, etc.) render
  // as nothing, so without this the caret can be moved or clicked strictly
  // inside one — a position indistinguishable from a legal one until you type
  // or hit Enter there. See link-guard.ts for the follow-up: even the (legal)
  // boundary right next to a folded link marker needs Enter/Backspace/Delete
  // handled specially, which atomicRanges alone doesn't cover.
  EditorView.atomicRanges.of((view) => view.plugin(inlineDecorations)?.atomic ?? Decoration.none),
  linkEditingGuard,
  // Arrow-key travel across a block widget (table, mermaid, image, details,
  // html, pagetree) or a callout's label line — see block-nav.ts. Same
  // precedence tier as linkEditingGuard, different keys, so order between the
  // two doesn't matter.
  blockWidgetNav,
  // Rides along with the table widget: it is what gets a half-typed cell into
  // the document when the widget is torn down mid-edit (source mode, a
  // language switch, a remote edit) — see table-widget.ts, "draft rescue".
  tableCellRescue,
];

/** Per-mode configuration, meant to be swapped through a Compartment. */
export function livePreviewConfig(live: boolean, ctx: PageContext): Extension {
  return [liveModeFacet.of(live), pageContextFacet.of(ctx)];
}
