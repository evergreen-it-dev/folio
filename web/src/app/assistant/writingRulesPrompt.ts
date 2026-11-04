/**
 * The two messages behind "Check against writing rules" (page header) and its follow-up "Fix with Agent".
 *
 * The check is an ordinary Ask-mode assistant run: the model calls the read-only MCP tool
 * `check_page_writing_rules` (the space's `.agent/writing-rules.md` plus the page text, server/writingRules.ts)
 * and answers in one fixed Markdown shape, which the chat panel renders as a list of findings. The messages
 * are English because they are instructions to the model; the language of the answer follows `uiLanguage`
 * (everything the model says about the page: rule names, explanations, the closing sentence) while rewrites stay in
 * the language of the page. The chat does not show these prompts: the panel shows a short label instead
 * (`displayMessage`, i18n `assistant.writingRules.checkDisplay` / `fixDisplay`).
 */

/** The interface language ('en', 'uk-UA', ...) as the name the prompt uses; English for anything without a bundle of its own. */
export function writingRulesLanguageName(language: string | undefined): 'Ukrainian' | 'English' {
  return /^uk(\b|[-_])/i.test(language ?? '') ? 'Ukrainian' : 'English';
}

export interface WritingRulesCheckTarget {
  pageId: string;
  title: string;
  /** Interface language name for the answer, e.g. 'Ukrainian' / 'English'. */
  uiLanguage: string;
}

export function writingRulesCheckMessage({ pageId, title, uiLanguage }: WritingRulesCheckTarget): string {
  return [
    `Check the page "${title}" (id ${pageId}) against the writing rules of this space. This is read-only: change nothing.`,
    `Call check_page_writing_rules with page "${pageId}", then compare the page text with every rule.`,
    'Report real violations only, the most important first, at most 15. Use exactly this format for each finding:',
    '',
    '### <number>. <rule name>',
    '> <the fragment of the page that breaks the rule, copied verbatim>',
    '',
    '**Suggested rewrite:** <the fragment rewritten to follow the rule, same meaning>',
    '',
    `Write everything you say about the page (rule names, explanations, any closing sentence) in ${uiLanguage}, whatever language these instructions are in; keep each rewrite in the language of the page. If the page follows all the rules, say so in one sentence and list nothing. If the tool reports that the space has no writing rules, say that and stop.`,
  ].join('\n');
}

export function writingRulesFixMessage({ pageId, title, uiLanguage }: Pick<WritingRulesCheckTarget, 'pageId' | 'title'> & Partial<Pick<WritingRulesCheckTarget, 'uiLanguage'>>): string {
  return [
    `Apply the suggested rewrites from your findings above to the page "${title}" (id ${pageId}).`,
    'Read the page first, replace only the quoted fragments (skip a fragment that no longer appears), and leave everything else exactly as it is.',
    `Then read the page again and tell me in a few lines what you changed${uiLanguage ? `, in ${uiLanguage}` : ''}.`,
  ].join('\n');
}
