import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormDoc } from '../contracts.js';
import { isFormParseError, parseFormFile, serializeFormFile } from './codec.js';

const SAMPLE: FormDoc = {
  meta: { id: '01JCXYZ8Q0W3M4E5R6', version: 1 },
  table: 'forms/weekly-signup.table.md',
  title: 'Event registration',
  description: 'Fill in the form below.',
  public: false,
  submitButton: 'Submit',
  fields: [
    { columnId: 'name', label: 'Name', required: true, kind: 'text' },
    { columnId: 'attends', label: 'Will you come?', help: 'Yes/no', required: false, kind: 'checkbox' },
  ],
  body: '',
};

describe('parseFormFile / serializeFormFile (round-trip)', () => {
  it('round-trips a full form doc', () => {
    const raw = serializeFormFile(SAMPLE);
    const parsed = parseFormFile(raw);
    expect(isFormParseError(parsed)).toBe(false);
    // An empty body serializes with a single trailing newline (see
    // withTrailingNewline in codec.ts) — not this codec's concern (matches
    // shared/tables/codec.ts's own "head is '' or ends with '\n'" note).
    expect(parsed).toEqual({ ...SAMPLE, body: '\n' });
  });

  it('preserves free prose in the body', () => {
    const withBody: FormDoc = { ...SAMPLE, body: '# Registration\n\nPlease fill in everything.\n' };
    const parsed = parseFormFile(serializeFormFile(withBody));
    expect(isFormParseError(parsed)).toBe(false);
    expect((parsed as FormDoc).body).toBe(withBody.body);
  });

  it('rejects a file with no frontmatter block', () => {
    const parsed = parseFormFile('# just a heading\n');
    expect(isFormParseError(parsed)).toBe(true);
  });

  it('rejects frontmatter missing `folio: form`', () => {
    const parsed = parseFormFile('---\nid: x\n---\nbody\n');
    expect(isFormParseError(parsed)).toBe(true);
    if (isFormParseError(parsed)) expect(parsed.message).toMatch(/folio: form/);
  });

  it('rejects a missing `table` reference', () => {
    const raw = '---\nfolio: form\nversion: 1\nid: x\ntitle: T\n---\n';
    const parsed = parseFormFile(raw);
    expect(isFormParseError(parsed)).toBe(true);
    if (isFormParseError(parsed)) expect(parsed.message).toMatch(/table/);
  });

  it('rejects an invalid field', () => {
    const raw = serializeFormFile(SAMPLE).replace('kind: text', 'kind: not-a-kind');
    const parsed = parseFormFile(raw);
    expect(isFormParseError(parsed)).toBe(true);
  });

  it('defaults `public` to false and omits blank description/submitButton', () => {
    const minimal: FormDoc = {
      meta: { id: 'x', version: 1 },
      table: 't.table.md',
      title: 'T',
      public: false,
      fields: [],
      body: '',
    };
    const parsed = parseFormFile(serializeFormFile(minimal));
    expect(isFormParseError(parsed)).toBe(false);
    expect(parsed).toEqual({ ...minimal, body: '\n' });
  });

  // Bugfix regression (owner repro on prod, post-merge): a just-created
  // form's OWN page view parses `markdown` CLIENT-SIDE (web/src/app/routes/
  // FormPageView.tsx), where there is no global `Buffer` — Vite's browser
  // bundle doesn't polyfill it (see web/vite.config.ts), and this project
  // deliberately adds no polyfill either. The old implementation went
  // through `gray-matter`, whose `lib/utils.js#toBuffer` calls
  // `Buffer.from(input)` UNCONDITIONALLY on every string input inside
  // `to-file.js` — every single `matter(raw)` call, not something engine
  // options can disable — so every client-side parse threw
  // "ReferenceError: Buffer is not defined", caught by parseFormFile's own
  // try/catch and reported as the generic "Malformed YAML frontmatter" (the
  // exact symptom in the bug report). This module now talks to `js-yaml`
  // directly — a pure string-in/string-out API with no Buffer dependency —
  // so both functions must keep working with NO global `Buffer` at all.
  describe('browser safety (no global Buffer)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('parseFormFile does not touch Buffer', () => {
      const raw = serializeFormFile(SAMPLE);
      vi.stubGlobal('Buffer', undefined);
      const parsed = parseFormFile(raw);
      expect(isFormParseError(parsed)).toBe(false);
      expect((parsed as FormDoc).title).toBe(SAMPLE.title);
    });

    it('serializeFormFile does not touch Buffer', () => {
      vi.stubGlobal('Buffer', undefined);
      const raw = serializeFormFile(SAMPLE);
      expect(raw).toContain('folio: form');
    });
  });

  it('treats a missing closing delimiter as "rest of file is frontmatter, empty body" (gray-matter parity, hand-edited files)', () => {
    const raw = '---\nfolio: form\nversion: 1\nid: x\ntable: t.table.md\ntitle: T\npublic: false\nfields: []\n';
    const parsed = parseFormFile(raw);
    expect(isFormParseError(parsed)).toBe(false);
    expect((parsed as FormDoc).body).toBe('');
  });
});
