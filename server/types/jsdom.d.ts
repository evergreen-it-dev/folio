/**
 * Round 16 (Confluence import quality): `jsdom` ships no type declarations of
 * its own (no .d.ts, no "types"/"typings" field in package.json — confirmed
 * by inspecting node_modules directly) and no @types/jsdom is installed.
 * jsdom is formally only a devDependency here (pulled in for web/**'s
 * per-file `// @vitest-environment jsdom` tests), but the Dockerfile's
 * production image runs a plain `npm ci` (not `--omit=dev`), so it's already
 * present at runtime in production too — reusing it server-side for
 * confluenceImport.ts's export_view preprocessing needs no new install.
 *
 * tsconfig.node.json (which covers server/shared/db) deliberately has no
 * "DOM" lib — server code is Node-only. Adding "DOM" project-wide was tried
 * and reverted while building this: it collides with @types/node's own
 * fetch/CloseEvent shapes and breaks server/shareCollab.test.ts's
 * WebsocketProvider close-event typing. So, same spirit as this directory's
 * existing turndown.d.ts: declare just the surface server/confluenceImport.ts
 * actually calls, not a full lib.dom.d.ts reimplementation. `DomNode` is
 * deliberately `any` for the same reason turndown.d.ts's `TurndownNode` is —
 * the handful of places that touch a raw Node (not a full Element) only ever
 * need the standard, universal subset (textContent, parentNode, ...).
 */
declare module 'jsdom' {
  export type DomNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any

  export interface DomAttr {
    name: string;
    value: string;
  }

  export interface DomElement {
    nodeName: string;
    nodeType: number;
    textContent: string | null;
    parentNode: DomElement | null;
    parentElement: DomElement | null;
    nextSibling: DomNode | null;
    nextElementSibling: DomElement | null;
    firstChild: DomNode | null;
    ownerDocument: DomDocument | null;
    id: string;
    className: string;
    classList: { contains(token: string): boolean };
    attributes: ArrayLike<DomAttr>;
    children: ArrayLike<DomElement>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    querySelector(selector: string): DomElement | null;
    querySelectorAll<T extends DomElement = DomElement>(selector: string): ArrayLike<T>;
    closest(selector: string): DomElement | null;
    matches(selector: string): boolean;
    appendChild<T = DomNode>(node: T): T;
    insertBefore<T = DomNode>(node: T, ref: DomNode | null): T;
    removeChild<T = DomNode>(node: T): T;
    remove(): void;
    replaceWith(...nodes: Array<DomNode | string>): void;
    innerHTML: string;
    outerHTML: string;
  }

  export interface DomTableRowElement extends DomElement {
    cells: ArrayLike<DomElement>;
  }

  export interface DomTableElement extends DomElement {
    rows: ArrayLike<DomTableRowElement>;
  }

  export interface DomDocument {
    body: DomElement;
    createElement(tag: string): DomElement;
    createTextNode(text: string): DomNode;
    getElementById(id: string): DomElement | null;
    querySelectorAll<T extends DomElement = DomElement>(selector: string): ArrayLike<T>;
  }

  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: { document: DomDocument; close(): void };
  }
}
