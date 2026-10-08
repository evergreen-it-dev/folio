/**
 * Pasting and dropping files into the page.
 *
 * The upload is the only side effect; everything that reaches the document goes
 * through a normal `view.dispatch`, so it lands in Yjs and the undo history like
 * anything the user typed. A placeholder line marks the spot while the request
 * is in flight and is re-located by exact text match at commit time — if the
 * author deleted it meanwhile, nothing is inserted.
 */
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { t } from './i18n';
import { liveModeFacet, pageContextFacet } from './live-preview';
import { showToast } from './toast';
import {
  convertClipboardHtml,
  htmlHasRichFormatting,
  isFolioClipboardHtml,
  looksLikeMarkdown,
  type ConvertedClipboardHtml,
} from './html-paste';

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Uploads a file and resolves to the URL the server assigned it. */
export type AssetUploader = (space: string, file: File) => Promise<string>;

/* ----------------------------------------------------------------- pure -- */

export function placeholderFor(filename: string): string {
  return `![${t('upload.placeholder', { name: filename })}]()`;
}

/** Filename without its extension, made safe to sit inside `![...]`. */
export function altTextFor(filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/, '');
  return sanitizeLabel(base) || sanitizeLabel(filename) || 'image';
}

export function linkTextFor(filename: string): string {
  return sanitizeLabel(filename) || 'file';
}

function sanitizeLabel(text: string): string {
  return text.replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The URL comes back from the server ready to use; never rewrite it. */
export function markdownFor(filename: string, url: string, isImage: boolean): string {
  return isImage ? `![${altTextFor(filename)}](${url})` : `[${linkTextFor(filename)}](${url})`;
}

/**
 * Put `text` on a line of its own, adding only the newlines that are missing,
 * so an inserted image can be picked up as a block by live mode.
 */
export function lineInsertEdit(line: { from: number; text: string }, pos: number, text: string): TextEdit {
  const offset = pos - line.from;
  const before = line.text.slice(0, offset);
  const after = line.text.slice(offset);
  return {
    from: pos,
    to: pos,
    insert: `${before.trim() === '' ? '' : '\n'}${text}${after.trim() === '' ? '' : '\n'}`,
  };
}

/**
 * Find the placeholder again and swap it for the final markdown (or for nothing,
 * when the upload failed). `hint` is where it was inserted; the search falls back
 * to the whole document because edits above it may have moved it earlier.
 * Returns null when the placeholder is gone — the author deleted it, so the
 * upload result is simply dropped.
 */
export function replacePlaceholderEdit(
  text: string,
  placeholder: string,
  replacement: string,
  hint = 0,
): TextEdit | null {
  if (!placeholder) return null;
  let index = text.indexOf(placeholder, Math.max(0, hint));
  if (index < 0) index = text.indexOf(placeholder);
  if (index < 0) return null;
  return { from: index, to: index + placeholder.length, insert: replacement };
}

/** Replace a rich-paste image marker after its data URL has been uploaded. */
export function replaceClipboardImageEdit(text: string, marker: string, url: string): TextEdit | null {
  if (!marker) return null;
  const at = text.indexOf(marker);
  if (at < 0) return null;
  if (url) return { from: at, to: at + marker.length, insert: url };

  // Failed upload: remove the whole markdown image rather than leaving a
  // broken custom-scheme URL in the page. The marker is unique and generated
  // by us, so the nearest `![` / following `)` is the exact image token.
  const from = text.lastIndexOf('![', at);
  const to = text.indexOf(')', at + marker.length);
  if (from < 0 || to < 0) return { from: at, to: at + marker.length, insert: '' };
  return { from, to: to + 1, insert: '' };
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/* ---------------------------------------------------------------- upload -- */

export const uploadAsset: AssetUploader = async (space, file) => {
  const body = new FormData();
  // Field name must stay "file" — see the multipart handler in server/routes.ts.
  body.append('file', file, file.name);

  const response = await fetch(`/api/spaces/${encodeURIComponent(space)}/assets`, {
    method: 'POST',
    body,
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`upload failed with ${response.status}`);

  const data = (await response.json()) as { url?: unknown };
  if (typeof data.url !== 'string' || !data.url) throw new Error('upload response has no url');
  return data.url;
};

/* -------------------------------------------------------------- handling -- */

/** Uploads run one after another so two files never share a placeholder. */
export async function insertFiles(
  view: EditorView,
  files: readonly File[],
  at: number,
  upload: AssetUploader,
): Promise<void> {
  const space = view.state.facet(pageContextFacet).space;
  let pos = at;

  for (const file of files) {
    if (!view.dom.isConnected) return; // page switched away mid-upload

    pos = Math.min(pos, view.state.doc.length);
    const placeholder = placeholderFor(file.name);
    const edit = lineInsertEdit(view.state.doc.lineAt(pos), pos, placeholder);
    view.dispatch({ changes: edit });
    const hint = edit.from + edit.insert.indexOf(placeholder);

    let markdown = '';
    try {
      const url = await upload(space, file);
      markdown = markdownFor(file.name, url, isImageFile(file));
    } catch {
      if (view.dom.isConnected) showToast(view, t('upload.failed', { name: file.name }));
    }

    if (!view.dom.isConnected) return;
    const replace = replacePlaceholderEdit(view.state.doc.toString(), placeholder, markdown, hint);
    if (!replace) continue;
    view.dispatch({ changes: replace });
    pos = replace.from + replace.insert.length;
  }
}

function pasteInsertEdit(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  block: boolean,
): TextEdit {
  if (!block) return { from, to, insert: text };
  const before = view.state.doc.lineAt(from).text.slice(0, from - view.state.doc.lineAt(from).from);
  const endLine = view.state.doc.lineAt(to);
  const after = endLine.text.slice(to - endLine.from);
  return {
    from,
    to,
    insert: `${before.trim() ? '\n' : ''}${text}${after.trim() ? '\n' : ''}`,
  };
}

/** Insert converted HTML once, then resolve every embedded image in place. */
export async function insertConvertedHtml(
  view: EditorView,
  converted: ConvertedClipboardHtml,
  from: number,
  to: number,
  upload: AssetUploader,
): Promise<void> {
  if (!converted.markdown) return;
  const space = view.state.facet(pageContextFacet).space;
  view.dispatch({ changes: pasteInsertEdit(view, from, to, converted.markdown, converted.block) });

  for (const image of converted.images) {
    if (!view.dom.isConnected) return;
    let url = '';
    try {
      url = await upload(space, image.file);
    } catch {
      showToast(view, t('upload.failed', { name: image.file.name }));
    }
    if (!view.dom.isConnected) return;
    const edit = replaceClipboardImageEdit(view.state.doc.toString(), image.marker, url);
    if (edit) view.dispatch({ changes: edit });
  }
}

/**
 * Slash-menu entry point: ask for files, then run the same upload pipeline that
 * paste and drop use. Cancelling the dialog inserts nothing.
 */
export function pickImageFiles(view: EditorView, upload: AssetUploader = uploadAsset): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.opacity = '0';
  document.body.appendChild(input);

  const cleanup = () => input.remove();
  input.addEventListener('cancel', cleanup);
  input.addEventListener('change', () => {
    const chosen = filesFrom(input.files);
    cleanup();
    if (chosen.length === 0) return;

    // `accept` is a hint, not a guarantee: most pickers let you override it.
    const images = chosen.filter(isImageFile);
    if (images.length < chosen.length) {
      showToast(view, t('upload.onlyImages'));
    }
    if (images.length === 0) return;

    view.focus();
    void insertFiles(view, images, view.state.selection.main.head, upload);
  });

  input.click();
}

function filesFrom(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types).includes('Files');
}

/**
 * Paste and drop handling. Pasted non-images are left to CodeMirror (a copied
 * spreadsheet cell should stay text); dropped non-images are uploaded and
 * inserted as a plain link.
 */
export function assetUploads(upload: AssetUploader = uploadAsset): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const images = filesFrom(event.clipboardData?.files).filter(isImageFile);
      if (images.length > 0) {
        event.preventDefault();
        void insertFiles(view, images, view.state.selection.main.head, upload);
        return true;
      }

      // Google Docs (and most rich editors) put formatting in text/html. Docs
      // also embeds copied images as data URLs rather than File objects, so the
      // file-only branch above can never see them.
      const html = event.clipboardData?.getData('text/html') ?? '';
      if (!html) return false;
      // "Source" is a plain-text editor: whatever the clipboard's HTML twin
      // says, the user wants the raw text. And in live mode, text that already
      // reads as markdown must be pasted verbatim — turndown would escape it.
      if (!view.state.facet(liveModeFacet)) return false;
      // Copied out of Folio's own Live edit: `text/plain` IS the markdown.
      if (isFolioClipboardHtml(html) && (event.clipboardData?.getData('text/plain') ?? '') !== '') return false;
      // Google Docs' plain-text list/link markup also "looks like markdown",
      // but its HTML twin carries real formatting (links, bold, lists…) that
      // plain text can't — only skip the HTML conversion when the HTML has
      // nothing worth converting.
      const plain = event.clipboardData?.getData('text/plain') ?? '';
      if (looksLikeMarkdown(plain) && !htmlHasRichFormatting(html)) return false;
      let converted: ConvertedClipboardHtml | null = null;
      try {
        converted = convertClipboardHtml(html);
      } catch {
        // Conversion is an enhancement. If malformed clipboard HTML defeats
        // it, leave the event untouched and CodeMirror will paste text/plain.
        return false;
      }
      if (!converted?.markdown) return false;
      event.preventDefault();
      const { from, to } = view.state.selection.main;
      void insertConvertedHtml(view, converted, from, to, upload);
      return true;
    },

    // Without preventDefault here the browser navigates to the dropped file.
    dragover(event) {
      if (hasFiles(event.dataTransfer)) event.preventDefault();
      return false;
    },

    drop(event, view) {
      const files = filesFrom(event.dataTransfer?.files);
      if (files.length === 0) return false;
      event.preventDefault();
      const at =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      void insertFiles(view, files, at, upload);
      return true;
    },
  });
}
