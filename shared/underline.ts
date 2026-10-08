/**
 * `++underline++` — the markdown underline.
 *
 * Markdown has no underline, and the HTML stand-in (`<ins>…</ins>`) was a
 * trap: a tag pair has no idea about the `**` pair around it, so
 * `<ins>**x</ins>**` (two pairs that cross) is easy to produce and nothing
 * can render it. `++text++` is a delimiter pair like `~~` and `**`: the parser
 * nests it with them in any order and never lets it cross (the owner,
 * 08.10.2026: "HTML tags in markdown are evil"). It is also what markdown-it
 * (`markdown-it-ins`) and several editors write, so it is not a private
 * invention — GitHub shows it literally, which is the price.
 *
 * This file is the Reading / export half of the syntax: a `micromark`
 * extension (a copy of the GFM strikethrough tokenizer with `+` for `~` and
 * "exactly two" for "one or two"), the `mdast-util-from-markdown` and
 * `-to-markdown` halves, and one remark plugin gluing them. The editor's own
 * parser (Lezer) has its own copy of the rule: `web/src/editor/underline-syntax.ts`.
 * Plain TS with no DOM, because both `web` (Reading) and `server` (PDF, DOCX)
 * use it.
 *
 * The node is `underline`; it renders as `<ins>` (`data.hName`) — the tag
 * GitHub shows underlined and the one every default sanitizer schema allows
 * (`<u>` is not in hast-util-sanitize's). Old `<ins>`/`<u>` written as raw HTML keep
 * rendering exactly as before.
 */
import type { Extension as FromMarkdownExtension, CompileContext, Handle } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownExtension, Handle as ToMarkdownHandle } from 'mdast-util-to-markdown';
import type { Parent, PhrasingContent, Root } from 'mdast';
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { resolveAll } from 'micromark-util-resolve-all';
import type { Event, Extension, Resolver, State, Token, TokenizeContext, Tokenizer } from 'micromark-util-types';
import type { Processor } from 'unified';

/** An `++underline++` span in an mdast tree. */
export interface Underline extends Parent {
  type: 'underline';
  children: PhrasingContent[];
}

declare module 'mdast' {
  interface PhrasingContentMap {
    underline: Underline;
  }
  interface RootContentMap {
    underline: Underline;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    underline: 'underline';
    underlineSequence: 'underlineSequence';
    underlineSequenceTemporary: 'underlineSequenceTemporary';
    underlineText: 'underlineText';
  }
}

const PLUS = 43;

/** The tag an underline renders as. */
export const UNDERLINE_TAG = 'ins';

/* ------------------------------------------------------------ micromark -- */

export function underlineSyntax(): Extension {
  const tokenizer = {
    name: 'underline',
    tokenize: tokenizeUnderline,
    resolveAll: resolveAllUnderline,
  };
  return {
    text: { [PLUS]: tokenizer },
    insideSpan: { null: [tokenizer] },
    attentionMarkers: { null: [PLUS] },
  };

  /** Pair up the delimiter runs the tokenizer found. */
  function resolveAllUnderline(events: Event[], context: TokenizeContext): Event[] {
    let index = -1;
    while (++index < events.length) {
      if (
        events[index][0] === 'enter' &&
        events[index][1].type === 'underlineSequenceTemporary' &&
        (events[index][1] as Token & { _close?: boolean })._close
      ) {
        let open = index;
        while (open--) {
          if (
            events[open][0] === 'exit' &&
            events[open][1].type === 'underlineSequenceTemporary' &&
            (events[open][1] as Token & { _open?: boolean })._open
          ) {
            events[index][1].type = 'underlineSequence';
            events[open][1].type = 'underlineSequence';
            const underline: Token = {
              type: 'underline',
              start: Object.assign({}, events[open][1].start),
              end: Object.assign({}, events[index][1].end),
            };
            const text: Token = {
              type: 'underlineText',
              start: Object.assign({}, events[open][1].end),
              end: Object.assign({}, events[index][1].start),
            };
            const nextEvents: Event[] = [
              ['enter', underline, context],
              ['enter', events[open][1], context],
              ['exit', events[open][1], context],
              ['enter', text, context],
            ];
            const insideSpan = context.parser.constructs.insideSpan.null;
            if (insideSpan) {
              splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan, events.slice(open + 1, index), context));
            }
            splice(nextEvents, nextEvents.length, 0, [
              ['exit', text, context],
              ['enter', events[index][1], context],
              ['exit', events[index][1], context],
              ['exit', underline, context],
            ]);
            splice(events, open - 1, index - open + 3, nextEvents);
            index = open + nextEvents.length - 2;
            break;
          }
        }
      }
    }
    index = -1;
    while (++index < events.length) {
      if (events[index][1].type === 'underlineSequenceTemporary') events[index][1].type = 'data';
    }
    return events;
  }

  function tokenizeUnderline(this: TokenizeContext, effects: Parameters<Tokenizer>[0], ok: State, nok: State): State {
    const previous = this.previous;
    const events = this.events;
    let size = 0;
    return start;

    function start(code: number | null): State | undefined {
      // A `+` right after another `+` belongs to that run (it was either taken
      // already or refused as a run of three); only an escaped one starts afresh.
      if (previous === PLUS && events[events.length - 1][1].type !== 'characterEscape') return nok(code);
      effects.enter('underlineSequenceTemporary');
      return more(code);
    }

    function more(code: number | null): State | undefined {
      const before = classifyCharacter(previous);
      if (code === PLUS) {
        // A third `+` is not this marker (`+++`, and `C++` followed by `+`).
        if (size > 1) return nok(code);
        effects.consume(code);
        size++;
        return more;
      }
      // A lone `+` is only text: `a + b`, `C+`.
      if (size < 2) return nok(code);
      const token = effects.exit('underlineSequenceTemporary') as Token & { _open?: boolean; _close?: boolean };
      const after = classifyCharacter(code);
      token._open = !after || (after === 2 && Boolean(before));
      token._close = !before || (before === 2 && Boolean(after));
      return ok(code);
    }
  }
}

/* --------------------------------------------------------------- mdast -- */

export function underlineFromMarkdown(): FromMarkdownExtension {
  return {
    canContainEols: ['underline'],
    enter: { underline: enterUnderline },
    exit: { underline: exitUnderline },
  };
}

const enterUnderline: Handle = function (this: CompileContext, token) {
  // `hName` is what makes mdast-util-to-hast draw it as `<ins>` rather than a `<div>`.
  this.enter({ type: 'underline', children: [], data: { hName: UNDERLINE_TAG } } as Underline, token);
};

const exitUnderline: Handle = function (this: CompileContext, token) {
  this.exit(token);
};

const handleUnderline: ToMarkdownHandle & { peek?: () => string } = (node, _, state, info) => {
  const tracker = state.createTracker(info);
  const exit = state.enter('underline' as never);
  let value = tracker.move('++');
  value += state.containerPhrasing(node as Underline, { ...tracker.current(), before: value, after: '+' });
  value += tracker.move('++');
  exit();
  return value;
};
handleUnderline.peek = () => '+';

export function underlineToMarkdown(): ToMarkdownExtension {
  return {
    // `++` in running text would read as a marker: escape the second plus.
    unsafe: [{ character: '+', before: '\\+', inConstruct: 'phrasing' }],
    handlers: { underline: handleUnderline },
  };
}

/* ------------------------------------------------------- remark plugin -- */

type PluginData = Record<string, unknown[] | undefined>;

/** `unified().use(remarkUnderline)` — after `remarkParse`, next to `remarkGfm`. */
export function remarkUnderline(this: Processor): void {
  const data = this.data() as PluginData;
  (data.micromarkExtensions ??= []).push(underlineSyntax());
  (data.fromMarkdownExtensions ??= []).push(underlineFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(underlineToMarkdown());
}

export type { Root };
