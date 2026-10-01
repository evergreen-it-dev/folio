export interface TemplateVars {
  date: string; // YYYY-MM-DD
  author: string;
  title: string;
}

/** Today's date as YYYY-MM-DD in the local timezone (not UTC — toISOString would shift the date near midnight). */
export function todayDateStamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Substitutes {{date}}, {{author}}, {{title}} (whitespace inside the braces
 * tolerated, e.g. `{{ date }}`) in a template's markdown body. Anything not
 * matching one of the three known placeholders is left exactly as-is —
 * unrecognized `{{...}}` text in a template is far more likely a literal
 * example than a typo worth silently swallowing.
 */
export function substituteTemplate(markdown: string, vars: TemplateVars): string {
  return markdown.replace(/\{\{\s*(date|author|title)\s*\}\}/g, (_match, key: keyof TemplateVars) => vars[key]);
}
