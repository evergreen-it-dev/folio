/**
 * Round FORMS — `<slug>.form.md` file format codec. Mirrors
 * shared/tables/codec.ts's shape (parse/serialize, error-as-value, pure, no
 * IO) but the format itself is much simpler than a table's: no GFM table to
 * keep byte-for-byte GitHub-renderable, just frontmatter (the form's
 * definition) plus free prose underneath, preserved verbatim.
 *
 * File shape:
 *
 *   ---
 *   folio: form
 *   version: 1
 *   id: <ulid>
 *   table: relative/path/to/data.table.md   # space-root-relative, POSIX
 *   title: ...
 *   description: ...                        # optional
 *   public: false
 *   submitButton: ...                       # optional
 *   fields: [...]
 *   ---
 *   <body — free prose, preserved byte-for-byte>
 *
 * `table` is deliberately space-root-relative (not relative to the form
 * file's own directory): it survives either file being moved WITHIN the
 * same space without becoming a dangling relative path, at the cost of
 * going stale on a cross-space copy — see server/storage.ts's form copy
 * path for that documented trade-off.
 *
 * BUGFIX (post-merge, owner repro: a just-created form's own page showed
 * "Malformed YAML frontmatter" — every time, 100% reproducible): this
 * module used to go through `gray-matter`, the same way shared/tables/
 * codec.ts does — fine there, because nothing ever imports the table codec
 * into the WEB bundle (a table's live surface reads/writes the collab
 * Y.Doc, never the raw file, client-side). A form's OWN page view/embed
 * widget/definition-editor, by contrast, parse the raw `markdown` string
 * client-side (see web/src/app/routes/FormPageView.tsx) — the one thing
 * that's actually new about this round. gray-matter's `lib/utils.js`
 * `toBuffer()` calls `Buffer.from(input)` UNCONDITIONALLY on every
 * string input, inside `to-file.js`, on every single `matter(raw)` call —
 * not something the parse options can turn off. Vite's browser bundle has
 * no `Buffer` global (this project polyfills nothing, by design — see
 * web/vite.config.ts), so every client-side `matter(raw)` call threw
 * `ReferenceError: Buffer is not defined`, and `parseFormFile`'s own
 * try/catch swallowed that into the generic "Malformed YAML frontmatter"
 * message — which is exactly the symptom, on exactly the first page that
 * ever ran this code path in a browser. `js-yaml` (already a direct
 * dependency, see shared/tables/yaml.ts) has no such dependency — pure
 * string in, string/object out — so this module now talks to it directly
 * instead of through gray-matter, on BOTH the server and the client: one
 * implementation, not two, so this can't drift out of sync again.
 */
import * as yamlModule from 'js-yaml';
import { formFieldSchema, type FormDoc, type FormField } from '../contracts.js';

// js-yaml is CJS; cjs-module-lexer's ESM named-export detection is
// Node-version-dependent (see shared/tables/yaml.ts's own doc comment for
// the prod incident this exact pattern fixed) — same defensive `.default ??`
// fallback, here too.
const yaml = (yamlModule as unknown as { default?: typeof yamlModule }).default ?? yamlModule;

const DELIMITER = '---';

export interface FormParseError {
  readonly kind: 'form-parse-error';
  readonly message: string;
  readonly cause?: unknown;
}

export function isFormParseError(x: FormDoc | FormParseError): x is FormParseError {
  return (x as FormParseError).kind === 'form-parse-error';
}

function parseError(message: string, cause?: unknown): FormParseError {
  return { kind: 'form-parse-error', message, cause };
}

function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * Splits `raw` into its leading `---`-delimited YAML block and the body
 * underneath — the same shape gray-matter's default 'yaml' engine produces
 * (see this file's own header comment for why gray-matter itself is no
 * longer what does the splitting). `raw` is assumed to already start with
 * `---` (parseFormFile checks that before calling this). A missing closing
 * delimiter treats the WHOLE rest of the file as frontmatter with an empty
 * body — gray-matter's own behavior, kept for compatibility with any file
 * a hand-edit left without a closing `---`.
 */
function splitFrontmatter(raw: string): { yamlText: string; body: string } {
  const afterOpen = raw.slice(DELIMITER.length);
  const closeMarker = `\n${DELIMITER}`;
  const closeIndex = afterOpen.indexOf(closeMarker);
  if (closeIndex === -1) {
    return { yamlText: afterOpen, body: '' };
  }
  let body = afterOpen.slice(closeIndex + closeMarker.length);
  // Same "eat exactly one line ending" convention gray-matter's own split used.
  if (body.startsWith('\r')) body = body.slice(1);
  if (body.startsWith('\n')) body = body.slice(1);
  return { yamlText: afterOpen.slice(0, closeIndex), body };
}

export function parseFormFile(raw: string): FormDoc | FormParseError {
  if (!raw.startsWith(DELIMITER)) {
    return parseError('File does not start with a YAML frontmatter block (`---`)');
  }

  const { yamlText, body } = splitFrontmatter(raw);

  let data: unknown;
  try {
    data = yamlText.trim() === '' ? {} : yaml.load(yamlText);
  } catch (err) {
    return parseError('Malformed YAML frontmatter', err);
  }
  if (typeof data !== 'object' || data === null) {
    return parseError('Frontmatter did not parse to an object');
  }
  const fm = data as Record<string, unknown>;

  if (fm.folio !== 'form') {
    return parseError("Not a form: frontmatter is missing `folio: form`");
  }
  if (fm.version !== 1) {
    return parseError(`Unsupported form format version: ${JSON.stringify(fm.version)} (expected 1)`);
  }
  if (typeof fm.id !== 'string' || fm.id.length === 0) {
    return parseError('Frontmatter `id` is missing or not a string');
  }
  if (typeof fm.table !== 'string' || fm.table.length === 0) {
    return parseError('Frontmatter `table` (path of the paired data table) is missing or not a string');
  }
  if (typeof fm.title !== 'string' || fm.title.length === 0) {
    return parseError('Frontmatter `title` is missing or not a string');
  }

  const fieldsResult = formFieldSchema.array().safeParse(fm.fields ?? []);
  if (!fieldsResult.success) {
    return parseError(`Invalid \`fields\` in frontmatter: ${formatZodIssues(fieldsResult.error.issues)}`, fieldsResult.error);
  }

  return {
    meta: { id: fm.id, version: 1 },
    table: fm.table,
    title: fm.title,
    description: typeof fm.description === 'string' && fm.description.trim() ? fm.description : undefined,
    public: fm.public === true,
    submitButton: typeof fm.submitButton === 'string' && fm.submitButton.trim() ? fm.submitButton : undefined,
    fields: fieldsResult.data,
    body,
  };
}

/** `str` with exactly one trailing `\n` — gray-matter's own `newline()` helper, kept identical so existing `.form.md` files' byte shape doesn't change. */
function withTrailingNewline(str: string): string {
  return str.endsWith('\n') ? str : `${str}\n`;
}

export function serializeFormFile(doc: FormDoc): string {
  // JSON round-trip drops explicit `undefined` fields — js-yaml's dumper
  // throws on those rather than skipping them.
  const frontmatter: Record<string, unknown> = JSON.parse(
    JSON.stringify({
      folio: 'form',
      version: doc.meta.version,
      id: doc.meta.id,
      table: doc.table,
      title: doc.title,
      description: doc.description,
      public: doc.public,
      submitButton: doc.submitButton,
      fields: doc.fields,
    }),
  );
  // Same shape gray-matter's stringify.js produced: "---\n" + dump().trim() +
  // "\n---\n" + body (each piece newline-terminated exactly once) — kept
  // identical on purpose, see this file's header comment.
  const yamlText = yaml.dump(frontmatter, { lineWidth: -1 }).trim();
  return `${DELIMITER}\n${withTrailingNewline(yamlText)}${DELIMITER}\n${withTrailingNewline(doc.body)}`;
}

export type { FormDoc, FormField };
