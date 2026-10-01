/**
 * Strips a leading YAML frontmatter block (`---\n...\n---\n`) from a
 * markdown document before it's handed to the unified/remark pipeline.
 *
 * Round 5 (page icons/covers) writes `icon:`/`cover:` into a real
 * frontmatter block via app/frontmatter.ts's upsertFrontmatterField, PUT
 * back as part of the page's `markdown` — see that file's docblock and
 * DEV-PLAN.md's "Round 5" SHELL section ("They are written through PUT markdown
 * (the frontmatter block) — the server parses them into meta"). The server is expected to
 * parse icon/cover *out* of that block into PageMeta fields, but the block
 * itself round-trips through `.markdown` verbatim (that's the only way a
 * page's other, unrelated frontmatter keys — e.g. inherited from an
 * imported git repo's existing Jekyll/Obsidian-style frontmatter — survive
 * an icon/cover edit unmolested, since upsertFrontmatterField only ever
 * touches the one key it's asked to).
 *
 * Without this, a frontmatter block reaching remark-parse renders as
 * garbage: the opening `---` becomes a thematic break (`<hr>`), and the
 * closing `---` — immediately following a plain `key: value` text line with
 * no blank line between them — is CommonMark setext-heading-underline
 * syntax, turning that line into a spurious `<h2>`. Stripping it up front
 * (called from every entry point that receives a *whole document* string —
 * splitMermaidFences and headings.ts's extractHeadings) keeps the reading
 * view correct regardless of whether a given page has frontmatter at all.
 *
 * Deliberately duplicated from app/frontmatter.ts's own FRONTMATTER_RE
 * rather than imported: markdown/ must never import from app/ (would open a
 * cycle through editor/ -> markdown/ and app/ -> editor/ — see pipeline.ts).
 */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_RE, '');
}
