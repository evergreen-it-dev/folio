/**
 * Mounting React subtrees inside CodeMirror widgets. Roots are keyed by their
 * host element so a widget can re-render in place (`updateDOM`) instead of being
 * torn down, and unmounting is deferred because React refuses to unmount
 * synchronously from inside a commit.
 */
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const roots = new WeakMap<HTMLElement, Root>();

export function mountReact(host: HTMLElement, node: ReactNode): void {
  let root = roots.get(host);
  if (!root) {
    root = createRoot(host);
    roots.set(host, root);
  }
  root.render(node);
}

export function unmountReact(host: HTMLElement): void {
  const root = roots.get(host);
  if (!root) return;
  roots.delete(host);
  setTimeout(() => root.unmount());
}
