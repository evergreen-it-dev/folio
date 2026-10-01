/**
 * Round 23 (EXPORT) — markdown assembly. This is Stage 1's core: everything
 * `GET /api/pages/:id/export.md` and the agent-facing `GET /share/:token.md`
 * actually return, and the source the PDF/DOCX stages render from.
 *
 * Normative rules implemented here (DEV-PLAN R23 addendum 1 point 1 and
 * addendum 2 point 4):
 *  - markdown WITHOUT frontmatter — the source, not a render;
 *  - relative links and images rewritten to ABSOLUTE prod URLs, "otherwise
 *    the file is unreadable outside the context of the space";
 *  - with `includeChildren`, the subtree collates into ONE document: tree
 *    order, depth-first, parent before children;
 *  - child headings demoted by depth (an H1 one level down becomes an H2),
 *    `flatten=0` opts out;
 *  - `---` between pages;
 *  - links BETWEEN included pages become in-document anchors; links out stay
 *    absolute URLs;
 *  - heading anchors deduplicated across the WHOLE assembled document;
 *  - 200 pages / ~5 MB, with an explicit truncation marker — never silent.
 *
 * Boards and data tables have no markdown body at all; `pageSourceMarkdown`
 * is the single place that knows how each of the three page kinds becomes
 * markdown (see boardText.ts and tableMarkdown.ts for those two).
 *
 * Parsing depth, deliberate: this module scans LINES with fenced-code
 * awareness and uses the same pragmatic `[text](href)` regex the rest of the
 * server already uses for markdown (see server/links.ts's own note). A full
 * CommonMark round-trip would change the bytes of a document whose whole
 * point is being the unrendered source.
 */
import * as collab from '../collab.js';
import * as storage from '../storage.js';
import type { PageIndexEntry } from '../storage.js';
import { officeFormat } from '../../shared/contracts.js';
import { boardStructureYaml } from './boardText.js';
import type { CollectedSubtree, ExportPage } from './collect.js';
import { byteLength, bytesTruncation, MAX_EXPORT_BYTES, truncationMarkerComment, type ExportTruncation } from './limits.js';
import { tableDocToMarkdown } from './tableMarkdown.js';

// ---------------------------------------------------------------------------
// Line scanning (fenced-code aware)
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Runs `fn` over every line, telling it whether that line is inside a fenced
 * code block. Same fence bookkeeping storage.ts's findH1LineIndex does — a
 * `# comment` inside a shell snippet is not a heading, and a `[x](y)` inside
 * a code sample is not a link to rewrite.
 */
function mapLines(text: string, fn: (line: string, inFence: boolean) => string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const m = FENCE_RE.exec(line);
      if (m) {
        if (fence === null) {
          fence = m[1][0];
          return fn(line, true);
        }
        if (m[1][0] === fence) {
          fence = null;
          return fn(line, true);
        }
      }
      return fn(line, fence !== null);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Heading anchors
// ---------------------------------------------------------------------------

/** Heading text with inline markdown stripped, so the slug matches what a reader sees. */
export function headingPlainText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, '') // closing ATX hashes
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images -> their text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_]{1,3}/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** GitHub-flavoured heading slug: lowercase, punctuation dropped, spaces to hyphens. Unicode-safe (uk/ru headings must work). */
export function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .replace(/\s+/g, '-');
  return slug || 'section';
}

/**
 * A slug that is free across the WHOLE assembled document. GitHub's own
 * convention (`slug`, `slug-1`, `slug-2`), and every produced value is
 * registered so a literal heading that happens to spell "Foo 1" can never
 * collide with the dedup form of a second "Foo".
 */
function claimAnchor(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 1; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

interface HeadingPass {
  body: string;
  /** natural slug (as this page alone would produce) -> the anchor it actually got in the assembled document */
  anchors: Map<string, string>;
  /** anchor of this page's first heading, i.e. where a link to this page should land */
  firstAnchor?: string;
}

/**
 * Demotes every ATX heading by `demoteBy` levels (capped at H6) and claims a
 * document-unique anchor for each.
 *
 * When a heading's natural anchor was already taken, an explicit
 * `<a id="..."></a>` is emitted just above it — you cannot change a
 * markdown heading's implicit anchor without changing the words the reader
 * sees, so the deduplicated anchor has to be made real some other way. The
 * blank line between the two is required: an HTML block glued straight onto
 * the next line would swallow the heading.
 */
function processHeadings(body: string, demoteBy: number, taken: Set<string>): HeadingPass {
  const anchors = new Map<string, string>();
  let firstAnchor: string | undefined;

  const out = mapLines(body, (line, inFence) => {
    if (inFence) return line;
    const m = ATX_RE.exec(line);
    if (!m) return line;

    const level = Math.min(6, m[1].length + demoteBy);
    const text = m[2];
    const natural = slugifyHeading(headingPlainText(text));
    const final = claimAnchor(natural, taken);
    if (!anchors.has(natural)) anchors.set(natural, final);
    if (firstAnchor === undefined) firstAnchor = final;

    const heading = `${'#'.repeat(level)} ${text}`;
    return final === natural ? heading : `<a id="${final}"></a>\n\n${heading}`;
  });

  return { body: out, anchors, firstAnchor };
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

/** Same ".." collapsing as server/links.ts's resolveRelative — never throws; an escaping path yields null. */
function resolveRelative(baseDir: string, href: string): string | null {
  const segments = baseDir ? baseDir.split('/') : [];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return segments.join('/');
}

function posixParent(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Appends `share=<token>` to a `/files/...` URL so a guest holding the link can actually fetch the asset. */
function withShare(url: string, shareToken: string | undefined): string {
  if (!shareToken) return url;
  const hashIdx = url.indexOf('#');
  const frag = hashIdx === -1 ? '' : url.slice(hashIdx);
  const bare = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const sep = bare.includes('?') ? '&' : '?';
  return `${bare}${sep}share=${encodeURIComponent(shareToken)}${frag}`;
}

interface IncludedPage {
  anchor: string;
  anchors: Map<string, string>;
}

interface RewriteCtx {
  baseUrl: string;
  space: string;
  /** directory of the page whose body is being rewritten */
  dirPath: string;
  /** relPath -> page id, for the whole space */
  idByPath: Map<string, string>;
  /** page id -> its in-document anchors, for pages included in THIS export */
  included: Map<string, IncludedPage>;
  /** this page's own natural-slug -> final-anchor map, for same-page `#fragment` links */
  ownAnchors: Map<string, string>;
  shareToken?: string;
}

/** `notes/x.md` -> the page id it names, honouring the same directory-style fallbacks server/links.ts uses. */
function pageIdForPath(resolved: string, idByPath: Map<string, string>): string | undefined {
  const direct = idByPath.get(resolved);
  if (direct) return direct;
  if (/\.md$/i.test(resolved)) return undefined;
  return idByPath.get(resolved ? `${resolved}/index.md` : 'index.md') ?? idByPath.get(resolved ? `${resolved}/README.md` : 'README.md');
}

export function rewriteHref(hrefRaw: string, ctx: RewriteCtx): string {
  const href = hrefRaw.trim();
  if (!href) return hrefRaw;

  // Pure in-page fragment: follow this page's own (possibly deduplicated) anchors.
  if (href.startsWith('#')) {
    const mapped = ctx.ownAnchors.get(slugifyHeading(decodeURIComponent(href.slice(1))));
    return mapped ? `#${mapped}` : href;
  }
  if (href.startsWith('//')) return href; // protocol-relative — already absolute enough
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href; // http:, mailto:, data:, ...
  if (href.startsWith('/')) return withShare(`${ctx.baseUrl}${href}`, href.startsWith('/files/') ? ctx.shareToken : undefined);

  const hashIdx = href.indexOf('#');
  const frag = hashIdx === -1 ? '' : href.slice(hashIdx);
  const beforeFrag = hashIdx === -1 ? href : href.slice(0, hashIdx);
  const qIdx = beforeFrag.indexOf('?');
  const queryPart = qIdx === -1 ? '' : beforeFrag.slice(qIdx);
  const pathPart = qIdx === -1 ? beforeFrag : beforeFrag.slice(0, qIdx);
  if (!pathPart) return frag ? rewriteHref(frag, ctx) : hrefRaw;

  const resolved = resolveRelative(ctx.dirPath, decodeURI(pathPart));
  if (resolved === null) return hrefRaw; // escapes the space root — leave it alone rather than invent a target

  const pageId = pageIdForPath(resolved, ctx.idByPath);
  if (pageId) {
    const inDoc = ctx.included.get(pageId);
    if (inDoc) {
      // A link between two pages of THIS document becomes an in-document anchor.
      if (frag) {
        const mapped = inDoc.anchors.get(slugifyHeading(decodeURIComponent(frag.slice(1))));
        if (mapped) return `#${mapped}`;
      }
      return `#${inDoc.anchor}`;
    }
    return `${ctx.baseUrl}/s/${ctx.space}/p/${pageId}${frag}`;
  }

  // Asset (or a broken .md link): the file route, absolute, share-token-aware.
  return withShare(`${ctx.baseUrl}/files/${ctx.space}/${resolved}${queryPart}${frag}`, ctx.shareToken);
}

const INLINE_LINK_RE = /(!?)\[((?:[^\][\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()]*\)[^()\s]*)*)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)\s*\)/g;
const REF_DEF_RE = /^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$/;

/** Rewrites every inline link/image and every reference definition outside fenced code. */
export function rewriteLinks(body: string, ctx: RewriteCtx): string {
  return mapLines(body, (line, inFence) => {
    if (inFence) return line;

    const ref = REF_DEF_RE.exec(line);
    if (ref) return `${ref[1]}${rewriteHref(ref[2], ctx)}${ref[3]}`;

    return line.replace(INLINE_LINK_RE, (whole, bang: string, text: string, href: string, title: string) => {
      const angled = href.startsWith('<') && href.endsWith('>');
      const bare = angled ? href.slice(1, -1) : href;
      const next = rewriteHref(bare, ctx);
      if (next === bare) return whole;
      return `${bang}[${text}](${angled ? `<${next}>` : next}${title})`;
    });
  });
}

// ---------------------------------------------------------------------------
// One page -> markdown
// ---------------------------------------------------------------------------

export interface PageSourceOptions {
  baseUrl: string;
  /**
   * Round 23 follow-up (owner): the structure extracted from a whiteboard's
   * scene is needed ONLY by a machine reader — export to MD and the Markdown
   * link for an agent, where a picture is useless. In PDF and DOCX the board
   * is drawn anyway, and a copy of its structure below is just noise on the
   * page. So those two formats ask for `boardText: false`, and MD keeps the default.
   */
  boardText?: boolean;
  shareToken?: string;
  tableViewId?: string;
  currentUser?: string;
  now?: Date;
}

export interface PageSource {
  markdown: string;
  /** Set when the page itself had to be cut (a table over the row cap). */
  truncation: ExportTruncation | null;
}

/**
 * The markdown for ONE page, whatever its kind. No frontmatter, ever.
 *
 * A live doc is read from the CRDT rather than from disk, exactly the way
 * the existing public share route does it — otherwise an agent curl'ing the
 * md link while someone is typing gets the last autosave instead of what is
 * on screen.
 */
export async function pageSourceMarkdown(entry: PageIndexEntry, opts: PageSourceOptions): Promise<PageSource> {
  if (entry.kind === 'board') {
    const svg = await storage.readBoardSvg(entry.id);
    const url = withShare(`${opts.baseUrl}/files/${entry.space}/${entry.relPath}`, opts.shareToken);
    const parts = [`# ${entry.title}`, `![${entry.title}](${url})`];
    // An empty (or unreadable) scene still exports as its picture — the board
    // must never be the reason an export fails. R23 addendum 3's own test.
    // Follow-up (owner): the agent needs STRUCTURE, not a flat caption list —
    // see boardText.ts's module doc for the YAML schema.
    const structureYaml = opts.boardText === false ? null : boardStructureYaml(svg);
    if (structureYaml) parts.push('**Board structure:**', `\`\`\`yaml\n${structureYaml}\n\`\`\``);
    return { markdown: parts.join('\n\n'), truncation: null };
  }

  if (entry.kind === 'pdf' || entry.kind === 'office') {
    // No text content to export (see storage.ts's Binary page files module
    // doc comment) — a link to the file, same `/files/` URL shape the board
    // branch above embeds its image from, is the best a text/markdown
    // export can offer.
    const ext = entry.kind === 'pdf' ? 'pdf' : (officeFormat(entry.relPath) ?? 'pdf');
    const url = withShare(`${opts.baseUrl}/files/${entry.space}/${entry.relPath}`, opts.shareToken);
    return { markdown: `# ${entry.title}\n\n[${entry.title}.${ext}](${url})`, truncation: null };
  }

  if (entry.kind === 'table') {
    const doc = await storage.readFreshTableDoc(entry.id);
    const { markdown, truncation } = tableDocToMarkdown(doc, {
      viewId: opts.tableViewId,
      currentUser: opts.currentUser,
      now: opts.now,
    });
    const withHeading = storage.extractH1(doc.head) ? markdown : `# ${entry.title}\n\n${markdown}`;
    return { markdown: withHeading, truncation };
  }

  const live = collab.isDocLive(entry.id) ? collab.getLiveText(entry.id) : undefined;
  const body = live ?? (entry.kind === 'doc' ? await storage.readFreshDocBody(entry.id) : (entry.body ?? ''));
  return { markdown: body, truncation: null };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  /** Absolute prod base, no trailing slash (see server/publicUrl.ts). */
  baseUrl: string;
  /** false for PDF/DOCX — see PageSourceOptions.boardText for why. */
  boardText?: boolean;
  /** Default true — demote child headings by depth. `flatten=0` passes false. */
  flatten?: boolean;
  /** Present for the share md route: keeps `/files/...` URLs fetchable by whoever holds the link. */
  shareToken?: string;
  tableViewId?: string;
  currentUser?: string;
  now?: Date;
  /** Overridable so the byte cap is testable without a 5 MB fixture; production takes the default. */
  maxBytes?: number;
}

export interface AssembledExport {
  markdown: string;
  truncation: ExportTruncation | null;
  /** Pages actually included (after both caps). */
  pageCount: number;
}

const SEPARATOR = '\n\n---\n\n';

interface StagedSection {
  page: ExportPage;
  body: string;
  anchors: Map<string, string>;
  anchor: string;
}

/**
 * Collated markdown for `collected`, ready to serve.
 *
 * Two passes, and the split matters: pass 1 decides which pages FIT (both
 * caps) and claims every anchor, pass 2 rewrites links now that "is this
 * target in the document?" has a final answer. Rewriting during pass 1 would
 * turn a link to a page that later gets cut by the byte cap into a dangling
 * `#anchor` instead of a working absolute URL.
 */
export async function assembleMarkdown(collected: CollectedSubtree, opts: AssembleOptions): Promise<AssembledExport> {
  const { pages } = collected;
  const root = pages[0];
  const space = root.entry.space;
  const flatten = opts.flatten !== false;
  const collating = pages.length > 1;

  const idByPath = new Map((await storage.listEntries(space)).map((e) => [e.relPath, e.id]));

  const taken = new Set<string>();
  const staged: StagedSection[] = [];
  let truncation: ExportTruncation | null = collected.truncation;
  let bytes = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const source = await pageSourceMarkdown(page.entry, {
      baseUrl: opts.baseUrl,
      boardText: opts.boardText,
      shareToken: opts.shareToken,
      tableViewId: opts.tableViewId,
      currentUser: opts.currentUser,
      now: opts.now,
    });
    if (source.truncation && !truncation) truncation = source.truncation;

    // A page with no heading of its own would land in the collation as an
    // untitled slab; give it the title the tree shows. Single-page exports are
    // left byte-for-byte as the source (spec: "we render nothing").
    let raw = source.markdown;
    if (collating && !storage.extractH1(raw)) raw = `# ${page.entry.title}\n\n${raw}`;

    const pass = processHeadings(raw, flatten ? page.depth : 0, taken);
    const anchor = pass.firstAnchor ?? claimAnchor(slugifyHeading(page.entry.title), taken);
    const body = pass.firstAnchor ? pass.body : `<a id="${anchor}"></a>\n\n${pass.body}`;

    // Byte cap. The root page always goes in whole — cutting the very page
    // that was asked for would be a worse answer than a slightly oversized
    // one, and a 5 MB single markdown file is not a real shape. Every
    // SUBSEQUENT page is checked, and the moment one doesn't fit the
    // collation stops with an explicit marker.
    const cost = byteLength(body) + (staged.length > 0 ? SEPARATOR.length : 0);
    if (staged.length > 0 && bytes + cost > (opts.maxBytes ?? MAX_EXPORT_BYTES)) {
      if (!truncation) truncation = bytesTruncation(pages.length - i);
      break;
    }
    bytes += cost;
    staged.push({ page, body, anchors: pass.anchors, anchor });
  }

  const included = new Map<string, IncludedPage>(staged.map((s) => [s.page.entry.id, { anchor: s.anchor, anchors: s.anchors }]));

  const sections = staged.map((s) =>
    rewriteLinks(s.body, {
      baseUrl: opts.baseUrl,
      space,
      dirPath: posixParent(s.page.entry.relPath),
      idByPath,
      included,
      ownAnchors: s.anchors,
      shareToken: opts.shareToken,
    }).trim(),
  );

  // The marker goes FIRST, not last: an agent that stops reading a large
  // document part-way through still sees that it is looking at a cut export.
  const body = sections.join(SEPARATOR);
  const markdown = `${truncation ? `${truncationMarkerComment(truncation)}\n\n${body}` : body}\n`;

  return { markdown, truncation, pageCount: staged.length };
}
