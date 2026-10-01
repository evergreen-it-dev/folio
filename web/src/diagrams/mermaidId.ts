/**
 * Sanitize a React `useId()`-style value (e.g. ":r0:") into a string that's
 * safe to use as the SVG/DOM id mermaid.render() needs. Pure, dependency-free
 * so it's cheap to unit test without pulling in the (heavy, DOM-touching)
 * mermaid package itself.
 */
export function sanitizeMermaidId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  return `mermaid-${cleaned || 'diagram'}`;
}
