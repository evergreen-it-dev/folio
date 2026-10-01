// Augments hast's Properties with the custom data-* attributes this
// renderer produces, so plugins can set them without an `as any` escape
// hatch. See @types/hast's own Data interface docblock for this pattern.
//
// The `import` below (rather than a bare `declare module` block) is load
// bearing: without it this file has no top-level import/export, so TS
// treats it as a script and the `declare module 'hast'` becomes a *new*,
// separate ambient module instead of merging into the real one — silently
// shadowing all the real Properties/Root/Element declarations project-wide.
import 'hast';

declare module 'hast' {
  interface Properties {
    /** Set on <a> to a space-relative path when it targets another markdown page; read by <Markdown>'s click handler. */
    dataFolioLink?: string | undefined;
    /** Set on the <div> a GFM alert blockquote is rendered as (note|tip|important|warning|caution). */
    dataAlert?: string | undefined;
    /** Round 22: the same alert's label, translated at render time (see alerts.ts) — markdown.css reads this for the visible ::before text instead of dataAlert itself. */
    dataAlertLabel?: string | undefined;
    /** Set on a collapsible section's wrapper <div> (round 5) to its heading's slug. */
    dataCollapseSlug?: string | undefined;
    /** Set on a collapsible section's toggle <button> (round 5) to its heading's slug; read by <Markdown>'s click handler. */
    dataCollapseToggle?: string | undefined;
  }
}
