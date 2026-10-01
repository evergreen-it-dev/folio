import { defaultSchema } from 'rehype-sanitize';
import type { Options as Schema } from 'rehype-sanitize';

const defaultAttributes = defaultSchema.attributes ?? {};
const defaultWildcard = defaultAttributes['*'] ?? [];
const defaultA = defaultAttributes.a ?? [];
const defaultTagNames = defaultSchema.tagNames ?? [];

/**
 * Extends rehype-sanitize's GitHub-style default schema for what this
 * renderer additionally produces:
 * - `className` everywhere (GFM alert callouts, mermaid/segment wrappers,
 *   round 15's `.folio-mention` pill — see mentions.ts);
 * - `dataFolioLink`/`dataAlert`/`dataAlertLabel`/`dataDirectiveLabel`/
 *   `dataCollapseSlug`/`dataCollapseToggle`/`dataNoteIndex`, this renderer's
 *   own data-* hooks (round 5 adds the collapse pair; round 22 adds the
 *   translated alert label; `dataDirectiveLabel` names an unknown container
 *   directive whose body is kept — see directiveFallback.ts; `dataNoteIndex`
 *   is the notes panel's reading-mode scroll target, see noteIds.ts);
 * - `dataFolioNav` (round 22.09.2026: a resolved absolute/root-relative
 *   Folio page URL rewritten to an in-app link — see rehypeFolioLinks.ts —
 *   carries the app route to navigate to on click, same idea as
 *   `dataFolioLink` for a relative `.md` link but already a full route, not
 *   a page-relative path needing `/api/resolve`);
 * - `target`/`rel` on links, for external links opened in a new tab;
 * - `details`/`summary` (already default, listed to make the intent explicit);
 * - `button` (round 5: the collapsible-section toggle; the fit/scroll table
 *   toggle adds `dataTableToggle`) with just the attributes it's ever given
 *   — deliberately not the general form-control surface (no
 *   `disabled`/`name`/`value` etc.), since these are the only uses;
 * - `mark`/`u` (round 21's format toolbar writes `<mark>` for highlight;
 *   `<u>` only ever arrives from imported HTML — the toolbar writes `<ins>`,
 *   which the default schema already allows). Neither is in the default
 *   list, and an unknown tag is unwrapped rather than dropped, so without
 *   these the text survived but silently lost its formatting.
 *
 * - `abbr` (round 31: glossary terms — see glossaryTerms.ts. Its `title`
 *   attribute is already in the default `'*'` list, verified the same way
 *   as the round-16 note below — only the tag name itself needs adding);
 *
 * - `colgroup`/`col` (round 17: a table with column widths gets a colgroup —
 *   see tableExtensions.ts for why `width` on `<col>` and not inline styles).
 *   Both are purely presentational and carry nothing scriptable; `width` and
 *   `span`, the only attributes they are ever given, are already in the
 *   default `'*'` list, so the tag names are the whole addition. Round 17's
 *   cell backgrounds need nothing at all here: they are `folio-bg-*` classes
 *   and `className` is allowed above (the same classes the round-16b
 *   Confluence importer stamps on raw-HTML table cells).
 *
 * Task-list checkboxes (`input[type=checkbox][disabled][checked]`) and
 * tables are already permitted by the default schema. Verified (round 16,
 * against node_modules/hast-util-sanitize's actual defaultSchema, not just
 * its docs) rather than assumed: `table`/`thead`/`tbody`/`tfoot`/`tr`/`th`/
 * `td`/`br`/`details`/`summary` are all already in the default `tagNames`
 * list, `colSpan`/`rowSpan`/`title` are already in the default `'*'`
 * attributes list, and `span` (round 15's mention pill element) is too — so
 * a Confluence-import raw HTML table (colspan/rowspan, nested lists,
 * `<details>`) and a literal `<br>` inside a pipe-table cell both pass
 * through unchanged with zero schema additions needed here.
 */
export const folioSanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: Array.from(
    new Set([...defaultTagNames, 'details', 'summary', 'button', 'mark', 'u', 'colgroup', 'col', 'abbr']),
  ),
  attributes: {
    ...defaultAttributes,
    '*': [
      ...defaultWildcard,
      'className',
      'dataAlert',
      'dataAlertLabel',
      'dataDirectiveLabel',
      'dataFolioLink',
      'dataFolioNav',
      'dataCollapseSlug',
      'dataNoteIndex',
      'id',
    ],
    a: [...defaultA, 'target', 'rel', 'dataFolioLink', 'dataFolioNav'],
    button: ['type', 'ariaLabel', 'dataCollapseToggle', 'dataTableToggle'],
  },
};
