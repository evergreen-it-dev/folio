// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './download';

describe('downloadBlob', () => {
  let createObjectURL: ReturnType<typeof vi.spyOn>;
  let revokeObjectURL: ReturnType<typeof vi.spyOn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // Real navigation for a blob: URL isn't meaningful under jsdom (and isn't
    // what we're testing) — replace .click() itself so we only ever assert
    // on the anchor's own attributes at the moment it was "clicked".
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates an object URL for the given blob', () => {
    const blob = new Blob(['fake-png-bytes'], { type: 'image/png' });
    downloadBlob(blob, 'my-board.png');
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
  });

  it('clicks exactly one temporary anchor, pointed at the object URL, with the given download name', () => {
    let capturedHref = '';
    let capturedDownload = '';
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      capturedHref = this.href;
      capturedDownload = this.download;
    });

    downloadBlob(new Blob(['x']), 'my-board.svg');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(capturedHref).toBe('blob:mock-url');
    expect(capturedDownload).toBe('my-board.svg');
  });

  it('does not leave the temporary anchor in the document after the click', () => {
    const before = document.body.childElementCount;
    downloadBlob(new Blob(['x']), 'a.png');
    expect(document.body.childElementCount).toBe(before);
  });

  it('does not revoke the object URL synchronously — some browsers cancel an in-flight download if revoked too early', () => {
    downloadBlob(new Blob(['x']), 'a.png');
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the object URL after a short delay', () => {
    downloadBlob(new Blob(['x']), 'a.png');
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:mock-url');
  });
});
