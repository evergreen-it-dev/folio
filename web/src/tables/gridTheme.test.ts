import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The grid's dark theme once keyed off a `.dark` ancestor class. Nothing in
 * this app sets that class (the theme is `data-theme` on <html> plus
 * `prefers-color-scheme`, see styles.css), so the rule never matched and a data
 * table stayed white with black text inside a dark page. These checks pin the
 * selectors to the real switch.
 */

// Read from disk: `grid.css?raw` comes back empty under vitest's CSS handling.
const css = readFileSync(resolve(process.cwd(), 'web/src/tables/grid.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { body }` rule, including the ones nested in an @media block. */
function rules(source: string): { selector: string; body: string }[] {
  return (source.match(/[^{}]+\{[^{}]*\}/g) ?? []).map((rule) => {
    const [selector, body] = rule.split('{');
    return { selector: selector.replace(/^[\s\S]*@media[^{]*$/, '').trim(), body: body.replace('}', '') };
  });
}

function customProperties(body: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found[match[1]] = match[2].trim();
  return found;
}

const SYSTEM_DARK = "html:not([data-theme='light']) .folio-table-grid";
const EXPLICIT_DARK = "html[data-theme='dark'] .folio-table-grid";

describe('grid.css theme switch', () => {
  it('has no selector that relies on a .dark class', () => {
    expect(css).not.toMatch(/\.dark\b/);
  });

  it('applies the system dark tokens only inside prefers-color-scheme: dark', () => {
    const media = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{(?:[^{}]*\{[^{}]*\})+\s*\}/g) ?? [];
    expect(media.some((block) => block.includes(`${SYSTEM_DARK} {`))).toBe(true);
    const outside = media.reduce((rest, block) => rest.replace(block, ''), css);
    expect(outside).not.toContain(SYSTEM_DARK);
  });

  it('keeps the system and the explicit dark blocks identical', () => {
    const all = rules(css);
    const system = all.find((rule) => rule.selector === SYSTEM_DARK);
    const explicit = all.find((rule) => rule.selector === EXPLICIT_DARK);
    expect(system, 'dark tokens for "system" on a dark OS').toBeDefined();
    expect(explicit, 'dark tokens for an explicit dark choice').toBeDefined();
    const tokens = customProperties(system!.body);
    expect(Object.keys(tokens)).toEqual(expect.arrayContaining([
      '--dsg-border-color',
      '--dsg-cell-background-color',
      '--dsg-header-text-color',
      '--folio-grid-text-color',
    ]));
    expect(customProperties(explicit!.body)).toEqual(tokens);
  });

  it('takes the cell text colour and the container background from the tokens', () => {
    // The library hard-codes `color: black; background: white` on .dsg-container.
    const container = rules(css).find((rule) => rule.selector === '.folio-table-grid .dsg-container');
    expect(container, 'an override of the container colours').toBeDefined();
    expect(container!.body).toMatch(/[^-]color:\s*var\(--folio-grid-text-color\)/);
    expect(container!.body).toMatch(/background:\s*var\(--dsg-cell-background-color\)/);
  });
});
