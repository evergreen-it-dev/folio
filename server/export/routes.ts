/**
 * Round 23 (export) route registration — PDF/DOCX/MD export, the agent-facing
 * `GET /share/:token.md`, includeChildren subtree collation. See DEV-PLAN's
 * "R23" section for the full normative spec. Registered once, by the
 * orchestrator, from server/index.ts so server/routes.ts itself stays
 * untouched by this round.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { badRequest, notFound } from '../errors.js';
import { publicUrlOrOrigin } from '../publicUrl.js';
import * as session from '../auth/session.js';
import * as gitSync from '../gitSync.js';
import type { PageIndexEntry } from '../storage.js';
import { officeFormat } from '../../shared/contracts.js';
import { queryString } from '../validate.js';
import { collectForExport } from './collect.js';
import { inlineTemplateImages, readSpaceExportSettings, validateExportSettingsBody, writeSpaceExportSettings } from './spaceSettings.js';
import type { ExportTruncation } from './limits.js';
import { assembleMarkdown, type AssembledExport } from './markdown.js';
import { buildPrintHtml, consumePrintTicket, issuePrintTicket, PRINT_TICKET_TTL_MS } from './print.js';
import { isChromiumAvailable, renderPdf } from './pdf.js';
import { resolveShareScope } from './shareScope.js';
import { assembleYaml } from './yaml.js';

/** Same origin computation server/routes.ts uses, so an export's links match a share link's. */
function requestBaseUrl(request: FastifyRequest): string {
  return publicUrlOrOrigin(`${request.protocol}://${request.hostname}`);
}

/** `notes/plan.md` -> `plan`, `notes/board.excalidraw.svg` -> `board`, `notes/t.table.md` -> `t`. */
export function slugOf(entry: PageIndexEntry): string {
  const base = entry.relPath.slice(entry.relPath.lastIndexOf('/') + 1);
  if (entry.kind === 'board') return base.slice(0, -'.excalidraw.svg'.length);
  if (entry.kind === 'table') return base.slice(0, -'.table.md'.length);
  if (entry.kind === 'pdf') return base.slice(0, -'.pdf'.length);
  if (entry.kind === 'office') {
    const fmt = officeFormat(entry.relPath);
    return fmt ? base.slice(0, -(fmt.length + 1)) : base;
  }
  const stem = base.replace(/\.md$/i, '');
  /**
   * Round 23 follow-up (owner: "the file must not be named index.pdf"): the
   * file of a directory page is called `index.md`, so the stem is "index",
   * the same for EVERY such export. Its meaningful name is the directory's.
   * The root of a space has no directory above it; there the space slug stays.
   */
  if (entry.isIndex && stem === 'index') {
    // lastIndexOf === -1 for the root `index.md`: slice(0, -1) would cut the
    // last character and return "index.m" (caught by a test), so the "no
    // slash at all" case is handled explicitly.
    const cut = entry.relPath.lastIndexOf('/');
    const dir = cut === -1 ? '' : entry.relPath.slice(0, cut);
    const dirName = dir.slice(dir.lastIndexOf('/') + 1);
    return dirName || entry.space;
  }
  return stem;
}

/**
 * Non-ASCII filenames (uk/ru titles are the norm here) break Node outright on
 * a raw header value — same ASCII-fallback + RFC 5987 pair the public asset
 * route in server/index.ts already uses.
 */
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'export';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * The "field in API responses" half of the truncation contract (the other
 * half is the HTML comment inside the markdown itself). These endpoints
 * return a file, not JSON, so the structured signal is a header — always
 * present, never silent.
 */
function setExportHeaders(reply: FastifyReply, pageCount: number, truncation: ExportTruncation | null): void {
  reply.header('X-Folio-Export-Pages', String(pageCount));
  reply.header('X-Folio-Export-Truncated', truncation ? truncation.reason : 'false');
  if (truncation) reply.header('X-Folio-Export-Truncation-Detail', truncation.message.replace(/[^\x20-\x7e]/g, '_'));
}

/** `?children=1` / `?flatten=0` — absent means the default. */
function boolParam(request: FastifyRequest, key: string, fallback: boolean): boolean {
  const raw = queryString(request.query, key);
  if (raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

interface ExportRequest {
  entry: PageIndexEntry;
  assembled: AssembledExport;
}

/**
 * `allowed` is the CEILING (what the caller's rights permit at all),
 * `fallback` is what an absent `?children=` means. Keeping them separate is
 * what makes `?children=1` unable to widen a single-page share token while
 * still letting an authorized user opt in per request.
 */
interface ChildrenPolicy {
  allowed: boolean;
  fallback: boolean;
}

async function buildExport(
  request: FastifyRequest,
  entry: PageIndexEntry,
  policy: ChildrenPolicy,
  shareToken?: string,
  /** false for PDF/DOCX — see PageSourceOptions.boardText. */
  boardText = true,
): Promise<ExportRequest> {
  const includeChildren = boolParam(request, 'children', policy.fallback) && policy.allowed;
  const allowed = request.authUser ? await session.readablePageIds(request.authUser, entry.space) : undefined;
  const collected = await collectForExport(entry, includeChildren, undefined, allowed);
  const assembled = await assembleMarkdown(collected, {
    boardText,
    baseUrl: requestBaseUrl(request),
    flatten: boolParam(request, 'flatten', true),
    shareToken,
    tableViewId: queryString(request.query, 'view') || undefined,
    currentUser: request.authUser?.email,
  });
  return { entry, assembled };
}

/** Session-authenticated callers may opt into the subtree, but never get it implicitly. */
const AUTHENTICATED_CHILDREN: ChildrenPolicy = { allowed: true, fallback: false };

export function registerExportRoutes(app: FastifyInstance): void {
  // --- Stage 1: markdown -----------------------------------------------------
  app.get('/api/pages/:id/export.md', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    // A session-authenticated export may always ask for the subtree — the
    // caller's own role is what bounds it, and a subtree never crosses into
    // another space (collect.ts). It is still OPT-IN: `includeChildren`
    // defaults to false everywhere in this round, so `GET .../export.md` with
    // no query means exactly the one page, same as before R23.
    const { assembled } = await buildExport(request, entry, AUTHENTICATED_CHILDREN);

    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', contentDisposition('attachment', `${slugOf(entry)}.md`));
    setExportHeaders(reply, assembled.pageCount, assembled.truncation);
    return reply.send(assembled.markdown);
  });

  // --- Stage 2: PDF ----------------------------------------------------------
  app.get('/api/pages/:id/export.pdf', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (!(await isChromiumAvailable())) {
      throw badRequest('PDF export is unavailable: no chromium executable found (set CHROMIUM_PATH)');
    }
    const { assembled } = await buildExport(request, entry, AUTHENTICATED_CHILDREN, undefined, false);
    const pdf = await renderPdf({
      markdown: assembled.markdown,
      entry,
      baseUrl: requestBaseUrl(request),
      landscape: boolParam(request, 'landscape', false),
    });

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', contentDisposition('attachment', `${slugOf(entry)}.pdf`));
    setExportHeaders(reply, assembled.pageCount, assembled.truncation);
    return reply.send(pdf);
  });

  // --- Stage 3: DOCX ---------------------------------------------------------
  app.get('/api/pages/:id/export.docx', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const { assembled } = await buildExport(request, entry, AUTHENTICATED_CHILDREN);
    // Lazily imported: the `docx` library is only needed by this one route, and
    // a Stage-1-only deployment should not pay for it at boot.
    const { renderDocx } = await import('./docx.js');
    const docx = await renderDocx({ markdown: assembled.markdown, entry, baseUrl: requestBaseUrl(request) });

    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    reply.header('Content-Disposition', contentDisposition('attachment', `${slugOf(entry)}.docx`));
    setExportHeaders(reply, assembled.pageCount, assembled.truncation);
    return reply.send(docx);
  });

  // --- Stage 4: YAML (owner follow-up — a first-class format alongside
  // MD/PDF/DOCX; see yaml.ts's module doc for the per-kind shapes and the
  // includeChildren scoping decision) ------------------------------------
  app.get('/api/pages/:id/export.yaml', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const includeChildren = boolParam(request, 'children', AUTHENTICATED_CHILDREN.fallback) && AUTHENTICATED_CHILDREN.allowed;
    const collected = await collectForExport(entry, includeChildren, undefined, await session.readablePageIds(request.authUser!, entry.space));
    const assembled = await assembleYaml(collected, {
      baseUrl: requestBaseUrl(request),
      flatten: boolParam(request, 'flatten', true),
      tableViewId: queryString(request.query, 'view') || undefined,
      currentUser: request.authUser?.email,
    });

    reply.header('Content-Type', 'application/yaml; charset=utf-8');
    reply.header('Content-Disposition', contentDisposition('attachment', `${slugOf(entry)}.yaml`));
    setExportHeaders(reply, assembled.pageCount, assembled.truncation);
    return reply.send(assembled.yaml);
  });

  /**
   * The private print route (DEV-PLAN: "a private print route ... access by
   * a short-lived token or by an internal request"). Our own PDF path takes
   * the INTERNAL option — it feeds the same HTML straight into the browser
   * page (see print.ts's module doc for why) — so this route exists for the
   * other two consumers the spec implies: inspecting the exact document
   * chromium is handed, and handing a preview UI or an out-of-process
   * renderer a URL it can fetch. `?ticket=1` is that second case: it mints
   * the short-lived, single-use ticket instead of returning the HTML inline.
   */
  app.get('/api/pages/:id/print', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const { assembled } = await buildExport(request, entry, AUTHENTICATED_CHILDREN);
    const html = await buildPrintHtml({ markdown: assembled.markdown, entry, baseUrl: requestBaseUrl(request) });

    if (boolParam(request, 'ticket', false)) {
      const ticket = issuePrintTicket(html);
      return { url: `${requestBaseUrl(request)}/api/export/print/${ticket}`, expiresInSeconds: PRINT_TICKET_TTL_MS / 1000 };
    }

    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('X-Robots-Tag', 'noindex');
    return reply.send(html);
  });

  /**
   * R23 tail (headers and footers) — the space-level PDF header/footer templates
   * print.ts already renders. Admin of the SPACE ITSELF (requireSpaceRole
   * 'admin'), deliberately not canAdministerSpace: these land in the space's
   * git repo as content (`<slug>.folio`), and round 27's line is that an
   * instance admin without a membership administers ACCESS, never writes
   * content. GET returns the raw stored templates (sanitization is css.ts's
   * render-time job — the editor must show what was saved, not a rewrite).
   */
  app.get('/api/spaces/:space/export-settings', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    return readSpaceExportSettings(space);
  });

  app.put('/api/spaces/:space/export-settings', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    session.requireWriteScope(request);
    const settings = validateExportSettingsBody(request.body);
    // Owner follow-up: external <img src> in the templates are downloaded and
    // inlined as data: URIs here, BEFORE the write — see spaceSettings.ts's
    // inlineTemplateImages / headerFooterImages.ts for the SSRF gateway this
    // goes through. A failed fetch throws (400), same as a validation error.
    const withImages = await inlineTemplateImages(settings);
    // Same write-back shape as any other content edit: the file change rides
    // the standard debounced auto-commit, attributed to the caller.
    gitSync.recordEditor(space, { name: request.authUser!.name, email: request.authUser!.email });
    await writeSpaceExportSettings(space, withImages);
    gitSync.noteActivity(space);
    return readSpaceExportSettings(space);
  });
}

/**
 * `GET /share/:token.md` is unauthenticated (same trust boundary as the
 * existing public share routes), so it's registered separately, outside
 * protectedScope — mirrors registerPublicShareRoutes in server/routes.ts.
 */
export function registerPublicExportRoutes(app: FastifyInstance): void {
  /**
   * The agent link. READ ONLY, by construction: this is the only handler
   * registered on the path and it is a GET, so an `edit` token buys exactly
   * nothing extra here (a PUT/POST to the same URL matches no route at all).
   * A revoked token breaks it instantly — resolveShareScope returns undefined
   * for revoked and unknown alike, and both 404 the same way.
   */
  app.get('/share/:token.md', async (request, reply) => {
    const { token } = request.params as { token: string };
    const scope = await resolveShareScope(token);
    if (!scope) throw notFound('share link');

    // Within the token's rights only: `?children=0` narrows a subtree token to
    // the single page; `?children=1` on a single-page token stays single-page.
    const includeChildren = boolParam(request, 'children', true) && scope.share.includeChildren;
    const collected = await collectForExport(scope.root, includeChildren);
    const assembled = await assembleMarkdown(collected, {
      baseUrl: requestBaseUrl(request),
      flatten: boolParam(request, 'flatten', true),
      shareToken: token,
    });

    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    // Not for search engines — this is "unlisted", exactly like GET /api/share/:token.
    reply.header('X-Robots-Tag', 'noindex');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Disposition', contentDisposition('inline', `${slugOf(scope.root)}.md`));
    setExportHeaders(reply, assembled.pageCount, assembled.truncation);
    return reply.send(assembled.markdown);
  });

  /**
   * Short-lived, single-use print ticket (see print.ts). Public scope on
   * purpose: the ticket IS the credential, it lives in memory only, it is
   * good for one fetch inside 60 seconds, and it is minted only by an
   * already-authorized export.
   */
  app.get('/api/export/print/:ticket', async (request, reply) => {
    const { ticket } = request.params as { ticket: string };
    const html = consumePrintTicket(ticket);
    if (!html) throw notFound('print ticket');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('X-Robots-Tag', 'noindex');
    reply.header('Cache-Control', 'no-store');
    return reply.send(html);
  });
}
