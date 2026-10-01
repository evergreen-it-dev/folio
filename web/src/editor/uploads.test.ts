import { describe, expect, it } from 'vitest';
import {
  altTextFor,
  lineInsertEdit,
  linkTextFor,
  markdownFor,
  placeholderFor,
  replacePlaceholderEdit,
} from './uploads';

/** Apply an edit the way CodeMirror would, so tests assert on the resulting text. */
const apply = (text: string, edit: { from: number; to: number; insert: string }) =>
  text.slice(0, edit.from) + edit.insert + text.slice(edit.to);

describe('altTextFor / linkTextFor', () => {
  it('drops the extension for images and keeps it for links', () => {
    expect(altTextFor('Flow diagram.png')).toBe('Flow diagram');
    expect(linkTextFor('Flow diagram.png')).toBe('Flow diagram.png');
  });

  it('only strips the last extension', () => {
    expect(altTextFor('archive.tar.gz')).toBe('archive.tar');
  });

  it('keeps dotfiles and extensionless names intact', () => {
    expect(altTextFor('README')).toBe('README');
  });

  it('neutralises characters that would break the markdown', () => {
    expect(altTextFor('a[1].png')).toBe('a 1');
    expect(linkTextFor('we\nird ].pdf')).toBe('we ird .pdf');
  });

  it('falls back rather than producing an empty label', () => {
    // stripping the extension would leave nothing — keep the whole name
    expect(altTextFor('.png')).toBe('.png');
    expect(altTextFor('[].png')).toBe('.png');
    // nothing usable at all
    expect(altTextFor('[]')).toBe('image');
    expect(linkTextFor('[]')).toBe('file');
  });
});

describe('markdownFor', () => {
  it('writes an image or a link depending on the file', () => {
    expect(markdownFor('flow.png', '/files/eng/assets/flow.png', true)).toBe(
      '![flow](/files/eng/assets/flow.png)',
    );
    expect(markdownFor('spec.pdf', '/a/abc/spec.pdf', false)).toBe('[spec.pdf](/a/abc/spec.pdf)');
  });

  it('inserts the server URL verbatim, absolute or relative', () => {
    const absolute = 'https://cdn.example.com/a/deadbeef/flow.png?v=1';
    expect(markdownFor('flow.png', absolute, true)).toBe(`![flow](${absolute})`);
  });
});

describe('lineInsertEdit', () => {
  it('adds no newlines on an empty line', () => {
    const edit = lineInsertEdit({ from: 10, text: '' }, 10, 'X');
    expect(edit).toEqual({ from: 10, to: 10, insert: 'X' });
  });

  it('breaks the line when text sits on both sides of the cursor', () => {
    const line = { from: 0, text: 'before after' };
    expect(apply('before after', lineInsertEdit(line, 6, 'X'))).toBe('before\nX\n after');
  });

  it('only opens a new line when there is text before the cursor', () => {
    const line = { from: 0, text: 'tail' };
    expect(apply('tail', lineInsertEdit(line, 4, 'X'))).toBe('tail\nX');
  });

  it('only closes the line when there is text after the cursor', () => {
    const line = { from: 0, text: 'tail' };
    expect(apply('tail', lineInsertEdit(line, 0, 'X'))).toBe('X\ntail');
  });

  it('treats an indented blank line as empty', () => {
    const line = { from: 0, text: '   ' };
    expect(apply('   ', lineInsertEdit(line, 3, 'X'))).toBe('   X');
  });
});

describe('replacePlaceholderEdit', () => {
  const placeholder = placeholderFor('flow.png');

  it('is an empty-target image so it renders as nothing while uploading', () => {
    // Text is translated; the shape and the file name are what the replace
    // step relies on.
    expect(placeholder).toMatch(/^!\[.+]\(\)$/);
    expect(placeholder).toContain('flow.png');
  });

  it('swaps the placeholder for the final markdown', () => {
    const text = `intro\n${placeholder}\noutro`;
    const edit = replacePlaceholderEdit(text, placeholder, '![flow](/u/1.png)', 6);
    expect(edit).not.toBeNull();
    expect(apply(text, edit!)).toBe('intro\n![flow](/u/1.png)\noutro');
  });

  it('removes the placeholder when the upload failed', () => {
    const text = `a\n${placeholder}\nb`;
    expect(apply(text, replacePlaceholderEdit(text, placeholder, '', 2)!)).toBe('a\n\nb');
  });

  it('still finds the placeholder after text above it was deleted', () => {
    const text = `${placeholder}\nrest`;
    // hint points past the placeholder — the fallback scan from 0 must catch it
    const edit = replacePlaceholderEdit(text, placeholder, 'X', 500);
    expect(apply(text, edit!)).toBe('X\nrest');
  });

  it('returns null when the author deleted the placeholder', () => {
    expect(replacePlaceholderEdit('nothing here', placeholder, 'X', 0)).toBeNull();
  });

  it('prefers the occurrence at the hint when the same name is present twice', () => {
    const text = `${placeholder}\nmiddle\n${placeholder}`;
    const second = text.lastIndexOf(placeholder);
    const edit = replacePlaceholderEdit(text, placeholder, 'X', second);
    expect(edit!.from).toBe(second);
  });

  it('refuses an empty placeholder rather than matching everywhere', () => {
    expect(replacePlaceholderEdit('anything', '', 'X')).toBeNull();
  });
});
