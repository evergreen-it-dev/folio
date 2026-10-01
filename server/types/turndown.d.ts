/**
 * Round 12 (Confluence import): `turndown` and `turndown-plugin-gfm` ship no
 * type declarations at all (no .d.ts, no "types" field, no @types package) —
 * confirmed by inspecting node_modules directly. This project also has no
 * esModuleInterop (see the CJS-interop comments in server/index.ts and
 * server/storage.ts for other untyped/CJS deps), so a plain `import
 * TurndownService from 'turndown'` wouldn't typecheck cleanly either way.
 * This declares just the surface server/confluenceImport.ts actually uses —
 * not a full re-implementation of turndown's public API.
 */
declare module 'turndown' {
  export interface TurndownOptions {
    headingStyle?: 'setext' | 'atx';
    codeBlockStyle?: 'indented' | 'fenced';
    bulletListMarker?: '-' | '+' | '*';
  }

  /** turndown parses HTML with its own lightweight DOM (@mixmark-io/domino), not a
   *  browser DOM — `any` here (rather than a real DOM lib type) is deliberate, not
   *  a shortcut: node/element/rule-filter code below only ever calls the small,
   *  standard subset (nodeName, className, getAttribute, textContent, querySelector)
   *  that domino's nodes actually implement. */
  export type TurndownNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

  export interface TurndownRule {
    filter: string | string[] | ((node: TurndownNode) => boolean);
    replacement: (content: string, node: TurndownNode, options?: TurndownOptions) => string;
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(html: string): string;
    use(plugin: (service: TurndownService) => void): TurndownService;
    addRule(key: string, rule: TurndownRule): TurndownService;
    keep(filter: string | string[] | ((node: TurndownNode) => boolean)): TurndownService;
    remove(filter: string | string[] | ((node: TurndownNode) => boolean)): TurndownService;
    rules: { array: { name?: string }[] };
  }
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
}
