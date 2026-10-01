/**
 * Round 21 follow-up (DIAGRAMS) — reliable "save this to disk" for board
 * exports.
 *
 * Diagnosis (owner-reported, reproduced): Excalidraw's own built-in "Export
 * image" dialog saves through browser-fs-access -> the File System Access
 * API (`showSaveFilePicker()` + `handle.createWritable()`). In at least one
 * real browser/context the API is *present* (so the library never falls
 * back to its own legacy path) but `createWritable()` is rejected by the
 * user agent/platform policy — the export then fails with no visible error
 * at all:
 *   "Failed to execute 'createWritable' on 'FileSystemFileHandle': The
 *   request is not allowed by the user agent or the platform in the
 *   current context."
 *
 * The classic anchor-based download (Blob + a temporary `<a download>` click
 * + `URL.revokeObjectURL`) never touches that API and works anywhere the
 * `download` attribute is supported — every browser Folio targets. This is
 * that path, used by BoardCanvas's own PNG/SVG export instead of Excalidraw's
 * built-in dialog (see BoardExportMenu.tsx).
 *
 * Kept as its own tiny, DOM-only module (no React) so it's directly
 * testable by spying on document.createElement/URL.createObjectURL, the
 * same spirit as autosaveScheduler.ts/boardMode.ts next to it.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // Some browsers (historically Firefox) only fire the download from a
  // .click() if the anchor is actually in the document; harmless elsewhere.
  // Removed again immediately — it never needs to be visible.
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Deferred, not immediate: revoking the object URL right after .click()
  // can race the browser's own (async) read of it and cancel an in-flight
  // download in some engines. A short delay is far more than a local
  // Blob->disk write ever needs, and nothing else ever references this URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
