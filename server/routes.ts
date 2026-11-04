import { z } from 'zod';
import { setArtifactTitleIcon } from './artifact/service.js';
import * as fsSync from 'node:fs';
import { posix as pathPosix } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  canvasConvertBodySchema,
  acceptInviteBodySchema,
  createInviteBodySchema,
  createPageBodySchema,
  createShareLinkBodySchema,
  updateShareLinkBodySchema,
  updateSpaceAssetModeBodySchema,
  updateScanSettingsBodySchema,
  createSpaceGit,
  resolveGitConflictBody,
  connectSpaceGitBodySchema,
  copyPageBodySchema,
  duplicatePageBodySchema,
  createBlankTemplateBodySchema,
  createFromTemplateBodySchema,
  makeTemplateBodySchema,
  listBranchesBodySchema,
  movePageBodySchema,
  renamePageBodySchema,
  updatePageAccessBodySchema,
  updatePageBodySchema,
  validateRecentPagesBodySchema,
  AGENT_FOLDER,
  officeFormat,
} from '../shared/contracts.js';
import { isFormParseError, parseFormFile } from '../shared/forms/index.js';
import type {
  CanvasConversionReport,
  CanvasConvertResult,
  CanvasPayload,
  AuthState,
  EmbedPayload,
  FolioConfig,
  GitProviderRepos,
  GitRepoTreeResponse,
  InviteInfo,
  InvitePublicInfo,
  PageDoc,
  PageHistoryEntry,
  PageMeta,
  RepoBranches,
  ReplaceFilePageResponse,
  SearchHit,
  ShareLinkInfo,
  SharedPagePayload,
  PublicPageLinks,
  PageLinkRef,
  SpaceInfo,
  SpaceWithVaultNote,
  SpaceRole,
  UploadAssetResponse,
  SpaceVisibility,
  SpaceGitInfo,
  ResetToRemoteResponse,
  ResolveGitConflictResponse,
  TreeNode,
  PageMetadata,
  SpaceTagsResponse,
  TemplateListItem,
  GraphResponse,
  UnresolvedLinksResponse,
  OrphansResponse,
} from '../shared/contracts.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import { decodeScenePayload, extractScenePayload } from './confluenceWhiteboard.js';
import * as tables from './tables/service.js';
import * as forms from './forms/service.js';
import { clampSearchLimit, clampSearchOffset, searchPages } from './search.js';
import { buildPageDoc } from './pageDoc.js';
import { publicUrlOrOrigin } from './publicUrl.js';
import { buildCanvasPayload } from './canvasView.js';
import { canvasConversionReport, convertCanvasPage } from './canvasToBoard.js';
import { buildEmbed, parseEmbedDepth } from './embed.js';
import * as indexRead from './indexV2/read.js';
import * as graph from './graph.js';
import { userViewer } from './accessSql.js';
import * as groupRoutes from './groups/routes.js';
import * as assets from './assets.js';
import * as git from './git.js';
import * as gitSync from './gitSync.js';
import { inspectFilePageUpload, replaceFilePage, restoreFilePageVersion } from './filePages.js';
import { startPeriodicFetchForSpace } from './gitSync.js';
import * as gitTree from './gitTree.js';
import { GitTreePathNotFoundError } from './gitTree.js';
import * as shares from './shares.js';
import { resolveShareScope } from './export/shareScope.js';
import { shareMayReadFile } from './fileAccess.js';
import { subtreeFromCollected } from './export/collect.js';
import * as invites from './invites.js';
import * as confluenceImport from './confluenceImport.js';
import { recordAudit } from './audit.js';
import { badRequest, conflict, forbidden, gone, notFound, tooManyRequests } from './errors.js';
import { resolveTextLanguage } from './serverText.js';
import { createStarterWritingRules } from './writingRules.js';
import { parseBody, queryString } from './validate.js';
import * as session from './auth/session.js';
import { assertDemoAgentRootIntact, assertNotDemo, assertNotDemoAccount } from './demo.js';
import * as authStore from './auth/store.js';
import { hashPassword } from './auth/passwords.js';
import { ssoState } from './auth/routes.js';
import { ssoRequired, toPublicProvider } from './auth/oidc.js';
import * as authProviders from './auth/providers.js';
import * as userGitCredentials from './userGitCredentials.js';
import * as gitProviders from './gitProviders.js';
import { buildSpaceZip } from './export/spaceZip.js';
import * as importProgress from './spaceImportProgress.js';
import * as pageAccess from './pageAccess.js';
import { liveCopyContent, resolveCopyScope } from './copyScope.js';
import { clearTemplateDescription, setTemplateDescription } from './templateMeta.js';
import { findTrashItemId, recordPageChange, snapshotPageChange } from './pageChanges.js';
import * as bootScan from './bootScan.js';
import { isGitHubConnectEnabled } from './auth/githubConnect.js';
import { parseBaseConfig } from '../shared/bases/parse.js';

/** PUBLIC_URL is normally set; this is only the fallback when it's not (round 8: "URL built from PUBLIC_URL, fallback request origin"). */
function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.hostname}`;
}

/**
 * Round 29: the shape every board write on this file funnels through — the
 * authenticated PUT below, the share-link edit PUT, and restore-to-sha. A
 * live collab room is authoritative when one is open (an editor with the tab
 * open, or a guest connected through an edit-mode share — both open the SAME
 * /collab room, see collab.ts's attachToServer): route the incoming svg's
 * scene through collab.editBoardScene so the open room (and everyone in it)
 * sees the write immediately, instead of writing straight to the file and
 * leaving the live room to silently diverge from what's now on disk. No live
 * room -> the original direct file write, `force` and all.
 *
 * Deliberately does NOT thread `force` through the live-room path:
 * editBoardScene's blank-overwrite guard is the same one writeBoardSvg has
 * always had, and this round's whole point is that guard must stay active
 * on every board write path, not just the disk-direct one.
 */
async function writeBoardSvgLiveAware(id: string, svg: string, force: boolean): Promise<PageMeta> {
  if (!collab.isLiveBoard(id)) return storage.writeBoardSvg(id, svg, force);
  const payload = extractScenePayload(svg);
  if (!payload) throw badRequest('no embedded excalidraw scene payload found');
  let scene;
  try {
    scene = decodeScenePayload(payload);
  } catch (err) {
    throw badRequest(`failed to decode scene payload: ${err instanceof Error ? err.message : String(err)}`);
  }
  return collab.editBoardScene(id, scene);
}

/** One member entry as GET /api/admin/spaces reports it — flat (userId/name/email/username?/role), NOT the nested {user, role} shape SpaceMemberInfo uses for the existing members dialog. No shared/contracts.ts type for either shape of this endpoint yet — see the SERVER-round-22 report for what to add there. */
export interface AdminSpaceMember {
  userId: string;
  name: string;
  email: string;
  username?: string;
  role: SpaceRole;
}

/** One space as GET /api/admin/spaces reports it. The route returns a BARE ARRAY of these (no {spaces:...} wrapper) — matches what the SHELL-side admin/spaces page was already built against. */
export interface AdminSpaceInfo {
  slug: string;
  name: string;
  /** 'remote' iff the space has an `origin` configured (SpaceInfo.git.repoUrl is set) — matches gitSync's own "has a remote at all" notion, not the current sync status. */
  kind: 'local' | 'remote';
  pageCount: number;
  members: AdminSpaceMember[];
  /** Round 27 (access and rights) point-edit, spec-access.md §8: this is metadata an instance-admin needs to manage access, not content, so /api/admin/spaces keeps working without a membership even though content routes no longer do. */
  visibility: SpaceVisibility;
  /** Round 27: members.filter(m => m.role === 'admin').length, precomputed so the UI can warn "this space has only one admin" without recomputing it client-side. */
  adminCount: number;
  git: SpaceGitInfo;
}

/** Exported (not just inline in the route below) so it's directly unit-testable without a Fastify app/HTTP layer — see server/routes.test.ts. */
export async function buildAdminSpacesList(): Promise<AdminSpaceInfo[]> {
  const spaces = await storage.listSpaces();
  const result: AdminSpaceInfo[] = [];
  for (const s of spaces) {
    const members = await authStore.listMembersWithDetails(s.slug);
    const flatMembers = members.map((m) => {
      const flat: AdminSpaceMember = { userId: m.user.id, name: m.user.name, email: m.user.email, role: m.role };
      if (m.user.username) flat.username = m.user.username;
      return flat;
    });
    // Round (conflicts must be visible): conflicts is only ever populated
    // while status === 'conflict' — see gitSync.getSpaceConflicts's own doc
    // comment for why that gate lives at the CALLER, here, rather than
    // inside it (this loop runs across every space on every admin-spaces
    // load; a `git grep` per space would be wasted work for the common
    // "nothing's conflicted" case).
    const baseGit: SpaceGitInfo = s.git!;
    const gitInfo: SpaceGitInfo = baseGit.status === 'conflict' ? { ...baseGit, conflicts: await gitSync.getSpaceConflicts(s.slug) } : baseGit;
    result.push({
      slug: s.slug,
      name: s.name,
      kind: s.git?.repoUrl ? 'remote' : 'local',
      pageCount: s.pageCount,
      members: flatMembers,
      visibility: s.visibility ?? 'private',
      adminCount: flatMembers.filter((m) => m.role === 'admin').length,
      git: gitInfo,
    });
  }
  return result;
}

/**
 * Body for POST /api/pages/:id/slug (round 22) — kept local rather than in shared/contracts.ts. Only the length is
 * bounded here: what a slug may hold depends on the page (a lowercase-ASCII slug for most pages, any valid file
 * name for a canvas / base — storage.renamePageSlug), and that check is authoritative and answers with a 400.
 */
const renamePageSlugBodySchema = z.object({
  slug: z.string().min(1).max(storage.MAX_SLUG_LENGTH * 4),
});

const renameSpaceBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
});

/**
 * Builds `SpaceInfo.agentRules` for one space (owner report, 22.09.2026: a
 * viewer had no sign that space rules even exist). `used`/`pages` go to
 * every member — `pages` is only ever a count, nothing from inside `.agent`
 * a non-admin isn't already allowed to know. `path` (the link target GET
 * /api/spaces's caller uses to open the section) is included ONLY when
 * `canAdminister` is true, same gate as canAdministerSpace elsewhere.
 * Pulled out as a pure function so the viewer-vs-admin shape is unit
 * testable without a running Fastify app or a DB — see routes.test.ts.
 */
export function buildAgentRulesInfo(pages: number, canAdminister: boolean, writingRules = false): NonNullable<SpaceInfo['agentRules']> {
  return { used: pages > 0, pages, ...(canAdminister ? { path: AGENT_FOLDER } : {}), ...(writingRules ? { writingRules: true } : {}) };
}

/**
 * Registered inside index.ts's protected scope (the onRequest hook there
 * already guarantees request.authUser is set before any of these run — see
 * requireSpaceRole/requirePageRole in auth/session.ts for the per-route
 * viewer/editor role checks layered on top of that blanket session guard).
 */
export function registerRoutes(app: FastifyInstance): void {
  // --- Config -----------------------------------------------------------

  /** Instance-wide config the client needs before it knows which space it's in. Any authenticated user (no space role check — this is instance-level, not space-scoped). */
  app.get('/api/config', async (): Promise<FolioConfig> => {
    return { defaultRepoUrl: process.env.FOLIO_DEFAULT_REPO_URL || null, githubOAuth: isGitHubConnectEnabled() };
  });

  /**
   * Accept an invite into the account behind the current browser session.
   * This lives in the protected scope (unlike new-account invite acceptance)
   * and explicitly rejects PATs: following a link in the browser is an
   * interactive account action. Existing stronger roles are never downgraded.
   */
  app.post('/api/invite/:token/accept-existing', async (request): Promise<AuthState> => {
    session.requireCookieAuth(request);
    const { token } = request.params as { token: string };
    const current = request.authUser!;

    const invite = await invites.getInviteByToken(token);
    const reason = invites.invalidReason(invite);
    if (reason || !invite) throw gone(`this invite is no longer valid (${reason ?? 'not_found'})`);
    if (invite.email && invite.email.trim().toLowerCase() !== current.email.toLowerCase()) {
      throw badRequest('this invite is pinned to a different email address');
    }

    const claimed = await invites.claimInviteUse(token);
    if (!claimed) throw gone('this invite is no longer valid (exhausted, revoked, or expired)');

    let user = current;
    if (claimed.isAdmin && !user.isAdmin) user = await authStore.updateUser(user.id, { isAdmin: true });
    for (const membership of claimed.memberships) {
      const existing = await authStore.getMembershipRole(membership.space, user.id);
      if (!session.roleAtLeast(existing, membership.role)) {
        await authStore.setMembership(membership.space, user.id, membership.role);
      }
    }
    await groupRoutes.joinInviteGroups(user.id, claimed.groupIds);

    recordAudit(user.id, 'invite.accepted', claimed.id, { email: user.email, existingUser: true });
    return {
      needsSetup: false,
      user,
      memberships: await session.membershipsFor(user),
      ...(await ssoState()),
    };
  });

  /** Lists a remote's branches without cloning it — feeds the create-space dialog's branch picker. Any authenticated user; not space-scoped (there's no space yet). */
  app.post('/api/git/branches', async (request): Promise<RepoBranches> => {
    assertNotDemo('Browsing a remote repository');
    const body = parseBody(listBranchesBodySchema, request.body);
    try {
      git.validateRepoUrl(body.repoUrl);
    } catch {
      throw badRequest('invalid repository URL');
    }
    const token = await userGitCredentials.resolveGitToken(request.authUser!.id, body.repoUrl, body.token);
    let raw: { branches: string[]; defaultBranch: string | null };
    try {
      raw = await git.listRemoteBranches(body.repoUrl, token);
    } catch {
      // Never echo git's own stderr (could reflect the url; never the token, since
      // that only ever travels via askpass, but stay conservative regardless) —
      // a short, fixed human message only.
      throw badRequest('could not list branches');
    }
    return { branches: raw.branches, defaultBranch: raw.defaultBranch, empty: raw.branches.length === 0 };
  });

  // Round 11: GET /api/git/repos?host=<host> — lists the caller's repos on a
  // provider using their OWN saved credential for that host (never a
  // caller-supplied token; this route only ever reads what's already saved).
  app.get('/api/git/repos', async (request): Promise<GitProviderRepos> => {
    assertNotDemo('Browsing a remote repository');
    const host = queryString(request.query, 'host');
    if (!host) throw badRequest('host is required');
    const cred = await userGitCredentials.getDecryptedTokenForHost(request.authUser!.id, host);
    if (!cred) throw notFound('a saved git credential for this host');
    try {
      return await gitProviders.listRepos(userGitCredentials.normalizeHost(host), cred.provider, cred.token);
    } catch (err) {
      // A provider failure (bad token, rate limit, SAML SSO, unreachable) is answered with a stable `code`
      // and a localized message instead of a silent empty list.
      if (err instanceof gitProviders.GitProviderError) {
        throw err.toLocalizedHttpError(resolveTextLanguage(request.authUser?.lang, request.headers['accept-language']));
      }
      throw err;
    }
  });

  // Round 19 point 6-api: GET /api/git/tree?credentialId=&repoUrl=&branch=&path=
  // — one level of a remote repo's directory tree, for the create-space
  // dialog's lazy rootPath picker (round 19 SHELL point 6-ux). No space yet
  // at this point — any authenticated user (same as /api/git/branches and
  // /api/git/repos above, neither of which is space-scoped either).
  // `credentialId` names a SPECIFIC saved credential (never a bare token in
  // the query string — see gitTree.ts's module doc comment) and must belong
  // to the caller, checked the exact same way DELETE /api/me/git-credentials/:id
  // does it (auth/routes.ts): a credential that exists but belongs to someone
  // else is indistinguishable from one that doesn't exist at all. Omitted
  // entirely -> falls back to the same host-based auto-token match POST
  // /api/spaces and POST /api/git/branches already use, so a public repo
  // (or one matching an auto-detected saved credential) still works.
  app.get('/api/git/tree', async (request): Promise<GitRepoTreeResponse> => {
    assertNotDemo('Browsing a remote repository');
    const repoUrl = queryString(request.query, 'repoUrl');
    const branch = queryString(request.query, 'branch');
    const path = queryString(request.query, 'path');
    const credentialId = queryString(request.query, 'credentialId');
    if (!repoUrl) throw badRequest('repoUrl is required');
    if (!branch) throw badRequest('branch is required');
    try {
      git.validateRepoUrl(repoUrl);
    } catch {
      throw badRequest('invalid repository URL');
    }

    let token: string | undefined;
    if (credentialId) {
      const cred = await userGitCredentials.getDecryptedTokenById(request.authUser!.id, credentialId);
      if (!cred) throw notFound('a saved git credential');
      token = cred.token;
    } else {
      token = await userGitCredentials.resolveGitToken(request.authUser!.id, repoUrl, undefined);
    }

    try {
      const dirs = await gitTree.listRepoTreeDirs(repoUrl, branch, path, token);
      // `.obsidian/` among the folders = this path is an Obsidian vault (the create-space dialog turns light footprint on for it).
      return dirs.includes('.obsidian') ? { dirs, vault: true } : { dirs };
    } catch (err) {
      if (err instanceof GitTreePathNotFoundError) throw notFound('path');
      // Never echo git's own stderr (could reflect the url; never the token,
      // since that only ever travels via askpass) — a short, fixed message,
      // same style as POST /api/git/branches above.
      throw badRequest('could not list directories (check the branch and access)');
    }
  });

  // --- Spaces ---------------------------------------------------------

  app.get('/api/spaces', async (request) => {
    const user = request.authUser!;
    const myRoles = await session.membershipsFor(user);
    const memberSpaces = (await storage.listSpaces()).filter((s) => s.slug in myRoles);
    // `.agent/**` rules (widened 22.09.2026 — owner report: a viewer had no
    // sign that space rules even exist). `used`/`pages` now go to EVERY
    // member — countAgentPages only ever returns a COUNT, never page
    // content/paths from inside `.agent`, so this leaks nothing the pages
    // themselves don't already leak by existing. `path` (the link target)
    // stays admin-only: same rule as canAdministerSpace (instance admin, or
    // an explicit 'admin' membership row; membershipsFor's implicit
    // instance-visibility grant never reaches 'admin', so this check alone
    // is equivalent without an extra query per space).
    const adminSlugs = new Set(memberSpaces.filter((s) => user.isAdmin || myRoles[s.slug] === 'admin').map((s) => s.slug));
    const agentCounts = await storage.countAgentPages(memberSpaces.map((s) => s.slug));
    // Which of those spaces keep a writing-rules page (a boolean, like the count — nothing from inside `.agent`).
    const writingRulesSpaces = await storage.spacesWithWritingRules(memberSpaces.map((s) => s.slug));
    // Same "only while actually conflicted" gate as buildAdminSpacesList —
    // this list is polled (Sidebar/ConflictBanner/SpaceSwitcher all share
    // the ['spaces'] query), so a `git grep` per space would be wasted work
    // for the overwhelming majority that aren't conflicted.
    const spaces: SpaceInfo[] = await Promise.all(
      memberSpaces.map(async (s): Promise<SpaceInfo> => {
        const info: SpaceInfo = {
          ...s,
          myRole: myRoles[s.slug],
          git: s.git && s.git.status === 'conflict' ? { ...s.git, conflicts: await gitSync.getSpaceConflicts(s.slug) } : s.git,
        };
        // The ignore list names folders of the repository: space admins only (the effective `lightFootprint` flag is not a secret).
        if (!adminSlugs.has(s.slug)) delete info.scanIgnore;
        info.agentRules = buildAgentRulesInfo(agentCounts.get(s.slug) ?? 0, adminSlugs.has(s.slug), writingRulesSpaces.has(s.slug));
        return info;
      }),
    );
    return { spaces };
  });

  /**
   * Round 22: EVERY space (regardless of the caller's own membership) with
   * per-space members+roles — instance-admin only, unlike the plain
   * /api/spaces above. Returns a BARE ARRAY (not {spaces: [...]}) — matches
   * what the SHELL-side admin/spaces page was already built against.
   */
  // Incident 15.09: boot-time indexing now runs in the background (server/bootScan.ts);
  // this is how an instance admin sees which space, if any, failed to index — the
  // host's own logs aren't reachable from here.
  app.get('/api/admin/boot-scan', async (request) => {
    session.requireInstanceAdmin(request);
    return bootScan.getBootScanStatus();
  });

  app.get('/api/admin/spaces', async (request) => {
    // Cookie-only, like every other admin endpoint (DEV-PLAN round 7:
    // "Admin endpoints are NOT available to a PAT whatever its scope") — this one
    // returns every space on the instance WITH its member list, i.e. exactly
    // the reconnaissance a stolen read-scoped token should never get.
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    return buildAdminSpacesList();
  });

  app.get('/api/admin/spaces/:space/export.zip', async (request, reply) => {
    session.requireCookieAuth(request);
    session.requireInstanceAdmin(request);
    const { space } = request.params as { space: string };
    if (!(await storage.spaceExists(space))) throw notFound('space');
    const archive = await buildSpaceZip(space);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${space}.zip"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(archive);
  });

  app.patch('/api/admin/spaces/:space', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Renaming a space');
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const admin = session.requireInstanceAdmin(request);
    const { space } = request.params as { space: string };
    const body = parseBody(renameSpaceBodySchema, request.body);
    const result = await storage.renameSpace(space, body.name);
    const author = { name: admin.name, email: admin.email };
    gitSync.recordEditor(space, author);
    await gitSync.commitNow(space, 'folio:update', author).catch((err) => {
      // The DB and metadata file are already updated; a later sync can still
      // commit the file if git is temporarily unavailable.
      request.log.warn({ err, space }, 'space rename commit failed');
    });
    return result;
  });

  app.delete('/api/admin/spaces/:space', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Deleting a space');
    session.requireCookieAuth(request);
    const admin = session.requireInstanceAdmin(request);
    session.requireWriteScope(request);
    const { space } = request.params as { space: string };
    if (!(await storage.spaceExists(space))) throw notFound('space');
    await storage.deleteSpace(space, admin.id);
    return { ok: true };
  });

  app.post('/api/spaces', async (request, reply) => {
    assertNotDemo('Creating a space');
    session.requireWriteScope(request);
    const user = request.authUser!;
    const body = parseBody(createSpaceGit, request.body);
    // "Any authenticated user may create a space and becomes its admin" (DEV-PLAN round 2).
    let space: SpaceWithVaultNote;
    if (body.repoUrl) {
      if (body.importId) importProgress.startSpaceImport(body.importId, user.id);
      // QA-3 P0: without this, "any authenticated user may create a space"
      // meant any authenticated user could clone ANY local directory — e.g.
      // data/repos/<someone else's private space> via file:// or a bare
      // path — and become admin of a copy of its content. Same guard, same
      // 400, as POST /api/git/branches / GET /api/git/tree above; git.ts's
      // clone family re-checks it independently (defense in depth).
      try {
        try {
          git.validateRepoUrl(body.repoUrl);
        } catch {
          throw badRequest('invalid repository URL');
        }
        if (body.importId) importProgress.phaseSpaceImport(body.importId, 'checking', 4);
        const token = await userGitCredentials.resolveGitToken(user.id, body.repoUrl, body.token);
        space = await storage.createSpaceFromRepo({
          name: body.name,
          repoUrl: body.repoUrl,
          branch: body.branch ?? (await git.resolveRemoteDefaultBranch(body.repoUrl, token)) ?? 'main',
          rootPath: body.rootPath ?? '',
          createdBy: user.id,
          token,
          lightFootprint: body.lightFootprint,
          onProgress: body.importId
            ? (progress) => importProgress.updateSpaceImport(body.importId!, progress)
            : undefined,
        });
        await startPeriodicFetchForSpace(space.slug);
      } catch (err) {
        if (body.importId) importProgress.failSpaceImport(body.importId, err instanceof Error ? err.message : String(err));
        throw err;
      }
    } else {
      // An empty space starts with three ready templates, in the creator's language.
      space = await storage.createSpace(body.name, user.id, {
        starterTemplates: true,
        language: resolveTextLanguage(user.lang, request.headers['accept-language']) === 'uk' ? 'uk' : 'en',
      });
    }
    await authStore.setMembership(space.slug, user.id, 'admin');
    if (body.importId) importProgress.finishSpaceImport(body.importId);
    reply.status(201);
    return { ...space, myRole: 'admin' };
  });

  app.get('/api/spaces/import-progress/:id', async (request) => {
    session.requireWriteScope(request);
    const { id } = request.params as { id: string };
    const progress = importProgress.getSpaceImport(id, request.authUser!.id);
    if (!progress) throw notFound('space import');
    return progress;
  });

  // Index v2 (Obsidian brief wave 1b): space-wide reads of the page index, viewer+, filtered in SQL to the pages
  // the caller may read (accessSql.ts) — counts and lists never include a closed page.
  app.get('/api/spaces/:space/tags', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const response: SpaceTagsResponse = { tags: await indexRead.listSpaceTags(space, userViewer(request.authUser!)) };
    return response;
  });

  app.get('/api/spaces/:space/unresolved-links', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const limit = indexRead.clampUnresolvedLimit(queryString(request.query, 'limit'));
    const offset = indexRead.clampOffset(queryString(request.query, 'offset'));
    const response: UnresolvedLinksResponse = await indexRead.listUnresolvedLinks(space, userViewer(request.authUser!), { limit, offset });
    return response;
  });

  app.get('/api/spaces/:space/orphans', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const response: OrphansResponse = { pages: await indexRead.listOrphans(space, userViewer(request.authUser!)) };
    return response;
  });

  // Graph view (16.10.2026): the space's links as nodes and edges, viewer+, filtered in SQL with the same rules
  // (server/graph.ts) — a page the caller cannot open is never a node, and a link to it is not drawn at all.
  app.get('/api/spaces/:space/graph', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const q = request.query as Record<string, unknown>;
    const response: GraphResponse = await graph.getSpaceGraph(space, userViewer(request.authUser!), graph.parseGraphOptions(q), graph.clampGraphLimit(q?.limit));
    return response;
  });

  app.get('/api/spaces/:space/tree', async (request) => {
    const { space } = request.params as { space: string };
    const role = await session.requireSpaceRole(request, space, 'viewer');
    const allowed = await session.readablePageIds(request.authUser!, space, role);
    const tree: TreeNode[] = await storage.getTree(space, allowed);
    // Lock marks (stage 7: restrictions are inherited) — only on pages already in the caller's tree.
    const marks = await pageAccess.accessMarks(space);
    if (marks.size > 0) {
      const mark = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
          const access = marks.get(node.id);
          if (access) node.access = access;
          mark(node.children);
        }
      };
      mark(tree);
    }
    return { tree };
  });

  app.post('/api/pages/validate-recents', async (request) => {
    const body = parseBody(validateRecentPagesBodySchema, request.body);
    const user = request.authUser!;
    const valid: string[] = [];
    for (const item of body.pages) {
      const entry = await storage.getEntry(item.id);
      if (!entry || entry.space !== item.space) continue;
      const role = await session.effectivePageRole(user, entry);
      if (role) valid.push(`${item.space}:${item.id}`);
    }
    return { valid };
  });

  app.get('/api/spaces/:space/templates', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const templates: TemplateListItem[] = await storage.listTemplates(space);
    return { templates };
  });

  /** "New template": a blank document in `_templates/` with a name and an optional description. */
  app.post('/api/spaces/:space/templates', async (request, reply) => {
    const { space } = request.params as { space: string };
    const body = parseBody(createBlankTemplateBodySchema, request.body);
    const user = request.authUser!;
    await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    await session.requireAgentWriteAllowed(user, space, '_templates');
    gitSync.recordEditor(space, { name: user.name, email: user.email });
    const meta = await storage.createPage(
      { space, parentPath: '_templates', title: body.title, kind: 'doc' },
      undefined,
      resolveTextLanguage(user.lang, request.headers['accept-language']),
    );
    if (body.description) await setTemplateDescription(meta.id, body.description, user);
    const after = snapshotPageChange(await storage.requireEntry(meta.id));
    await recordPageChange(user.id, 'page.create', meta.id, space, undefined, after);
    gitSync.noteActivity(space);
    reply.status(201);
    return meta;
  });

  /** The `_templates/` folder as a tree (any kind of page, subpages nested) — the template picker's tree. */
  app.get('/api/spaces/:space/templates/tree', async (request) => {
    const { space } = request.params as { space: string };
    const role = await session.requireSpaceRole(request, space, 'viewer');
    const allowed = await session.readablePageIds(request.authUser!, space, role);
    const tree: TreeNode[] = await storage.getTemplatesTree(space, allowed);
    return { tree };
  });

  app.get('/api/spaces/:space/git', async (request) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const info = await storage.getSpaceInfo(space);
    if (!info || !info.git) throw badRequest('space not found');
    if (info.git.status === 'conflict') {
      return { ...info.git, conflicts: await gitSync.getSpaceConflicts(space) };
    }
    return info.git;
  });

  app.post('/api/spaces/:space/sync', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Syncing a space with git');
    const { space } = request.params as { space: string };
    if (!(await storage.spaceExists(space))) throw notFound('space');
    // 16.10.2026 (owner): "Sync now" is for anyone who may edit the space — it only commits, pulls and pushes,
    // which the scheduler does anyway. Destructive git actions (reset to remote, connect git) stay space-admin.
    if (!(await session.canAdministerSpace(request.authUser!, space))) await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;
    gitSync.recordEditor(space, { name: user.name, email: user.email });
    await gitSync.performSync(space, { name: user.name, email: user.email });
    const info = await storage.getSpaceInfo(space);
    if (!info) throw badRequest('space not found');
    return { git: info.git };
  });

  /** Explicit resolution of one deletion or binary conflict recorded by a merge; the next sync then pushes. Same gate as Sync: anyone who may edit the space. */
  app.post('/api/spaces/:space/git/resolve-conflict', async (request): Promise<ResolveGitConflictResponse> => {
    assertNotDemoAccount(request.authUser!, 'Resolving a git conflict');
    const { space } = request.params as { space: string };
    if (!(await storage.spaceExists(space))) throw notFound('space');
    if (!(await session.canAdministerSpace(request.authUser!, space))) await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;
    const body = parseBody(resolveGitConflictBody, request.body);
    gitSync.recordEditor(space, { name: user.name, email: user.email });
    await gitSync.resolveConflict(space, body.path, body.choice, { name: user.name, email: user.email }, user.id);
    const info = await storage.getSpaceInfo(space);
    if (!info || !info.git) throw badRequest('space not found');
    const git: SpaceGitInfo = info.git.status === 'conflict' ? { ...info.git, conflicts: await gitSync.getSpaceConflicts(space) } : info.git;
    return { git };
  });

  /**
   * "Take the version from Git" — owner ask: nobody is ever going to resolve a
   * git-native space's merge conflicts by hand, so this throws away
   * everything local and makes the space match origin/<branch> exactly (see
   * server/git.ts's resetToRemote and server/gitSync.ts's
   * resetSpaceToRemote). Same guard as manual sync above (canAdministerSpace
   * — instance admin OR this space's own explicit admin): this is a
   * space-level git-configuration action, not a content edit an editor
   * should be able to trigger, and it's strictly more destructive than sync
   * (which never discards local content), so it gets at least the same gate,
   * never a looser one.
   */
  app.post('/api/spaces/:space/git/reset-to-remote', async (request): Promise<ResetToRemoteResponse> => {
    assertNotDemoAccount(request.authUser!, 'Resetting a space to the remote');
    const { space } = request.params as { space: string };
    if (!(await storage.spaceExists(space))) throw notFound('space');
    if (!(await session.canAdministerSpace(request.authUser!, space))) throw forbidden('requires space admin or instance admin');
    session.requireWriteScope(request);
    const user = request.authUser!;
    gitSync.recordEditor(space, { name: user.name, email: user.email });
    const result = await gitSync.resetSpaceToRemote(space, { name: user.name, email: user.email });
    const info = await storage.getSpaceInfo(space);
    if (!info || !info.git) throw badRequest('space not found');
    const git: SpaceGitInfo = info.git.status === 'conflict' ? { ...info.git, conflicts: await gitSync.getSpaceConflicts(space) } : info.git;
    return { git, backupRef: result.backupRef, changedCount: result.changedCount };
  });

  /**
   * "Connect git" — connects an already-existing LOCAL space (created
   * empty, `git init`'d, has its own content/history, no origin) to a real
   * repository after the fact. Same admin gate as manual sync above (both
   * are space-level git-configuration actions, not content edits an editor
   * should be able to trigger). Only ever succeeds against an EMPTY remote —
   * see storage.connectSpaceToRepo's own doc comment for why a non-empty one
   * is refused (409) rather than merged. Starts the same periodic background
   * fetch a fresh createSpaceFromRepo space gets, so this space behaves
   * identically to one created "from repo" from this point on.
   */
  app.post('/api/spaces/:space/connect-git', async (request) => {
    assertNotDemo('Connecting a space to a git repository');
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    session.requireWriteScope(request);
    const user = request.authUser!;
    const body = parseBody(connectSpaceGitBodySchema, request.body);
    // Same QA-3 P0 guard as POST /api/spaces: a `file://`/bare-path "remote"
    // here would attach a stranger's local repository as this space's origin
    // and push its content there. Checked AFTER the role gate above, so an
    // outsider still gets 403/404 rather than a hint that the URL was bad.
    try {
      git.validateRepoUrl(body.repoUrl);
    } catch {
      throw badRequest('invalid repository URL');
    }
    const token = await userGitCredentials.resolveGitToken(user.id, body.repoUrl, body.token);
    const info = await storage.connectSpaceToRepo(space, { repoUrl: body.repoUrl, branch: body.branch ?? 'main', token });
    await startPeriodicFetchForSpace(space);
    return info;
  });

  /**
   * "Store images in the repository" (space setting, store | repo). Admin of the
   * SPACE ITSELF, same gate as export-settings: switching to 'repo' makes every
   * later image upload write into the space's repository (a content decision),
   * so it is not instance-admin-only. Existing images stay where they are — the
   * mode only decides where NEW uploads go.
   */
  app.put('/api/spaces/:space/asset-mode', async (request) => {
    assertNotDemo('Changing where images are stored');
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    session.requireWriteScope(request);
    const body = parseBody(updateSpaceAssetModeBodySchema, request.body);
    await storage.setSpaceAssetMode(space, body.assetMode);
    recordAudit(request.authUser!.id, 'space.asset_mode', space, { assetMode: body.assetMode });
    return { slug: space, assetMode: body.assetMode };
  });

  /**
   * Scan settings (Obsidian vault compatibility): the space's extra ignore
   * list and its light-footprint flag. Space admin, like asset-mode — both
   * decide what Folio indexes / writes in the repository. A changed ignore
   * list rescans the space before this answers (storage.setSpaceScanSettings).
   */
  app.patch('/api/spaces/:space/scan-settings', async (request) => {
    assertNotDemo('Changing which files a space indexes');
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    session.requireWriteScope(request);
    const body = parseBody(updateScanSettingsBodySchema, request.body);
    const info = await storage.setSpaceScanSettings(space, body);
    recordAudit(request.authUser!.id, 'space.scan_settings', space, { scanIgnore: body.scanIgnore, lightFootprint: body.lightFootprint });
    return { slug: space, pageCount: info.pageCount, scanIgnore: info.scanIgnore ?? [], lightFootprint: info.lightFootprint === true };
  });

  app.post('/api/spaces/:space/assets', async (request, reply): Promise<UploadAssetResponse> => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    const file = await request.file();
    if (!file) throw badRequest('no file uploaded (expected multipart field "file")');
    const buffer = await file.toBuffer();

    const info = await storage.getSpaceInfo(space);
    let result: UploadAssetResponse;
    if (info?.assetMode === 'repo') {
      result = await storage.saveAssetIntoRepo(space, file.filename, buffer);
      // A new file in the working tree: attribute it to the uploader and let the
      // standard debounced auto-commit pick it up (commitAll stages everything,
      // so assets/ rides along with the page edit that references it).
      gitSync.recordEditor(space, { name: request.authUser!.name, email: request.authUser!.email });
      gitSync.noteActivity(space);
    } else {
      result = await assets.putAsset(buffer, { mime: file.mimetype, filename: file.filename }, request.authUser!.id);
    }
    reply.status(201);
    return result;
  });

  /**
   * Uploads a pdf/docx/xlsx/pptx as a new page — the ONLY way a pdf/office
   * page is created other than a scan finding one already in the repo
   * (storage.createPage rejects kind:'pdf'/'office' outright, see its own
   * doc comment). Guard mirrors POST /api/pages exactly (editor+ on the
   * space, write scope) since this is, from a permissions standpoint,
   * exactly that: creating a page in a parent directory.
   *
   * Round OFFICE: this was `/api/spaces/:space/pdf`, pdf-only. One route now
   * covers all four extensions — a docx/xlsx/pptx is, from this route's own
   * standpoint, exactly the same operation a pdf upload already was (write
   * the bytes verbatim, let the next scan index them), so a second route
   * would only have duplicated this one's body.
   *
   * Multipart field "file" (same convention as the asset upload above);
   * optional field "parentPath" (a plain text field alongside it, read off
   * `file.fields` — @fastify/multipart buffers a field that arrives before
   * the file part it shares a body with) is the parent directory, same
   * meaning as createPageBodySchema's own `parentPath` ("" for the space
   * root when omitted).
   *
   * The global multipart size limit (server/index.ts: 50MB) already covers
   * this route — no separate raise needed.
   */
  app.post('/api/spaces/:space/file', async (request, reply) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'editor');
    session.requireWriteScope(request);
    const file = await request.file();
    if (!file) throw badRequest('no file uploaded (expected multipart field "file")');
    const parentPathField = file.fields.parentPath;
    const parentPathValue = !Array.isArray(parentPathField) && parentPathField?.type === 'field' ? parentPathField.value : undefined;
    const parentPath = typeof parentPathValue === 'string' ? parentPathValue : '';

    // Name and magic-byte checks are shared with the replace route (filePages.ts).
    if (!/\.pdf$/i.test(file.filename) && !officeFormat(file.filename)) throw badRequest('expected a .pdf, .docx, .xlsx or .pptx file');
    const buffer = await file.toBuffer();
    const ext = inspectFilePageUpload(file.filename, buffer);

    const meta = await storage.uploadFilePage(space, parentPath, file.filename, ext, buffer);
    const after = snapshotPageChange(await storage.requireEntry(meta.id));
    await recordPageChange(request.authUser!.id, 'page.create', meta.id, space, undefined, after);
    gitSync.recordEditor(space, { name: request.authUser!.name, email: request.authUser!.email });
    gitSync.noteActivity(space);
    reply.status(201);
    return meta;
  });

  // --- Pages ------------------------------------------------------------

  /**
   * OFFLINE CREATION: `body.id` (a client-minted ULID) and `body.ydocState` are
   * optional; without them this is exactly the ordinary create.
   *
   *  - `id` already taken by a page of the SAME space and kind -> 200 with that
   *    page's meta, nothing changed: an idempotent replay (the first attempt
   *    succeeded, its response was lost, the client retries). It passes the same
   *    permission gates as a create and records NO second page change.
   *  - `id` taken by anything else -> 409.
   *  - `ydocState` without `id` -> 400 (the snapshot is keyed by the page id, and
   *    the client's local doc can only be reconnected to a page it named itself).
   *  - `ydocState` that is not a complete Yjs update -> 400 (collab.decodeClientState).
   *
   * The body limit is raised for this route only: the contract lets `ydocState`
   * carry up to 8,000,000 base64 chars (a board with embedded images), which
   * Fastify's 1 MiB default would answer with a 413 before we ever looked at it.
   */
  app.post('/api/pages', { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const body = parseBody(createPageBodySchema, request.body);
    if (body.ydocState !== undefined && body.id === undefined) throw badRequest('ydocState requires id');
    await session.requireSpaceRole(request, body.space, 'editor');
    session.requireWriteScope(request);
    await session.requireAgentWriteAllowed(request.authUser!, body.space, storage.normalizeDirParam(body.parentPath));

    if (body.id !== undefined) {
      const existing = await storage.getEntry(body.id);
      if (existing) {
        if (existing.space !== body.space || existing.kind !== body.kind) throw conflict('a page with this id already exists');
        // The space-level gate above is not enough to hand a page's meta back: a page
        // can be restricted below the space role (page access) or live under `.agent/`.
        await session.requirePageRole(request, existing.id, 'editor');
        reply.status(200);
        return storage.toPageMeta(existing);
      }
    }

    // Decode BEFORE creating anything: garbage must be a 400 with no page left behind.
    // Only doc and board rooms are seeded from a Y.Doc; for any other kind `ydocState` is ignored.
    const clientState =
      body.ydocState !== undefined && (body.kind === 'doc' || body.kind === 'board') ? collab.decodeClientState(body.kind, body.ydocState) : undefined;
    if (body.kind === 'base' && body.base !== undefined) {
      const parsed = parseBaseConfig(body.base);
      if (parsed.error) throw badRequest(`not a valid base: ${parsed.error.message}`);
    }
    const meta = await storage.createPage(
      body,
      body.kind === 'base' ? { baseSource: body.base } : clientState && { docBody: clientState.docBody, boardSvg: clientState.boardSvg },
      resolveTextLanguage(request.authUser?.lang, request.headers['accept-language']),
    );
    // File first, snapshot second (see collab.storeClientSnapshot): a failure here must
    // not fail a create whose file already exists — the page is correct, the room would
    // just seed from the file instead of resuming from the client's history.
    if (clientState) {
      await collab.storeClientSnapshot(meta.id, clientState.snapshot).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[offline] created page ${meta.id} but could not store the client's Y.Doc snapshot; the room will seed from the file:`, err);
      });
    }
    const after = snapshotPageChange(await storage.requireEntry(meta.id));
    await recordPageChange(request.authUser!.id, 'page.create', meta.id, body.space, undefined, after);
    gitSync.recordEditor(body.space, { name: request.authUser!.name, email: request.authUser!.email });
    gitSync.noteActivity(body.space);
    reply.status(201);
    return meta;
  });

  /**
   * "Create writing rules": the starter `.agent/writing-rules.md` (shared/contracts.ts WRITING_RULES_PATH,
   * server/writingRules.ts). Space admins only — the same rule as any write into `.agent`. 409 when the space
   * already has the page. The starter text follows the caller's language.
   */
  app.post('/api/spaces/:space/writing-rules', async (request, reply) => {
    const { space } = request.params as { space: string };
    await session.requireSpaceRole(request, space, 'admin');
    session.requireWriteScope(request);
    const user = request.authUser!;
    gitSync.recordEditor(space, { name: user.name, email: user.email });
    const meta = await createStarterWritingRules(space, resolveTextLanguage(user.lang, request.headers['accept-language']));
    await recordPageChange(user.id, 'page.create', meta.id, space, undefined, snapshotPageChange(await storage.requireEntry(meta.id)));
    gitSync.noteActivity(space);
    reply.status(201);
    return meta;
  });

  app.get('/api/pages/:id', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    return buildPageDoc(entry, userViewer(request.authUser!));
  });

  /** Obsidian canvas: the parsed `.canvas` with its file cards resolved for this reader — the same object PageDoc.canvas carries (server/canvasView.ts). */
  app.get('/api/pages/:id/canvas', async (request): Promise<CanvasPayload> => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'canvas') throw badRequest('page is not a canvas');
    return buildCanvasPayload(entry, userViewer(request.authUser!));
  });

  /** What "Convert to Folio board" would lose — read only, nothing is written (server/canvasToBoard.ts). */
  app.get('/api/pages/:id/canvas/convert', async (request): Promise<CanvasConversionReport> => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'canvas') throw badRequest('page is not a canvas');
    return canvasConversionReport(entry, userViewer(request.authUser!), publicUrlOrOrigin(requestOrigin(request)));
  });

  /**
   * "Convert to Folio board": a NEW board made from the canvas, in one commit by the caller; the canvas stays as it
   * is. Read the canvas, write where the board goes (editor+ on the space, like a copy).
   */
  app.post('/api/pages/:id/canvas/convert', async (request, reply): Promise<CanvasConvertResult> => {
    const { id } = request.params as { id: string };
    const body = parseBody(canvasConvertBodySchema, request.body ?? {});
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'canvas') throw badRequest('page is not a canvas');
    await session.requireSpaceRole(request, entry.space, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;
    await session.requireAgentWriteAllowed(user, entry.space, body.parentPath ?? entry.dirPath);
    gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
    const result = await convertCanvasPage(entry, userViewer(user), body, { name: user.name, email: user.email }, publicUrlOrOrigin(requestOrigin(request)));
    const after = snapshotPageChange(await storage.requireEntry(result.board.id));
    await recordPageChange(user.id, 'page.create', result.board.id, entry.space, undefined, after);
    recordAudit(user.id, 'page.created', result.board.id, { from: 'canvas', canvas: entry.id });
    reply.status(201);
    return result;
  });

  /** Content-Type for a pdf/office page's bytes — see officeFormat's own doc comment for the extension-to-format mapping. */
  const OFFICE_CONTENT_TYPES: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };

  /**
   * Streams a pdf/office page's file bytes. Page-level permission applies
   * exactly like reading the page's metadata above (requirePageRole
   * 'viewer') — a page hidden via restricted page access must not leak
   * through this route just because its id is known. `?download=1` asks for
   * Content-Disposition: attachment instead of inline (the toolbar's
   * "Download" button); everything else (an <iframe>/<object> embed, the
   * @silurus/ooxml viewer's fetch, "Open in a new tab") wants inline.
   * No X-Frame-Options/CSP header is set here or anywhere else in this app
   * (grepped — there is no helmet/CSP middleware at all), so a same-origin
   * iframe embedding this URL already works with nothing to loosen.
   */
  app.get('/api/pages/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
    const ext = entry.kind === 'pdf' ? 'pdf' : (officeFormat(entry.relPath) ?? 'pdf');
    const contentType = entry.kind === 'pdf' ? 'application/pdf' : OFFICE_CONTENT_TYPES[ext];
    const download = queryString(request.query, 'download') === '1';
    const asciiName = `${entry.title}.${ext}`.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || `document.${ext}`;
    const encodedName = encodeURIComponent(`${entry.title}.${ext}`);
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'private');
    reply.header(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    );
    // Streamed straight from the working-tree file — this scope has no
    // @fastify/static registered (unlike the separate /files/ scope in
    // server/fileAccess.ts), so a plain read stream is the simplest way to
    // avoid holding a 50MB+ file in memory.
    return reply.send(fsSync.createReadStream(entry.absPath));
  });

  /**
   * Replaces the file of a pdf/office page with a new version (multipart field
   * "file", same size limit and checks as the upload that created the page).
   * The page keeps its id, slug, place in the tree, links, stars and access;
   * a different extension (deck.pptx -> deck.pdf) renames the file and
   * rewrites incoming links, see server/filePages.ts. One commit per replace,
   * so the previous version stays restorable from the page history. Editor+
   * (a viewer gets 403); not available through share links.
   */
  app.post('/api/pages/:id/file', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
    const file = await request.file();
    if (!file) throw badRequest('no file uploaded (expected multipart field "file")');
    if (!/\.pdf$/i.test(file.filename) && !officeFormat(file.filename)) throw badRequest('expected a .pdf, .docx, .xlsx or .pptx file');
    const buffer = await file.toBuffer();
    const ext = inspectFilePageUpload(file.filename, buffer);

    const user = request.authUser!;
    const result = await replaceFilePage(id, ext, buffer, { name: user.name, email: user.email });
    recordAudit(user.id, 'page.file.replaced', id, { from: result.previousPath, to: result.meta.path, size: buffer.length });
    const response: ReplaceFilePageResponse = { ...result.meta, previousSha: result.previousSha };
    return response;
  });

  /** The bytes of a file page as of one commit (download / preview of an older version). Viewer-level, like the current file. */
  app.get('/api/pages/:id/history/:sha/file', async (request, reply) => {
    const { id, sha } = request.params as { id: string; sha: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    if (entry.kind !== 'pdf' && entry.kind !== 'office') throw badRequest('page is not a pdf/office file');
    const revision = await gitSync.getFilePageRevisionBytes(id, sha);
    const ext = revision.ext.slice(1);
    const contentType = ext === 'pdf' ? 'application/pdf' : OFFICE_CONTENT_TYPES[ext];
    const download = queryString(request.query, 'download') === '1';
    const baseName = pathPosix.basename(revision.path);
    const asciiName = baseName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || `document.${ext}`;
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable'); // a commit never changes
    reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(baseName)}`);
    return reply.send(revision.bytes);
  });

  app.get('/api/pages/:id/access', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const role = await session.effectivePageRole(request.authUser!, entry);
    return pageAccess.getInfo(request.authUser!, entry, role!);
  });

  /**
   * Fix/share-identity: the caller's own effective role on `id` (`null` if
   * their session grants none at all), computed via the exact same
   * session.effectivePageRole call server/collab.ts's WS upgrade path uses
   * to decide a live collab connection's role. A board/doc reached through a
   * share link (web/src/app/share/SharedPageView.tsx) renders with a real
   * pageId even for a logged-in visitor, but that surface has no other way
   * to learn whether ITS SESSION — not the share link's own static mode —
   * actually grants edit access; without this, the client could only guess
   * from the share endpoint's response and show "editable" while the
   * session-authenticated collab socket silently drops every write. No 403
   * on a page the caller can't see: `role: null` IS the answer for that case
   * (the guest/share-token path is then the correct fallback), not an error.
   */
  app.get('/api/pages/:id/my-role', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await storage.requireEntry(id);
    const role = await session.effectivePageRole(request.authUser!, entry);
    return { role: role ?? null };
  });

  /**
   * "Where did this link go": the page of `:space` an unknown id used to mean (an id derived from its path, see
   * storage.findMovedPage) - the app follows it instead of showing a dead end. 404 for anything the caller could not
   * open anyway, so it reveals nothing a 404 would not.
   */
  app.get('/api/spaces/:space/moved-page/:id', async (request) => {
    const { space, id } = request.params as { space: string; id: string };
    await session.requireSpaceRole(request, space, 'viewer');
    const moved = await storage.findMovedPage(space, id);
    if (!moved || !session.roleAtLeast(await session.effectivePageRole(request.authUser!, moved), 'viewer')) throw notFound('page');
    return storage.toPageMeta(moved);
  });

  app.put('/api/pages/:id/access', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Changing page permissions');
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireCookieAuth(request);
    const body = parseBody(updatePageAccessBodySchema, request.body);
    await pageAccess.setAccess(request.authUser!, entry, body.visibility, body.grants);
    const role = await session.effectivePageRole(request.authUser!, entry);
    recordAudit(request.authUser!.id, 'page.access', id, { visibility: body.visibility, grants: body.grants.length });
    return pageAccess.getInfo(request.authUser!, entry, role!);
  });

  app.put('/api/pages/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(updatePageBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;

    if (entry.kind === 'doc') {
      if (body.markdown === undefined && body.icon === undefined && body.cover === undefined && body.order === undefined) {
        throw badRequest('markdown is required for a document page');
      }
      gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
      if (body.markdown === undefined) {
        // icon/cover/order-only update (round 5 picker; round 22 tree "Up/Down"):
        // body untouched, immediate persist — neither icon/cover nor order is part of
        // the Yjs body, so none of this would otherwise ever flow through write-back.
        const icon = storage.resolveIconCoverOverride(body.icon, entry.icon);
        const cover = storage.resolveIconCoverOverride(body.cover, entry.cover);
        const currentBody = collab.isDocLive(id)
          ? (collab.getLiveText(id) ?? (await storage.readFreshDocBody(id)))
          : await storage.readFreshDocBody(id);
        if (body.order !== undefined) await storage.setDocOrder(entry, body.order, currentBody);
        await storage.setDocIconCover(entry, icon, cover, currentBody);
        gitSync.noteActivity(entry.space);
        return storage.toPageMeta(await storage.requireEntry(id));
      }
      // A client-submitted frontmatter block (round 5's icon picker) is optional and
      // defensively detected — the Yjs body never carries one, so this is a no-op split
      // (whole string returned as `body`) for the normal collab-edit case.
      const { icon: fmIcon, cover: fmCover, body: markdownBody } = storage.splitLeadingFrontmatter(body.markdown);
      // Explicit icon/cover fields on the request body win over anything extracted
      // from a submitted frontmatter block: string sets, null clears, absent falls
      // through to whatever the frontmatter carried (itself just "preserve" if the
      // frontmatter didn't mention it either — plain body edits never clear it).
      const iconOverride = body.icon !== undefined ? body.icon : fmIcon;
      const coverOverride = body.cover !== undefined ? body.cover : fmCover;
      // `order` alongside a real markdown edit is not a case the UI actually produces
      // (SHELL's tree reorder always sends order alone, same shape as an icon/cover-only
      // PUT) — not handled in this branch, same as icon/cover's own precedent above only
      // fully applies to the no-markdown path.
      const result = await collab.editDocBody(id, markdownBody, iconOverride, coverOverride);
      gitSync.noteActivity(entry.space);
      return result;
    }

    // Round FORMS: a form has no collab room (see storage.ts's "no live
    // collab room" note) — its own definition editor sends the WHOLE file
    // (frontmatter + body) as `markdown`, the same "normal page PUT" shape a
    // doc's icon-picker frontmatter block already uses, and this is always a
    // direct write. `id`/`table` in the submitted doc are ignored — see
    // storage.writeFormDoc's own doc comment for why.
    if (entry.kind === 'form') {
      if (body.markdown === undefined && body.icon === undefined && body.order === undefined) {
        throw badRequest('markdown is required for a form page');
      }
      gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
      if (body.markdown === undefined) {
        if (body.order !== undefined) await storage.setFormOrder(entry, body.order);
        if (body.icon !== undefined) await storage.setFormIcon(entry, storage.resolveIconCoverOverride(body.icon, entry.icon));
        gitSync.noteActivity(entry.space);
        return storage.toPageMeta(await storage.requireEntry(id));
      }
      const parsedForm = parseFormFile(body.markdown);
      if (isFormParseError(parsedForm)) throw badRequest(`form file is invalid: ${parsedForm.message}`);
      const result = await storage.writeFormDoc(id, parsedForm);
      gitSync.noteActivity(entry.space);
      return result;
    }

    // Order-only and/or icon-only PUT on a board, a table, or a pdf/office
    // file (the sidebar tree's reorder — the "…" menu's Up/Down and, since
    // the drag-and-drop round, a dropped row; for a board, also the icon
    // picker, PageChrome.tsx, same as a doc's icon-only branch above).
    //   board  -> a leading `<!-- folio-order: N -->` / `<!-- folio-icon: … -->`
    //             comment beside the existing `<!-- folio-id: ... -->` one (the
    //             scene payload is never reparsed) — see storage.setBoardOrder/
    //             setBoardIcon;
    //   table  -> top-level `order` / `icon` keys in the file's own frontmatter, set
    //             without round-tripping the table SCHEMA that shares that
    //             block — see storage.setTableOrder/storage.setTableIcon.
    //   pdf/office -> the owner's binary file is NEVER written to, so order/icon
    //             live only in the pages_index row itself — see
    //             storage.setBinaryPageOrder/setBinaryPageIcon's doc comment.
    // board/table/doc all survive a full scanSpace rebuild via the file; pdf/office
    // survive it via indexBinaryFile re-reading its own row (NOT via git).
    if (body.svg === undefined && (body.order !== undefined || body.icon !== undefined)) {
      gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
      if (entry.kind === 'board') {
        if (body.order !== undefined) await storage.setBoardOrder(entry, body.order);
        if (body.icon !== undefined) await storage.setBoardIcon(entry, storage.resolveIconCoverOverride(body.icon, entry.icon));
      } else if (entry.kind === 'artifact') {
        // An artifact: order in the index row (like a pdf's), the icon in its artifact.yaml.
        if (body.order !== undefined) await storage.setBinaryPageOrder(entry, body.order);
        if (body.icon !== undefined) await setArtifactTitleIcon(id, { icon: storage.resolveIconCoverOverride(body.icon, entry.icon) ?? null }, user);
      } else if (entry.kind === 'pdf' || entry.kind === 'office' || entry.kind === 'canvas' || entry.kind === 'base') {
        // A canvas file is never written either: its order/icon live in the index row, like a pdf's.
        if (body.order !== undefined) await storage.setBinaryPageOrder(entry, body.order);
        if (body.icon !== undefined) await storage.setBinaryPageIcon(entry, storage.resolveIconCoverOverride(body.icon, entry.icon));
      } else {
        if (body.order !== undefined) await storage.setTableOrder(entry, body.order);
        if (body.icon !== undefined) await storage.setTableIcon(entry, storage.resolveIconCoverOverride(body.icon, entry.icon));
      }
      gitSync.noteActivity(entry.space);
      return storage.toPageMeta(await storage.requireEntry(id));
    }
    if (entry.kind === 'base') throw badRequest('a base is edited through PUT /api/pages/:id/base');
    if (entry.kind === 'artifact') throw badRequest('an artifact is replaced through PUT /api/pages/:id/artifact');
    if (body.svg === undefined) {
      throw badRequest('svg is required for a board page');
    }
    // (a table reaching this line with an svg still falls through to
    // writeBoardSvg's own `page is not a board` 400, exactly as before)
    gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
    const force = queryString(request.query, 'force') === '1';
    // Round 29: through the live Y.Doc when a room is open (an editor with the
    // board open in another tab, an agent's concurrent MCP edit) — see
    // writeBoardSvgLiveAware's doc comment.
    const result = await writeBoardSvgLiveAware(id, body.svg, force);
    gitSync.noteActivity(entry.space);
    return result;
  });

  app.post('/api/pages/:id/move', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(movePageBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    assertDemoAgentRootIntact(request.authUser!, entry.relPath, 'Moving the .agent folder');
    const before = snapshotPageChange(entry);
    session.requireWriteScope(request);
    await session.requireAgentWriteAllowed(request.authUser!, entry.space, storage.normalizeDirParam(body.toParentPath));
    const author = { name: request.authUser!.name, email: request.authUser!.email };
    gitSync.recordEditor(entry.space, author);
    // Rewrites links broken by the new location and commits the move as one unit (collab.movePage).
    const result = await collab.movePage(id, body.toParentPath, author);
    const after = snapshotPageChange(await storage.requireEntry(id));
    if (before.path !== after.path) await recordPageChange(request.authUser!.id, 'page.move', id, entry.space, before, after);
    gitSync.noteActivity(entry.space);
    return result;
  });

  app.post('/api/pages/:id/copy', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(copyPageBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'viewer');
    await session.requireSpaceRole(request, body.toSpace, 'editor');
    session.requireWriteScope(request);
    await session.requireAgentWriteAllowed(request.authUser!, body.toSpace, storage.normalizeDirParam(body.toParentPath));

    gitSync.recordEditor(body.toSpace, { name: request.authUser!.name, email: request.authUser!.email });
    // What this caller may not take along (pages page access hides from them, their private files, .agent) and whose the restricted copies become.
    const scope = await resolveCopyScope(request.authUser!, entry, body.includeChildren);
    const result = await storage.copyPage(id, body.toSpace, body.toParentPath, await liveCopyContent(entry), body.includeChildren, scope);
    const after = snapshotPageChange(await storage.requireEntry(result.id));
    await recordPageChange(request.authUser!.id, 'page.copy', result.id, body.toSpace, undefined, after);
    gitSync.noteActivity(body.toSpace);
    reply.status(201);
    return result;
  });

  /**
   * "Duplicate" (the owner, 01.10.2026): the page copied next to itself, whole
   * subtree included — see storage.duplicatePage. The same gates as /copy with
   * the destination filled in: read the source, write where it sits.
   */
  app.post('/api/pages/:id/duplicate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(duplicatePageBodySchema, request.body ?? {});
    const entry = await session.requirePageRole(request, id, 'viewer');
    await session.requireSpaceRole(request, entry.space, 'editor');
    session.requireWriteScope(request);
    await session.requireAgentWriteAllowed(request.authUser!, entry.space, storage.duplicateParentPath(entry));

    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    const scope = await resolveCopyScope(request.authUser!, entry, true);
    const result = await storage.duplicatePage(id, await liveCopyContent(entry), body.title, scope);
    const after = snapshotPageChange(await storage.requireEntry(result.id));
    await recordPageChange(request.authUser!.id, 'page.copy', result.id, entry.space, undefined, after);
    gitSync.noteActivity(entry.space);
    reply.status(201);
    return result;
  });

  /**
   * "New page from a template" (the owner, 19.10.2026): a template of the
   * space's `_templates/` folder — any kind, its subpages along — copied under
   * `parentPath`, its documents' {{date}}/{{author}}/{{title}} filled in.
   */
  app.post('/api/pages/from-template', async (request, reply) => {
    const body = parseBody(createFromTemplateBodySchema, request.body);
    const user = request.authUser!;
    const template = await session.requirePageRole(request, body.templateId, 'viewer');
    if (template.space !== body.space) throw badRequest('the template belongs to another space');
    if (!storage.isUnderTemplates(template.relPath)) throw badRequest('the page is not a template');
    const parentPath = storage.normalizeDirParam(body.parentPath);
    if (storage.isUnderTemplates(parentPath)) throw badRequest('a page cannot be created inside the templates folder');
    await session.requireSpaceRole(request, body.space, 'editor');
    session.requireWriteScope(request);
    await session.requireAgentWriteAllowed(user, body.space, parentPath);

    gitSync.recordEditor(body.space, { name: user.name, email: user.email });
    const scope = await resolveCopyScope(user, template, true);
    const result = await storage.createFromTemplate(template.id, body.space, parentPath, {
      title: body.title,
      author: user.name,
      liveContent: await liveCopyContent(template),
      scope,
    });
    // The copy's root must not announce itself as a template (its subpages never carry the property).
    await clearTemplateDescription(result.id, user);
    const after = snapshotPageChange(await storage.requireEntry(result.id));
    await recordPageChange(user.id, 'page.copy', result.id, body.space, undefined, after);
    gitSync.noteActivity(body.space);
    reply.status(201);
    return result;
  });

  /** "Use as template": the page copied into the space's `_templates/` folder (title kept). The same gates as /duplicate, the destination being `_templates`. */
  app.post('/api/pages/:id/make-template', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(makeTemplateBodySchema, request.body ?? {});
    const user = request.authUser!;
    const entry = await session.requirePageRole(request, id, 'viewer');
    await session.requireSpaceRole(request, entry.space, 'editor');
    session.requireWriteScope(request);
    await session.requireAgentWriteAllowed(user, entry.space, '_templates');
    if (storage.isUnderTemplates(entry.relPath)) throw badRequest('this page is already a template');
    if (entry.isIndex && entry.dirPath === '') throw badRequest('the space root cannot be a template');

    gitSync.recordEditor(entry.space, { name: user.name, email: user.email });
    const scope = await resolveCopyScope(user, entry, body.includeChildren);
    const result = await storage.makeTemplate(id, { includeChildren: body.includeChildren, liveContent: await liveCopyContent(entry), scope, title: body.title });
    if (body.description) await setTemplateDescription(result.id, body.description, user);
    const after = snapshotPageChange(await storage.requireEntry(result.id));
    await recordPageChange(user.id, 'page.copy', result.id, entry.space, undefined, after);
    gitSync.noteActivity(entry.space);
    reply.status(201);
    return result;
  });

  app.post('/api/pages/:id/rename', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(renamePageBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    assertDemoAgentRootIntact(request.authUser!, entry.relPath, 'Renaming the .agent folder');
    const before = snapshotPageChange(entry);
    session.requireWriteScope(request);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });

    let result: PageMeta;
    if (entry.kind === 'doc') {
      result = (await collab.applyH1Rename(id, body.title)) ? storage.toPageMeta(await storage.requireEntry(id)) : await storage.renameDocDirect(id, body.title);
      // Same rule as the live H1 edit: an auto-derived slug follows the title.
      await collab.maybeAutoRenameSlug(id, entry.title ?? null, body.title, { name: request.authUser!.name, email: request.authUser!.email });
      result = storage.toPageMeta(await storage.requireEntry(id));
    } else if (entry.kind === 'table') {
      // A table has an H1 too, but it lives in the `head` of a structured
      // Y.Doc. applyH1Rename already knows how to update a live table without
      // racing the CRDT; if the room is not open, only the H1 in the file is rewritten directly.
      result = (await collab.applyH1Rename(id, body.title))
        ? storage.toPageMeta(await storage.requireEntry(id))
        : await storage.renameTableFile(id, body.title);
    } else if (entry.kind === 'pdf' || entry.kind === 'office') {
      // A pdf/office page's title IS its filename (server/storage.ts's
      // titleFallback) — there is no separate title to edit; the slug-rename
      // endpoint (which renames the file itself) is the only way to change
      // what a pdf/office page is called.
      throw badRequest('a pdf/office page has no separate title — use the slug rename to change its filename');
    } else if (entry.kind === 'artifact') {
      // An artifact's title lives in its artifact.yaml; the folder keeps its name (the slug rename moves it).
      result = await setArtifactTitleIcon(id, { title: body.title }, request.authUser!);
    } else if (storage.isFreeNameKind(entry.kind)) {
      // A canvas / base is named by its file, as in Obsidian (owner, 16.10.2026): the new title IS the file name
      // (any valid one — spaces, Unicode), so renaming it is a file rename with the links, sidecar and commit of one.
      result = await collab.renamePageSlug(id, body.title, { name: request.authUser!.name, email: request.authUser!.email });
    } else if (entry.kind === 'form') {
      // Round FORMS: a form's title is a frontmatter field, not an H1 — no
      // collab room to consult, always a direct write (storage.ts's own note).
      result = await storage.renameFormDirect(id, body.title);
      // Owner ask (22.09.2026): the paired table's title follows the form's
      // — best-effort, see forms.renamePairedTableBestEffort's doc comment.
      const formDoc = await storage.readFreshFormDoc(id);
      await forms.renamePairedTableBestEffort(entry, formDoc.table, body.title.trim());
    } else {
      // Title only — the file itself (a board's slug) never moves; see
      // setBoardTitle's doc comment for the link-breaking bug this replaced.
      result = await storage.setBoardTitle(id, body.title);
    }
    gitSync.noteActivity(entry.space);
    const after = snapshotPageChange(await storage.requireEntry(id));
    // A canvas / base rename moved its file: it undoes as the slug change it is.
    if (storage.isFreeNameKind(entry.kind)) {
      if (before.path !== after.path) await recordPageChange(request.authUser!.id, 'page.slug', id, entry.space, before, after);
    } else if (before.title !== after.title) {
      await recordPageChange(request.authUser!.id, 'page.rename', id, entry.space, before, after);
    }
    return result;
  });

  /**
   * Round 22: change a page's SLUG (its file/directory basename, not its
   * title) — git-friendly renaming, distinct from /rename above (which only
   * ever edits the H1/filename-from-title and never touches incoming
   * links). Rewrites every incoming relative/`[[` link across the space and
   * lands as one dedicated commit; see collab.renamePageSlug's doc comment
   * for the full mechanics. 409 on a name collision, 400 on an invalid slug
   * (collab.renamePageSlug -> storage.renamePageSlug -> storage.validateSlug
   * throws before anything on disk moves).
   */
  app.post('/api/pages/:id/slug', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(renamePageSlugBodySchema, request.body);
    const entry = await session.requirePageRole(request, id, 'editor');
    assertDemoAgentRootIntact(request.authUser!, entry.relPath, 'Renaming the .agent folder');
    const before = snapshotPageChange(entry);
    session.requireWriteScope(request);
    const author = { name: request.authUser!.name, email: request.authUser!.email };
    gitSync.recordEditor(entry.space, author);
    const result = await collab.renamePageSlug(id, body.slug, author);
    const after = snapshotPageChange(await storage.requireEntry(id));
    if (before.path !== after.path) await recordPageChange(request.authUser!.id, 'page.slug', id, entry.space, before, after);
    return result;
  });

  app.delete('/api/pages/:id', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'editor');
    assertDemoAgentRootIntact(request.authUser!, entry.relPath, 'Deleting the .agent folder');
    session.requireWriteScope(request);
    const before = snapshotPageChange(entry);
    gitSync.recordEditor(entry.space, { name: request.authUser!.name, email: request.authUser!.email });
    // Trash round: the session user's id becomes trash_items.deleted_by ("who deleted it").
    await storage.deletePage(id, request.authUser!.id);
    gitSync.noteActivity(entry.space);
    // Personal history (undo): attach the trash record that deletePage has
    // just created above, so that undoPageChange can restore the page through
    // trash.restoreTrashItem. A missing id (the INSERT into trash_items did
    // not fail but has not been committed yet) must not break the response itself.
    const trashItemId = await findTrashItemId(id);
    if (trashItemId) {
      await recordPageChange(request.authUser!.id, 'page.delete', id, entry.space, before, { ...before, trashItemId });
    }
    return { ok: true };
  });

  app.get('/api/pages/:id/backlinks', async (request) => {
    const { id } = request.params as { id: string };
    // viewer+ on the TARGET; the SOURCES are filtered in SQL (accessSql.ts, search's rules) so a source page the
    // caller can't read never leaks its title/existence. One entry per link, with its syntax/fragment/line/context.
    await session.requirePageRole(request, id, 'viewer');
    const backlinks = await indexRead.getVisibleBacklinks(id, userViewer(request.authUser!));
    return { backlinks };
  });

  /** Graph view: the neighbourhood of a page — `?depth=1..3&direction=both|in|out` plus the space route's options. */
  app.get('/api/pages/:id/graph', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const q = request.query as Record<string, unknown>;
    const response: GraphResponse = await graph.getLocalGraph({ id: entry.id, space: entry.space }, userViewer(request.authUser!), {
      depth: graph.clampDepth(q?.depth),
      direction: graph.parseDirection(q?.direction),
      options: graph.parseGraphOptions(q),
      limit: graph.clampGraphLimit(q?.limit),
    });
    return response;
  });

  /** Index v2: the page's headings, ^blocks, tags, front matter, typed links and visible backlink count (PageMetadata). */
  app.get('/api/pages/:id/meta', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const meta: PageMetadata = await indexRead.getPageMetadata(entry, userViewer(request.authUser!));
    return meta;
  });

  /**
   * Wave 2 (Obsidian): an embedded note for the reading view's `![[Note#Heading]]` — the whole page, a heading
   * section or a `^block`, as markdown (server/embed.ts). viewer+ on the EMBEDDED page, exactly like reading it
   * (requirePageRole: `.agent` for admins only, a restricted page for its granted people). 400 for a non-document
   * or a `depth` outside 1..EMBED_MAX_DEPTH, 404 `fragment not found`.
   */
  app.get('/api/pages/:id/embed', async (request): Promise<EmbedPayload> => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    parseEmbedDepth(queryString(request.query, 'depth'));
    return buildEmbed(entry, queryString(request.query, 'fragment') || null);
  });

  /**
   * PROD BUG (round 25): web/src/markdown/PageTree.tsx — the `::pagetree`
   * directive's renderer — has fetched this endpoint since round 13, and the
   * server never had it. Its catch-all degradation ("any failure looks the
   * same from here") turned every 404 into "no child pages", so the directive
   * was broken on EVERY page of the instance, silently. viewer+ on the page's
   * own space, same gate as /backlinks next to it; the subtree never crosses
   * into another space, so there is nothing further to filter.
   */
  app.get('/api/pages/:id/subtree', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await session.requirePageRole(request, id, 'viewer');
    const depth = storage.clampSubtreeDepth(queryString(request.query, 'depth'));
    const children = await storage.getSubtree(entry, depth, await session.readablePageIds(request.authUser!, entry.space));
    return { children };
  });

  app.get('/api/pages/:id/history', async (request) => {
    const { id } = request.params as { id: string };
    await session.requirePageRole(request, id, 'viewer');
    const history: PageHistoryEntry[] = await gitSync.getPageHistory(id);
    return { history };
  });

  app.get('/api/pages/:id/history/:sha', async (request) => {
    const { id, sha } = request.params as { id: string; sha: string };
    await session.requirePageRole(request, id, 'viewer');
    return gitSync.getPageAtSha(id, sha);
  });

  app.post('/api/pages/:id/restore/:sha', async (request) => {
    const { id, sha } = request.params as { id: string; sha: string };
    const entry = await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    const user = request.authUser!;
    // A canvas is never written by Folio — not even to restore it (git or Obsidian can).
    if (entry.kind === 'canvas') throw badRequest('a canvas is read-only in Folio: restore it in Git or Obsidian');
    // An artifact is a folder: its versions are re-published (PUT /api/pages/:id/artifact), not restored file by file.
    if (entry.kind === 'artifact') throw badRequest('an artifact is restored by publishing that version again (PUT /api/pages/:id/artifact)');
    if (entry.kind === 'pdf' || entry.kind === 'office') {
      // Binary: the file at that commit is written back through the same path
      // as a replace (own commit, links rewritten if the extension differs).
      const restored = await restoreFilePageVersion(id, sha, { name: user.name, email: user.email });
      recordAudit(user.id, 'page.file.restored', id, { sha, to: restored.meta.path });
      return restored.meta;
    }
    const atSha = await gitSync.getPageAtSha(id, sha);
    gitSync.recordEditor(entry.space, { name: user.name, email: user.email });

    let result: PageMeta;
    if (entry.kind === 'base') {
      // The `.base` file at that commit, written back as it was (one debounced commit, like any base edit).
      if (atSha.markdown === undefined) throw badRequest('revision has no content');
      const text = atSha.markdown;
      await storage.writeBaseRaw(id, () => text);
      result = storage.toPageMeta(await storage.requireEntry(id));
    } else if (entry.kind === 'board') {
      // The normal board PUT path (never a git checkout of the file) — same
      // function, so its blank-overwrite guard is active here too by default: a
      // restore-to-blank is unusual enough to be worth the same confirmation a
      // direct blank save would need. A historical revision that's legitimately
      // blank (e.g. the placeholder scene from the moment the board was created)
      // can still be restored with ?force=1 — when no room is live; a restore
      // while the board is open in a live room always goes through the same
      // guard editBoardScene enforces (see writeBoardSvgLiveAware), same as
      // every other board write path this round unifies.
      if (atSha.svg === undefined) throw badRequest('revision has no svg content');
      const force = queryString(request.query, 'force') === '1';
      result = await writeBoardSvgLiveAware(id, atSha.svg, force);
    } else if (entry.kind === 'table') {
      // Round 26: a table must NOT go through editDocBody below — that writes
      // the prose Y.Text room, but a live table's room is the structured
      // Y.Doc, so the edit would land in the wrong place and be overwritten by
      // whatever the structured doc still held. tables.restoreTableFromMarkdown
      // parses the raw revision (getPageAtSha returns a table's file WITH its
      // frontmatter, i.e. its schema) and applies it as one by-key replace.
      if (atSha.markdown === undefined) throw badRequest('revision has no markdown content');
      result = await tables.restoreTableFromMarkdown(id, atSha.markdown);
    } else if (entry.kind === 'form') {
      // Round FORMS: same "raw file, no collab room" shape as the PUT
      // handler above — restoring is a direct write of the historical file.
      if (atSha.markdown === undefined) throw badRequest('revision has no markdown content');
      const parsedForm = parseFormFile(atSha.markdown);
      if (isFormParseError(parsedForm)) throw badRequest(`revision is not a valid form: ${parsedForm.message}`);
      result = await storage.writeFormDoc(id, parsedForm);
    } else {
      if (atSha.markdown === undefined) throw badRequest('revision has no markdown content');
      // Same content-replace path as a normal PUT (never a git checkout of the file) —
      // restoring is just "set the content to what it was", live-doc-aware like any edit.
      result = await collab.editDocBody(id, atSha.markdown);
    }
    gitSync.noteActivity(entry.space);
    return result;
  });

  // --- Share links (round 8) -----------------------------------------------

  // Cookie-only, all four: a share link IS a credential (ShareLinkInfo.url
  // embeds the live token, and an `edit` token writes the page as a guest,
  // outside any PAT scope and under a different audit identity). Same
  // reasoning as the invite routes below — security review F-03 found a
  // `scopes: ['read']` token of an editor reading back live edit URLs here.
  app.get('/api/pages/:id/shares', async (request) => {
    const { id } = request.params as { id: string };
    session.requireCookieAuth(request);
    await session.requirePageRole(request, id, 'editor');
    const list: ShareLinkInfo[] = await shares.listSharesForPage(id, requestOrigin(request));
    return { shares: list };
  });

  app.post('/api/pages/:id/shares', async (request, reply) => {
    assertNotDemo('Creating a share link');
    const { id } = request.params as { id: string };
    session.requireCookieAuth(request);
    await session.requirePageRole(request, id, 'editor');
    session.requireWriteScope(request);
    const body = parseBody(createShareLinkBodySchema, request.body);
    // Round 23: includeChildren rides on the TOKEN, never on a per-request query
    // param — see db/migrations/017_share_include_children.sql for why.
    const created = await shares.createShareLink(id, request.authUser!.id, body.mode, requestOrigin(request), body.includeChildren);
    recordAudit(request.authUser!.id, 'share.created', created.id, { pageId: id, mode: body.mode, includeChildren: body.includeChildren });
    reply.status(201);
    return created;
  });

  /** Round 23 follow-up: flip includeChildren on an existing link — same creator-or-space-admin gate as revoke below (it can WIDEN what an already-distributed link exposes). */
  app.patch('/api/shares/:id', async (request) => {
    const { id } = request.params as { id: string };
    session.requireCookieAuth(request);
    const body = parseBody(updateShareLinkBodySchema, request.body);
    session.requireWriteScope(request);
    const share = await shares.getShareForRevoke(id);
    if (!share) throw notFound('share link');
    const entry = await storage.requireEntry(share.pageId);
    const user = request.authUser!;
    const isCreator = share.createdBy === user.id;
    const role = await session.effectivePageRole(user, entry);
    if (!isCreator && !session.roleAtLeast(role, 'editor')) {
      throw forbidden('only the link creator or a page editor can change it');
    }
    await shares.setShareIncludeChildren(id, body.includeChildren);
    recordAudit(user.id, 'share.updated', id, { includeChildren: body.includeChildren });
    const list: ShareLinkInfo[] = await shares.listSharesForPage(share.pageId, requestOrigin(request));
    return { shares: list };
  });

  app.delete('/api/shares/:id', async (request) => {
    const { id } = request.params as { id: string };
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const share = await shares.getShareForRevoke(id);
    if (!share) throw notFound('share link');
    const entry = await storage.requireEntry(share.pageId);
    const user = request.authUser!;
    const isCreator = share.createdBy === user.id;
    const role = await session.effectivePageRole(user, entry);
    if (!isCreator && !session.roleAtLeast(role, 'editor')) {
      throw forbidden('only the link creator or a page editor can revoke it');
    }
    await shares.revokeShare(id);
    recordAudit(user.id, 'share.revoked', id);
    return { ok: true };
  });

  // --- Invites by link (round 9) -------------------------------------------

  // Cookie-only, all three: an invite IS a credential — InviteInfo.url embeds
  // the live invite token, and accepting one grants space membership (or even
  // instance-admin). Listing them via a stolen PAT would hand over working
  // access links; minting one would be self-escalation with persistence.
  // Exactly the reasoning /api/me/tokens and /api/me/git-credentials already
  // use (auth/routes.ts). QA-3 found `GET /api/invites` returning live invite
  // URLs to a `scopes: ['read']` token.
  app.get('/api/invites', async (request) => {
    session.requireCookieAuth(request);
    const user = request.authUser!;
    const list: InviteInfo[] = user.isAdmin
      ? await invites.listAllInvites(requestOrigin(request))
      : await invites.listInvitesCreatedBy(user.id, requestOrigin(request));
    return { invites: list };
  });

  app.post('/api/invites', async (request, reply) => {
    assertNotDemo('Creating an invite');
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const user = request.authUser!;
    const body = parseBody(createInviteBodySchema, request.body);

    const groupIds = [...new Set(body.groupIds ?? [])];
    if (!user.isAdmin) {
      // Space admin: can only grant memberships in spaces THEY currently admin,
      // and can never grant instance-admin — enforced here, not just hidden in
      // the UI, since a stolen/forged request must not be able to self-escalate.
      // A group manager (053) may invite into the groups they manage.
      if (body.isAdmin) throw forbidden('only an instance admin can grant instance-admin via an invite');
      const myMemberships = await session.membershipsFor(user);
      if (!Object.values(myMemberships).some((role) => role === 'admin') && !(await groupRoutes.managesAnyActiveGroup(user))) {
        throw forbidden('requires instance admin, or admin role in at least one space, to create invites');
      }
      for (const m of body.memberships) {
        if (myMemberships[m.space] !== 'admin') throw forbidden(`requires admin role in space "${m.space}" to invite into it`);
      }
    }
    await groupRoutes.assertMayInviteIntoGroups(user, groupIds);

    const created = await invites.createInvite(
      { memberships: body.memberships, isAdmin: body.isAdmin, expiresInDays: body.expiresInDays, maxUses: body.maxUses, email: body.email, groupIds },
      user.id,
      requestOrigin(request),
    );
    recordAudit(user.id, 'invite.created', created.id, { memberships: body.memberships, isAdmin: body.isAdmin, maxUses: body.maxUses, ...(groupIds.length ? { groupIds } : {}) });
    reply.status(201);
    return created;
  });

  app.delete('/api/invites/:id', async (request) => {
    assertNotDemoAccount(request.authUser!, 'Revoking an invite');
    const { id } = request.params as { id: string };
    session.requireCookieAuth(request);
    session.requireWriteScope(request);
    const user = request.authUser!;
    const invite = await invites.getInviteForRevoke(id);
    if (!invite) throw notFound('invite');
    if (invite.createdBy !== user.id && !user.isAdmin) {
      throw forbidden('only the invite creator or an instance admin can revoke it');
    }
    await invites.revokeInvite(id);
    recordAudit(user.id, 'invite.revoked', id);
    return { ok: true };
  });

  // --- Confluence import (round 12) ---------------------------------------

  app.post('/api/import/confluence', async (request, reply) => {
    assertNotDemo('Importing from Confluence');
    session.requireWriteScope(request);
    const user = request.authUser!;
    const body = parseBody(confluenceImport.confluenceImportBodySchema, request.body);

    // Round 22b: credentialId (a saved Confluence credential) instead of a
    // raw token, with the raw `auth` + save=true path kept for one-off
    // imports — resolveImportAuth turns either shape into a concrete auth
    // object and (save=true only) persists it for next time. Same
    // "resolve before the async job starts" shape as targetSpace below.
    const auth = await confluenceImport.resolveImportAuth(user.id, body.pageUrl, {
      credentialId: body.credentialId,
      auth: body.auth,
      save: body.save,
    });

    // Round 24: a /whiteboard/<id> URL imports as a BOARD, not a markdown
    // page. The branch itself lives in runImportJob; this call is only here
    // to reject the two shapes that can never work (an on-prem whiteboard
    // URL, or a Cloud one with a PAT instead of an email + API token) as a
    // synchronous 400 the dialog can show, rather than as a job that starts,
    // spins and then fails. Ordinary page URLs are unaffected — they never
    // match, and this returns { kind: 'page' } for them.
    confluenceImport.resolveImportTarget(body.pageUrl, auth);

    // Bug fix: targetSpace is EITHER an existing space's slug ("existing
    // space" mode) OR the desired NAME of a space that doesn't exist yet
    // ("new space" mode) — resolveOrCreateTargetSpace tells them apart (by
    // slug or by translit(name)) and creates the latter on the spot, with
    // the caller as its admin, same as POST /api/spaces. Only an EXISTING
    // target needs the editor+ check; anyone may create a new space.
    let targetSpace = body.targetSpace;
    if (targetSpace) {
      const resolved = await confluenceImport.resolveOrCreateTargetSpace(targetSpace, user.id);
      if (!resolved.isNew) await session.requireSpaceRole(request, resolved.slug, 'editor');
      targetSpace = resolved.slug;
    }

    const job = confluenceImport.startImportJob(
      { pageUrl: body.pageUrl, auth, targetSpace, targetPath: body.targetPath, includeChildren: body.includeChildren },
      user.id,
      { name: user.name, email: user.email, lang: resolveTextLanguage(user.lang, request.headers['accept-language']) },
    );
    recordAudit(user.id, 'import.confluence.started', job.id, {
      pageUrl: body.pageUrl,
      targetSpace: targetSpace ?? null,
      usedSavedCredential: Boolean(body.credentialId),
    });
    reply.status(201);
    return job;
  });

  app.get('/api/import/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const user = request.authUser!;
    const owner = confluenceImport.getJobOwner(id);
    if (owner === undefined) throw notFound('import job');
    // Same "creator or instance admin" pattern as shares/invites revocation —
    // a job in progress carries page titles from the source wiki (never the
    // auth token, which is stripped everywhere an error message is built),
    // but titles alone are still someone's content and not public.
    if (owner !== user.id && !user.isAdmin) throw forbidden('only the job\'s owner or an instance admin can view it');
    return confluenceImport.getJob(id);
  });

  // --- Search / resolve ---------------------------------------------------

  app.get('/api/search', async (request) => {
    const user = request.authUser!;
    const q = queryString(request.query, 'q');
    const spaceParam = queryString(request.query, 'space');

    if (spaceParam) await session.requireSpaceRole(request, spaceParam, 'viewer');

    const hits: SearchHit[] = await searchPages(q, {
      userId: user.id,
      space: spaceParam || undefined,
      isInstanceAdmin: user.isAdmin,
      limit: clampSearchLimit(queryString(request.query, 'limit')),
      offset: clampSearchOffset(queryString(request.query, 'offset')),
    });
    return { hits };
  });

  app.get('/api/resolve', async (request) => {
    const space = queryString(request.query, 'space');
    const path = queryString(request.query, 'path');
    // QA-3: an EMPTY path means "the root of this space" and is a legitimate ask —
    // storage.resolve normalizes it to '' and then walks index.md -> README.md,
    // which is exactly what a caller who doesn't know the root page's name needs.
    // Only `space` is genuinely required.
    if (!space) throw badRequest('space is required');
    await session.requireSpaceRole(request, space, 'viewer');
    const resolved = await storage.resolve(space, path);
    if (resolved) await session.requirePageRole(request, resolved.id, 'viewer');
    return resolved;
  });
}

/**
 * Public (round 8): no session needed at all — registered in index.ts's
 * PUBLIC scope alongside /api/auth/*, never the protected one. A share
 * token grants access to exactly the ONE page it was created for; nothing
 * here ever touches a space-level or instance-level permission.
 */
export function registerPublicShareRoutes(app: FastifyInstance): void {
  app.get('/api/share/:token', async (request, reply): Promise<SharedPagePayload> => {
    const { token } = request.params as { token: string };
    // R23 tail (child navigation): resolveShareScope instead of the old
    // resolveShareToken + getEntry pair — same resolve path (revoked/unknown/
    // page-gone all come back undefined and 404 identically, so revocation
    // still kills the root AND every child fetch instantly), plus the
    // collected subtree this payload now carries.
    const scope = await resolveShareScope(token);
    if (!scope) throw notFound('share link');
    const { share } = scope;

    // Search engines must never index a page reachable only because someone has
    // the secret link — this is "unlisted", not "public".
    reply.header('X-Robots-Tag', 'noindex');

    /**
     * `?page=<id>` (R23 tail): the same payload with a CHILD of the shared
     * subtree as `page`, so a human can OPEN the pages the token already
     * collates. Membership is `collected.ids` — the index-based set behind
     * shareGrantsPage (shareScope.ts), never a path-prefix comparison, so
     * `foo-bar.md` does not pass as a child of `foo.md`. A token without
     * includeChildren has only its own page in the set, and any miss is the
     * same non-probing 404 as an unknown token (never a 403: a public
     * endpoint must not let a prober distinguish "real token, page outside
     * its scope" from "no such token").
     */
    const requestedId = queryString(request.query, 'page');
    let entry = scope.root;
    let mode = share.mode;
    if (requestedId && requestedId !== scope.root.id) {
      if (!scope.collected.ids.has(requestedId)) throw notFound('share link');
      const childEntry = await storage.getEntry(requestedId);
      if (!childEntry) throw notFound('share link'); // indexed a moment ago, deleted since
      entry = childEntry;
      // Children through a share are READ-ONLY by construction, whatever the
      // token's mode: the collab WS gate (server/collab.ts) grants a share
      // token exactly its own page's room, and PUT /api/share/:token/board
      // writes the token's own page — an "edit" child payload would promise a
      // surface that either cannot connect or, worse for boards, would save
      // over the ROOT page. The mode field stays honest instead.
      mode = 'view';
    }

    const spaceInfo = await storage.getSpaceInfo(entry.space);
    const spaceName = spaceInfo?.name ?? entry.space;

    // A canvas's file cards open what the share itself opens — its own page set.
    const page: PageDoc = await buildPageDoc(entry, { kind: 'share', pageIds: scope.collected.ids });

    const payload: SharedPagePayload = { mode, page, spaceName };
    if (share.includeChildren) {
      // Attached on EVERY payload of a subtree token (root and child alike),
      // so the guest's navigation survives opening a child. Absent otherwise —
      // old clients and single-page shares see the exact pre-R23-tail shape.
      payload.children = subtreeFromCollected(scope.collected);
      payload.rootPageId = scope.root.id;
    }

    // A signed-in visitor who could already open this page by their own rights is sent to their own account
    // (the client replaces the location). Only such a visitor sees the field, so it reveals nothing new; the
    // answer depends on the cookie, so it must never be shared between visitors by a cache.
    reply.header('Cache-Control', 'private, no-store');
    const viewer = await session.userForToken(request.cookies?.[session.SESSION_COOKIE_NAME]);
    if (viewer) {
      const role = await session.effectivePageRole(viewer, entry).catch(() => undefined);
      if (session.roleAtLeast(role, 'viewer')) payload.ownAccess = { space: entry.space, pageId: entry.id };
    }
    return payload;
  });

  /**
   * The FILE links of a shared page (`![[diagram.png]]` found in `attachments/`, `![[spec.pdf]]`), for the reading view
   * and the live editor of a guest: what was written -> where the file is. Nothing else leaves: no page link, no id, no
   * line context, and only a file the share itself may read (the same decision as GET /files/...?share=), so a by-name
   * target outside the share's scope stays as written (and 403s as before). The page is the token's own or, with
   * includeChildren, a member of its collected set - any other id is the same 404 as an unknown token.
   */
  app.get('/api/share/:token/links', async (request, reply): Promise<PublicPageLinks> => {
    const { token } = request.params as { token: string };
    const scope = await resolveShareScope(token);
    if (!scope) throw notFound('share link');
    reply.header('X-Robots-Tag', 'noindex');
    const pageId = queryString(request.query, 'page') || scope.root.id;
    if (!scope.collected.ids.has(pageId)) throw notFound('share link');
    const all = await indexRead.getPageLinks(pageId, { kind: 'user', userId: '00000000-0000-0000-0000-000000000000', isInstanceAdmin: true });
    const links: PageLinkRef[] = [];
    for (const link of all) {
      const isFile = link.kind === 'asset' || (link.kind === 'page' && !/\.mdx?$/i.test(link.targetPath) && /\.[a-z0-9]+$/i.test(link.targetPath));
      if (!isFile || !link.targetPath) continue;
      if (!(await shareMayReadFile(scope, scope.root.space, link.targetPath))) continue;
      links.push({ ...link, kind: 'asset', targetPageId: null, fragment: null, fragmentKind: null, fragmentResolved: null, displayText: null, context: '' });
    }
    return { links };
  });

  // Round 29: boards ARE now Yjs-collaborative — an edit-mode share guest's
  // board editor opens the SAME /collab room as a logged-in editor (see
  // collab.ts's attachToServer, share-token branch). This PUT stays as the
  // edit-mode share's own save path (the share UI never opened a WS
  // connection before this round; kept working here for compatibility either
  // way), but now goes through writeBoardSvgLiveAware so it never diverges
  // from a room the same board might have open concurrently.
  app.put('/api/share/:token/board', async (request) => {
    const { token } = request.params as { token: string };
    const share = await shares.resolveShareToken(token);
    // Deliberately 404 (not 403) for a real-but-view-mode token too — a public
    // endpoint shouldn't let a prober distinguish "wrong mode" from "no such
    // token" from the response shape alone.
    if (!share || share.mode !== 'edit') throw notFound('share link');
    const entry = await storage.requireEntry(share.pageId);
    if (entry.kind !== 'board') throw badRequest('this share link is not for a board page');
    const body = parseBody(updatePageBodySchema, request.body);
    if (body.svg === undefined) throw badRequest('svg is required for a board page');

    const guestIdentity = { name: `Guest via share ${share.id.slice(0, 8)}`, email: 'guest@folio.local' };
    gitSync.recordEditor(entry.space, guestIdentity);
    const force = queryString(request.query, 'force') === '1';
    const result = await writeBoardSvgLiveAware(share.pageId, body.svg, force);
    gitSync.noteActivity(entry.space);
    recordAudit(null, 'share.board_edit', share.pageId, { source: 'share', shareId: share.id });
    return result;
  });
}

/**
 * Public (round 9): no session needed — registered in index.ts's PUBLIC scope
 * alongside /api/auth/* and the share routes above. GET never 401s: validity
 * (and WHY invalid) is part of the payload (InvitePublicInfo), so the accept
 * screen can render a helpful message instead of a generic error page.
 */
export function registerPublicInviteRoutes(app: FastifyInstance): void {
  app.get('/api/invite/:token', async (request): Promise<InvitePublicInfo> => {
    const { token } = request.params as { token: string };
    const invite = await invites.getInviteByToken(token);
    const reason = invites.invalidReason(invite);
    if (reason || !invite) {
      return { valid: false, reason: reason ?? 'not_found', email: invite?.email ?? null, spaces: [], invitedBy: invite?.createdByName ?? '' };
    }

    const spaces = await Promise.all(
      invite.memberships.map(async (m) => {
        const info = await storage.getSpaceInfo(m.space);
        return { space: m.space, name: info?.name ?? m.space, role: m.role };
      }),
    );
    // A pinned email that a single sign-on provider serves: offer (or, when enforced, require) accepting through it.
    const provider = invite.email ? await authProviders.providerForEmail(invite.email) : undefined;
    return {
      valid: true,
      email: invite.email,
      spaces,
      invitedBy: invite.createdByName,
      ...(provider ? { sso: { ...toPublicProvider(provider), enforced: provider.enforceSso } } : {}),
    };
  });

  app.post('/api/invite/:token/accept', async (request, reply): Promise<AuthState> => {
    // Same limiter as login (DEV-PLAN: "rate limit as for login") — this endpoint
    // creates accounts from an unauthenticated request, at least as attractive
    // a target for brute-forcing/enumeration as login itself.
    const rl = await session.checkLoginRateLimit(request.ip);
    if (rl.limited) {
      reply.header('Retry-After', String(rl.retryAfterSeconds));
      throw tooManyRequests('too many attempts, try again later');
    }

    const { token } = request.params as { token: string };
    const rawBody = request.body;
    const normalizedBody =
      typeof rawBody === 'object' && rawBody !== null && typeof (rawBody as { username?: unknown }).username === 'string'
        ? { ...rawBody, username: (rawBody as { username: string }).username.toLowerCase() }
        : rawBody;
    const body = parseBody(acceptInviteBodySchema, normalizedBody);
    const email = body.email.trim();

    // Fast pre-check (cheap, no writes) — lets an already-dead token fail
    // immediately without spending an email lookup on a doomed request. The
    // REAL, race-safe check is claimInviteUse below; this is not relied on
    // for correctness under concurrency, only for a quick, cheap rejection.
    const invite = await invites.getInviteByToken(token);
    const reason = invites.invalidReason(invite);
    if (reason) throw gone(`this invite is no longer valid (${reason})`);

    if (await authStore.findStoredUserByEmail(email)) throw conflict('a user with this email already exists');
    // A domain that must use single sign-on never gets a password account from an invite: the invite is accepted
    // through the provider instead (/api/auth/oidc/<slug>/start?invite=<token>), which links on that first sign-in.
    const enforced = await authProviders.enforcedProviderForEmail(email);
    if (enforced) throw ssoRequired(enforced, 'this email domain signs in with single sign-on: accept the invite through it');
    if (invite!.email && invite!.email.trim().toLowerCase() !== email.toLowerCase()) {
      throw badRequest('this invite is pinned to a different email address');
    }

    // The atomic claim — see invites.claimInviteUse's doc comment for exactly
    // how this closes the two-concurrent-accepts-on-max_uses=1 race. Anything
    // that changed since the pre-check above (revoked/expired/exhausted by a
    // concurrent request) surfaces here as the same 410.
    const claimed = await invites.claimInviteUse(token);
    if (!claimed) throw gone('this invite is no longer valid (exhausted, revoked, or expired)');

    const passwordHash = await hashPassword(body.password);
    const user = await authStore.createUser({ email, name: body.name.trim(), username: body.username, passwordHash, isAdmin: claimed.isAdmin });
    for (const m of claimed.memberships) {
      await authStore.setMembership(m.space, user.id, m.role);
    }
    await groupRoutes.joinInviteGroups(user.id, claimed.groupIds);

    const { token: sessionToken } = await authStore.createSession(user.id);
    session.setSessionCookie(reply, sessionToken);
    recordAudit(user.id, 'invite.accepted', claimed.id, { email });

    reply.status(201);
    return { needsSetup: false, user, memberships: await session.membershipsFor(user), ...(await ssoState()) };
  });
}
