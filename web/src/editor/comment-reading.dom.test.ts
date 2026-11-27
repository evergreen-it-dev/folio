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

describe('selections over formatted text', () => {
  /** Selects from (node, a) to (node2, b) and returns the source text it maps to. */
  function pick(root: HTMLElement, md: string, start: [Node, number], end: [Node, number]): string | null {
    const range = document.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    const found = sourceRangeOfSelection(root, md, range);
    return found ? md.slice(found.from, found.to) : null;
  }
  const bold = 'Do we build the spec from a ready base twice as fast and keep what clients pick us for?';
  const md = `_Italic now._\n\n**${bold}**\n\nNext paragraph.\n`;
  const html = `<p><em>Italic now.</em></p><p><strong>${bold}</strong></p><p>Next paragraph.</p>`;

  it('anchors a whole bold paragraph selected by a triple click (ends in the next block)', () => {
    const root = page(html);
    const [, p, next] = Array.from(root.querySelectorAll('p'));
    expect(pick(root, md, [p, 0], [next.firstChild!, 0])).toBe(bold);
    // The same, from the end of the previous block.
    const em = root.querySelector('em')!.firstChild!;
    expect(pick(root, md, [em, em.textContent!.length], [next.firstChild!, 0])).toBe(bold);
  });

  it('anchors part of a bold paragraph, and an italic + bold mix', () => {
    const root = page(html);
    const text = root.querySelector('strong')!.firstChild!;
    expect(pick(root, md, [text, 3], [text, 14])).toBe('we build th');
    const em = root.querySelector('em')!.firstChild!;
    expect(pick(root, md, [em, 3], [text, 2])).toBe('lic now._\n\n**Do');
  });

  it('anchors link text and inline code', () => {
    const src = 'See the [docs page](https://x.test/docs) and run `npm install` now.\n';
    const root = page('<p>See the <a href="#">docs page</a> and run <code>npm install</code> now.</p>');
    const link = root.querySelector('a')!.firstChild!;
    const code = root.querySelector('code')!.firstChild!;
    expect(pick(root, src, [link, 0], [link, link.textContent!.length])).toBe('docs page');
    expect(pick(root, src, [code, 0], [code, code.textContent!.length])).toBe('npm install');
    expect(pick(root, src, [link, 5], [code, 3])).toBe('page](https://x.test/docs) and run `npm');
  });

  it('anchors a selection spanning two blocks', () => {
    const src = '## Head\n\n- one **two**\n- three\n';
    const root = page('<h2>Head</h2><ul><li>one <strong>two</strong></li><li>three</li></ul>');
    const head = root.querySelector('h2')!.firstChild!;
    const three = root.querySelectorAll('li')[1].firstChild!;
    expect(pick(root, src, [head, 0], [three, 5])).toBe('Head\n\n- one **two**\n- three');
  });

  it('still anchors when the page shows letters the source does not hold', () => {
    const src = 'Alpha beta gamma delta epsilon zeta eta theta.\n';
    const root = page('<p>Alpha beta gamma <span>[widget]</span> delta epsilon zeta eta theta.</p>');
    const p = root.querySelector('p')!;
    expect(pick(root, src, [p, 0], [p, p.childNodes.length])).toBe('Alpha beta gamma delta epsilon zeta eta theta.');
  });

  it('anchors across an entity and an aliased wikilink the source spells differently', () => {
    const src = 'Tom &eacute; says [[Some Page|the alias]] is fine here and there.\n';
    const root = page('<p>Tom é says <a href="#">the alias</a> is fine here and there.</p>');
    const p = root.querySelector('p')!;
    expect(pick(root, src, [p, 0], [p, p.childNodes.length])).not.toBeNull();
    const a = root.querySelector('a')!.firstChild!;
    expect(pick(root, src, [a, 0], [a, a.textContent!.length])).toBe('the alias');
  });

  it('highlights formatted text from a source range too', () => {
    const root = page(html);
    const from = md.indexOf('Do we');
    const ranges = rangesInRendered(root, md, [{ id: 'b', from, to: md.indexOf('?**') + 1 }]);
    expect(ranges.get('b')?.toString()).toBe(bold);
  });
});


describe('selections that end on a block boundary (triple click)', () => {
  const line = 'Do we build the spec from a ready base twice as fast and keep what clients pick us for?';
  const md = `## Goal\n\n_Italic._\n\n**${line}**\n\n## Success metrics\n\nMetrics text.\n`;
  const html =
    '<div class="folio-md-segment"><div class="folio-collapsible"><h2>Goal</h2><div class="folio-collapsible-body"><p><em>Italic.</em></p>' +
    `<p><strong>${line}</strong></p></div></div>` +
    '<div class="folio-collapsible"><h2>Success metrics</h2><div class="folio-collapsible-body"><p>Metrics text.</p></div></div></div>';

  it('keeps the quote to the selected line when the range ends at the next heading', () => {
    const root = page(html);
    const strong = root.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(strong, 0);
    range.setEnd(root.querySelectorAll('h2')[1], 0);
    const found = sourceRangeOfSelection(root, md, range)!;
    expect(md.slice(found.from, found.to)).toBe(line);
    // …and so does a range that ends at the next section element.
    range.setEnd(root.querySelectorAll('.folio-collapsible')[1], 0);
    const again = sourceRangeOfSelection(root, md, range)!;
    expect(md.slice(again.from, again.to)).toBe(line);
  });

  it('includes trailing punctuation of a drag that ends at the end of the line, and starts from the previous block', () => {
    const root = page(html);
    const strong = root.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(strong, 0);
    range.setEnd(strong, strong.textContent!.length);
    const found = sourceRangeOfSelection(root, md, range)!;
    expect(md.slice(found.from, found.to)).toBe(line);
    const em = root.querySelector('em')!.firstChild!;
    range.setStart(em, em.textContent!.length);
    range.setEnd(root.querySelectorAll('h2')[1], 0);
    const from = sourceRangeOfSelection(root, md, range)!;
    expect(md.slice(from.from, from.to)).toBe(line);
  });

  it('paints exactly the bold line, question mark included', () => {
    const root = page(html);
    const ranges = rangesInRendered(root, md, [{ id: 'x', from: md.indexOf('Do we'), to: md.indexOf(line) + line.length }]);
    expect(ranges.get('x')?.toString()).toBe(line);
  });
});

describe('reading-mode chrome inside the prose', () => {
  const line = 'Do we build the spec from a ready base twice as fast and keep what clients pick us for?';
  const md = `## Goal\n\n**${line}**\n\n## Success metrics\n\nText.\n`;
  const html =
    '<div class="folio-collapsible" data-collapse-slug="learning-goal"><div class="folio-collapsible-body">' +
    `<p><strong>${line}</strong></p>\n</div><div class="folio-collapsible-stub">2 hidden blocks</div></div>` +
    '<div class="folio-collapsible" data-collapse-slug="metrics"><h2 id="user-content-metrics"><button type="button" class="folio-collapse-toggle" data-collapse-toggle="metrics" aria-label="Collapse section"></button>Success metrics</h2>' +
    '<div class="folio-collapsible-body"><p>Text.</p></div></div>';

  it('ignores the hidden-blocks stub and the toggle: the quote is the bold line', () => {
    const root = page(html);
    const strong = root.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(strong, 0);
    range.setEnd(root.querySelectorAll('h2')[0], 0);
    const found = sourceRangeOfSelection(root, md, range)!;
    expect(md.slice(found.from, found.to)).toBe(line);
  });

  it('never stretches past what the selection holds, even when the page has stray letters', () => {
    const root = page('<p>Alpha beta gamma delta epsilon</p><p data-x>Omega sigma tau upsilon phi</p>');
    const src = 'Alpha beta gamma delta epsilon\n\nOmega sigma tau upsilon phi\n';
    const first = root.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, first.textContent!.length);
    const found = sourceRangeOfSelection(root, src, range)!;
    expect(src.slice(found.from, found.to)).toBe('Alpha beta gamma delta epsilon');
  });
});
