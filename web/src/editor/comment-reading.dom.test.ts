// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { rangesInRendered, skeleton, sourceRangeOfSelection } from './comment-reading';

afterEach(() => document.body.replaceChildren());

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('skeleton', () => {
  it('keeps letters and digits, lower-cased, with their source index', () => {
    expect(skeleton('**Ab**, c1!')).toEqual({ s: 'abc1', at: [2, 3, 8, 9] });
  });
});

describe('Reading mode <-> source', () => {
  const source = '# Title\n\nSome **bold** words and a [link](https://x.test) here.\n';

  it('finds a source range in the rendered page across inline markup', () => {
    const root = page('<h1>Title</h1><p>Some <strong>bold</strong> words and a <a href="#">link</a> here.</p>');
    const from = source.indexOf('bold');
    const ranges = rangesInRendered(root, source, [{ id: 't', from, to: source.indexOf(' words') }]);
    expect(ranges.get('t')?.toString()).toBe('bold');
    const wide = rangesInRendered(root, source, [{ id: 'w', from: source.indexOf('Some'), to: source.indexOf(' here') }]);
    expect(wide.get('w')?.toString()).toBe('Some bold words and a link');
  });

  it('turns a selection in the rendered page back into a source range', () => {
    const root = page('<h1>Title</h1><p>Some <strong>bold</strong> words and a <a href="#">link</a> here.</p>');
    const strong = root.querySelector('strong')!.firstChild!;
    const tail = root.querySelector('p')!.childNodes[2];
    const range = document.createRange();
    range.setStart(strong, 0);
    range.setEnd(tail, ' words'.length);
    const found = sourceRangeOfSelection(root, source, range)!;
    expect(source.slice(found.from, found.to)).toBe('bold** words');
  });

  it('picks the occurrence the reader pointed at when the text repeats', () => {
    const md = 'echo one\n\necho two\n';
    const root = page('<p>echo one</p><p>echo two</p>');
    const second = root.querySelectorAll('p')[1].firstChild!;
    const range = document.createRange();
    range.setStart(second, 0);
    range.setEnd(second, 4);
    const found = sourceRangeOfSelection(root, md, range)!;
    expect(found.from).toBe(md.indexOf('echo two'));
  });

  it('does not count the properties block, which is not rendered', () => {
    const md = '---\ntitle: alpha\n---\n\nalpha beta\n';
    const root = page('<p>alpha beta</p>');
    const text = root.firstChild!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    expect(sourceRangeOfSelection(root, md, range)).toEqual({ from: md.indexOf('alpha beta'), to: md.indexOf('alpha beta') + 5 });
  });

  it('leaves out a thread whose text is not on the page', () => {
    const root = page('<p>nothing here</p>');
    expect(rangesInRendered(root, 'gone words\n', [{ id: 'x', from: 0, to: 10 }]).size).toBe(0);
  });
});
