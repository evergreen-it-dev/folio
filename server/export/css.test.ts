/**
 * Round 23 (EXPORT) — the export stylesheet's SSRF sanitizer.
 *
 * This file is the regression guard on a SECURITY boundary, not on styling:
 * `<slug>.export.css` is authored by whoever can write to a space's git repo
 * and is then rendered by a headless browser inside our network, so DEV-PLAN
 * requires "cut out @import and url() to external hosts (SSRF from the
 * headless browser), a file size limit". Pure — no PG, no fs.
 */
import { describe, expect, it } from 'vitest';
import { MAX_EXPORT_CSS_BYTES, renderHeaderFooterTemplate, sanitizeExportCss, sanitizeHeaderFooterHtml } from './css.js';

describe('sanitizeExportCss (SSRF boundary)', () => {
  it('removes every @import, in any spelling', () => {
    const { css, removed } = sanitizeExportCss(
      [
        '@import url("https://evil.example/x.css");',
        "@IMPORT 'https://evil.example/y.css';",
        '@import url(http://169.254.169.254/latest/meta-data/) screen;',
        'body { color: red; }',
      ].join('\n'),
    );
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toContain('evil.example');
    expect(css).not.toContain('169.254.169.254');
    expect(removed.imports).toBe(3);
    expect(css).toContain('color: red'); // real rules survive
  });

  it('neutralizes url() targets that could leave the box, and keeps the ones that cannot', () => {
    const { css, removed } = sanitizeExportCss(
      [
        '.a { background: url(https://evil.example/track.png); }',
        '.b { background: url("http://10.0.0.5/admin"); }',
        ".c { background: url('//evil.example/proto-relative.png'); }",
        '.d { background: url(file:///etc/passwd); }',
        '.e { background: url(data:image/png;base64,AAAA); }',
        '.f { background: url(assets/logo.png); }',
        '.g { background: url(/files/space/logo.png); }',
      ].join('\n'),
    );
    expect(css).not.toContain('evil.example');
    expect(css).not.toContain('10.0.0.5');
    expect(css).not.toContain('/etc/passwd');
    expect(removed.externalUrls).toBe(4);
    // data: is inline bytes, and scheme-less paths cannot name a foreign host
    expect(css).toContain('url(data:image/png;base64,AAAA)');
    expect(css).toContain('url(assets/logo.png)');
    expect(css).toContain('url(/files/space/logo.png)');
  });

  it('strips comments FIRST, so a payload cannot hide inside one', () => {
    const { css, removed } = sanitizeExportCss('/* @import url(https://evil.example/a.css); */ body { color: blue }');
    expect(css).not.toContain('evil.example');
    expect(removed.imports).toBe(0); // it was a comment, and the comment is gone entirely
    expect(css).toContain('color: blue');
  });

  it('a url() smuggled inside a comment-terminated rule is still caught after comment removal', () => {
    const { css } = sanitizeExportCss('body { background/**/: url(https://evil.example/x.png) }');
    expect(css).not.toContain('evil.example');
  });

  it('cannot close the <style> element it is injected into', () => {
    const { css } = sanitizeExportCss('body{}</style><script>fetch("https://evil.example")</script>');
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('</script>');
  });

  it('caps the file size and cuts back to a whole rule', () => {
    const rule = '.x { color: #fff; }\n';
    const oversized = rule.repeat(Math.ceil((MAX_EXPORT_CSS_BYTES * 1.5) / rule.length));
    const { css, removed } = sanitizeExportCss(oversized);
    expect(Buffer.byteLength(css, 'utf8')).toBeLessThanOrEqual(MAX_EXPORT_CSS_BYTES);
    expect(removed.truncatedBytes).toBeGreaterThan(0);
    expect(css.trimEnd().endsWith('}')).toBe(true);
  });

  it('an empty/absent stylesheet is not an error', () => {
    expect(sanitizeExportCss('').css).toBe('');
  });
});

describe('header/footer templates', () => {
  it('drops anything that could fetch or execute', () => {
    const out = sanitizeHeaderFooterHtml(
      '<div onclick="steal()"><script>fetch("https://evil.example")</script><img src="https://evil.example/pixel.png">ok</div>',
    );
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('script');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('ok');
  });

  it('keeps an inline data: image', () => {
    const out = sanitizeHeaderFooterHtml('<img src="data:image/png;base64,AAAA">');
    expect(out).toContain('data:image/png;base64,AAAA');
  });

  it('maps {{page}}/{{pages}} to chromium\'s own spans and the rest to literal text', () => {
    const out = renderHeaderFooterTemplate('{{title}} · {{space}} · {{date}} · {{page}}/{{pages}}', {
      title: 'A & B',
      space: 'Docs',
      date: '2026-08-27',
    });
    expect(out).toContain('<span class="pageNumber"></span>');
    expect(out).toContain('<span class="totalPages"></span>');
    expect(out).toContain('A &amp; B'); // escaped, never injected
    expect(out).toContain('Docs');
    expect(out).toContain('2026-08-27');
  });
});
