/**
 * `<ins>…</ins>` / `<u>…</u>` -> `++…++`, for pages written before underline
 * became markdown (format.ts). A pure text transform with no I/O: the editor
 * does not call it, nothing runs it by itself. `tools/migrate-underline.ts`
 * drives it over a folder of `.md` files, dry-run unless told otherwise.
 *
 * The point of doing it with the toolbar's own rules (format.ts) rather than
 * with a regexp is the crossing pair `<ins>**x</ins>**` the old button wrote:
 * a naive swap would give `++**x++**`, which no parser reads. Here the `++`
 * go where the toolbar would put them for that text — `**++x++**` — cut at
 * the markers of any format the old pair only partly covered.
 *
 * Conservative on purpose. A pair is converted only if the result really
 * contains the new underline runs (flanking rules: `foo<ins>.bar</ins>` would
 * come out as literal `++`); otherwise it is left exactly as it was and counted
 * as skipped. Pairs split across lines, and code (fenced or inline), are not
 * touched.
 */
import {
  applyFormatEdit,
  containerRuns,
  runsOf,
  tidyChanges,
  underlineWrapSegments,
  type TextChange,
} from './format';

export interface UnderlineMigration {
  markdown: string;
  /** Tag pairs rewritten as `++`. */
  converted: number;
  /** Pairs left alone because the rewrite would not have parsed. */
  skipped: number;
  /** Lines that still carry a lone `<ins>`/`<u>` tag (a pair across lines, or never closed). */
  unpaired: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const STRAY_TAG = /<\/?(?:ins|u)\s*>/i;

function plusRunCount(line: string): number {
  return runsOf(line, 'underline').filter((run) => !run.legacy).length;
}

/** One line: returns the new text plus how many pairs were converted/skipped. */
function migrateLine(line: string): { line: string; converted: number; skipped: number } {
  let text = line;
  let converted = 0;
  const skipped = new Set<number>();
  for (;;) {
    // The rightmost pair first: rewriting it cannot move anything to its left.
    const all = runsOf(text, 'underline');
    const run = all
      .filter((r) => r.legacy && !skipped.has(r.outerFrom))
      .sort((a, b) => b.outerFrom - a.outerFrom)[0];
    if (!run) break;
    // A pair inside another underline is redundant: its tags just go.
    const nested = all.some((r) => r !== run && r.outerFrom <= run.outerFrom && run.outerTo <= r.outerTo);
    const segments = nested ? [] : underlineWrapSegments(text, run.innerFrom, run.innerTo, containerRuns(text));
    const changes: TextChange[] = [
      { from: run.outerFrom, to: run.innerFrom, insert: '' },
      { from: run.innerTo, to: run.outerTo, insert: '' },
    ];
    for (const seg of segments) {
      changes.push({ from: seg.from, to: seg.from, insert: '++' }, { from: seg.to, to: seg.to, insert: '++' });
    }
    const next = applyFormatEdit(text, { changes: tidyChanges(changes), selection: { from: 0, to: 0 } });
    if (plusRunCount(next) !== plusRunCount(text) + segments.length) {
      skipped.add(run.outerFrom);
      continue;
    }
    text = next;
    converted++;
  }
  return { line: text, converted, skipped: skipped.size };
}

export function migrateLegacyUnderline(markdown: string): UnderlineMigration {
  let converted = 0;
  let skipped = 0;
  let unpaired = 0;
  let fence: string | null = null;
  const out = markdown.split('\n').map((line) => {
    const m = FENCE.exec(line);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return line;
    }
    if (fence !== null) return line;
    if (!STRAY_TAG.test(line)) return line;
    const result = migrateLine(line);
    converted += result.converted;
    skipped += result.skipped;
    if (STRAY_TAG.test(result.line.replace(/`[^`]*`/g, ''))) unpaired++;
    return result.line;
  });
  return { markdown: out.join('\n'), converted, skipped, unpaired };
}
