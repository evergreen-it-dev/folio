/**
 * Minimal transient message shown over the editor when a widget refuses to
 * write (block deleted remotely, source no longer parses, …). Deliberately DOM
 * only: widgets need it from contexts where no React tree is available.
 */
import type { EditorView } from '@codemirror/view';

const TIMEOUT_MS = 4000;

export function showToast(view: EditorView, message: string): void {
  const host = view.dom.closest('.folio-editor') ?? view.dom;
  const existing = host.querySelector('.folio-editor__toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'folio-editor__toast';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  host.appendChild(toast);

  setTimeout(() => toast.remove(), TIMEOUT_MS);
}
