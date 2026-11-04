/**
 * The pure half of the agent-readable files of a public site (publicLlms.ts): which page kinds have a Markdown
 * form, whether the files are on for a site, and their URLs. Split out so the HTML head (publicSiteMeta.ts) can
 * advertise them without importing the module that renders them.
 */
import type { SiteSettings } from '../shared/contracts.js';
import { siteIndexable, type PublicSpace } from './publicSites.js';
import type { PageIndexEntry } from './storage.js';

/** The page kinds that read as text; forms, PDF/office files and artifacts have nothing useful to give an agent. */
export const MARKDOWN_KINDS: ReadonlySet<PageIndexEntry['kind']> = new Set(['doc', 'table', 'board', 'canvas', 'base']);

/** Whether the agent files are served for this site: not switched off in site.json (`"llms": false`), and the site may be indexed at all. */
export function llmsEnabled(record: Pick<PublicSpace, 'indexing'>, site: Pick<SiteSettings, 'llms'>): boolean {
  return site.llms !== false && siteIndexable(record);
}

/** `<base>/p/<id>.md`; the home page is `<base>/index.md`. `base` has no trailing slash. */
export function markdownPageUrl(base: string, pageId: string, homePageId: string | null): string {
  return pageId === homePageId ? `${base}/index.md` : `${base}/p/${encodeURIComponent(pageId)}.md`;
}

export function llmsTxtUrl(base: string): string {
  return `${base}/llms.txt`;
}
