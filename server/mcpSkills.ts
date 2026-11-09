/**
 * Team skills over MCP (wave "skills"): a skill is an ordinary doc page tagged `skill`. Its name is the page title,
 * its short description the front matter `description`. Nothing is stored apart from the pages: every call asks the
 * page index again, so a page tagged in the browser is visible to the next call without a server restart, and the
 * list is the caller's own (searchPages applies the same ACL as every other read). A public-site actor has no
 * skills at all: those pages are instructions for the team's agents, not published content.
 *
 * The skills the server ships to its own assistant (server/assistant/skills/, read_skill) keep their names: a team
 * page with the same title is left out here, so the built-in one wins.
 */
import { query } from './db/pool.js';
import { searchPages } from './search.js';
import { listAssistantSkillNames } from './assistant/workspace.js';
import * as storage from './storage.js';
import * as collab from './collab.js';
import type { User } from '../shared/contracts.js';

export const SKILL_TAG = 'skill';
/** Skills per answer at most (the search window's own maximum). */
const SKILLS_LIMIT = 100;

export interface TeamSkill {
  name: string;
  description: string;
  id: string;
  space: string;
  path: string;
  updatedAt: string;
}

/** The skills this user may read, by name. */
export async function listTeamSkills(user: User): Promise<TeamSkill[]> {
  if (user.disabled) return [];
  const hits = await searchPages(`tag:${SKILL_TAG}`, { userId: user.id, isInstanceAdmin: user.isAdmin, limit: SKILLS_LIMIT });
  // tag:skill also finds skill/<child> tags and templates; a skill is a doc carrying exactly `skill`.
  const pages = hits.filter((h) => h.kind === 'doc' && (h.tags ?? []).includes(SKILL_TAG) && !h.path.startsWith('_templates/'));
  if (pages.length === 0) return [];
  const rows = await query<{ id: string; frontmatter: Record<string, unknown> | null; updated_at: string | Date }>(
    'SELECT id, frontmatter, updated_at FROM pages_index WHERE id = ANY($1::text[])',
    [pages.map((p) => p.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const builtIn = new Set(await listAssistantSkillNames());
  const skills: TeamSkill[] = [];
  for (const p of pages) {
    if (builtIn.has(p.title)) continue;
    const row = byId.get(p.id);
    const description = row?.frontmatter?.description;
    skills.push({
      name: p.title,
      description: typeof description === 'string' ? description.trim() : '',
      id: p.id,
      space: p.space,
      path: p.path,
      updatedAt: row ? new Date(row.updated_at).toISOString() : '',
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A prompt name is an identifier: the title lowercased, other characters as dashes. */
export function skillPromptName(skill: TeamSkill, all: TeamSkill[]): string {
  const slug = skill.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'skill';
  const clash = all.some((s) => s.id !== skill.id && s.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') === slug);
  return clash ? `${slug}-${skill.id.slice(0, 8)}` : slug;
}

export type SkillLookup = { skill: TeamSkill } | { error: string };

/** One skill by page id, exact title (case-insensitive) or prompt name. Several skills of one title: ask for the id. */
export function findSkill(all: TeamSkill[], ref: string): SkillLookup {
  const wanted = ref.trim();
  if (!wanted) return { error: 'skill not found; call list_skills' };
  const byId = all.find((s) => s.id === wanted);
  if (byId) return { skill: byId };
  const lower = wanted.toLowerCase();
  const matches = all.filter((s) => s.name.toLowerCase() === lower || skillPromptName(s, all) === lower);
  if (matches.length === 1) return { skill: matches[0] };
  if (matches.length > 1) return { error: `several skills are named "${wanted}"; pass one of these page ids: ${matches.map((s) => `${s.id} (${s.space})`).join(', ')}` };
  return { error: 'skill not found; call list_skills' };
}

/** The page text as read_page gives it: the live document when someone is editing, else the file. */
export async function readSkillText(skill: TeamSkill): Promise<string> {
  if (collab.isDocLive(skill.id)) {
    const live = collab.getLiveText(skill.id);
    if (live !== undefined && live !== null) return live;
  }
  return storage.readFreshDocBody(skill.id);
}
