---
name: Folio Content
description: How to write page markdown that Folio renders correctly and that stays readable as plain markdown on GitHub — syntax cheat sheet, page templates, and anti-patterns.
version: "1.0.0"
tags: [folio, markdown, content]
---

# How to write content for Folio

The main skill for any write of the body of a page (`create_page`,
`update_page`). Follow it every time you create or edit markdown — both when
you write a new page from scratch and when you make a pinpoint edit of an
existing one.

Write the content in the language the user writes in, unless they ask for
another one. The templates below show the structure; their headings are to
be written in that language too.

## 1. Iron rules

1. **The title of a page is the first line of the body, `# Title` (H1).** It
   is not a separate field: renaming a page in Folio is an edit of the H1.
   When you write `markdown` for `create_page`/`update_page`, the first
   non-empty line has to be an H1 with the real title — never `# TODO` or an
   empty heading.
2. **Do not write the frontmatter (`id`, `slug`, `order`, `icon`, `cover`,
   `labels`, `status`) by hand.** The server serializes these fields itself;
   the body you pass to the tools is what goes **after** the closing `---`
   (and most often without a frontmatter block at all). If an icon or an
   order has to be set, that is a separate action through the UI/API, not a
   line in the markdown.
3. **Nothing beyond the allowed profile.** Allowed: CommonMark + GFM
   (headings, lists, code, quotes, tables, strikethrough, autolinks,
   task lists, footnotes) + the Folio extensions listed below. Do not invent
   other constructs (there are no KaTeX formulas, no `::toc`/`::include`/
   `::status`/`::embed`/`:::plugin` — none of them is implemented in the
   engine, even if it turned up in somebody's draft before; the only working
   directive is `::pagetree`, see §2).
4. **No `<script>`, `<style>`, `<iframe>`, `style="..."` or other scripted
   HTML constructs** — the sanitizer cuts them out completely; the text
   inside an unknown tag can be lost altogether. Of "raw" HTML only these
   are deliberately allowed: `<details><summary>`, `<mark>`, `<u>`, the
   usual table tags (`<table>`, `<colgroup>`, `<col>` and so on) and `<br>`.

## 2. Syntax cheat sheet

### Headings, lists, code

```
# Page title (H1, one per page)
## Section (H2)
### Subsection (H3)

- a list item
- [ ] an unchecked checkbox
- [x] a checked checkbox

1. a numbered item

`inline code`

​```ts
code in a fenced block
​```
```

### Callout blocks (GFM alerts)

Only these five types, the marker alone on the first line of the quote:

```
> [!NOTE]
> A neutral note.

> [!TIP]
> A piece of advice.

> [!IMPORTANT]
> Important not to miss.

> [!WARNING]
> A warning.

> [!CAUTION]
> The risk/danger of an action.
```

### Tables (ordinary, GFM)

```
| Column A | Column B |
| --- | --- |
| value | value |
```

The extended syntax of Folio tables inside a document (colspan/rowspan/
backgrounds/widths/lists in a cell) is a separate matter — the
`folio-tables` skill, section "Extended markdown tables". Do not confuse it
with `kind: table` (a data table, folio-tables, section "Data tables") —
these are different entities.

### Mermaid diagrams

```
​```mermaid
flowchart LR
  A[Start] --> B{Decision}
  B -->|yes| C[Next]
  B -->|no| D[Stop]
​```
```

The fence has to be at the top level (not inside another code fence). A
mermaid syntax error is shown inline and does not break saving the page.

### A spoiler (an expandable block)

```
<details><summary>Show the details</summary>

The body inside is ordinary markdown, with an empty line right after
`<summary>...</summary>` and an empty line before `</details>` — otherwise
part of the content is not recognized as a markdown block.

</details>
```

### Internal links and @mentions

```
See [Data flow](../architecture/data-flow.md).

A question for @ivan.
```

- An internal link to another page is a **relative path** to the `.md` file
  (not an absolute Folio URL and not an `id`); when a page is moved, Folio
  rewrites the incoming links itself.
- `@mentions` are just the text `@handle` (not a markdown link!). Folio
  draws the pill with the full name itself, only for a real member of the
  space; an unknown `@handle` stays ordinary text.

### Images and files

```
![Diagram](./assets/diagram.png)

[Specification (PDF)](./assets/spec.pdf)
```

A relative path to an image/file next to the page in the git tree. The agent
has no tool for uploading binary files — refer only to assets that really
lie in the space already (check through `list_tree` or `search_pages`, do
not invent a file name).

### A list of child pages

```
::pagetree{depth=2}
```

The only directive that really works. `depth` is 1..5, 2 by default. It
shows the child pages of the current page. No other `::directive` is
rendered — do not use them.

## 3. Typical templates

### A technical specification

```
# Feature name

## Problem

In short: what does not work/what is missing.

## Solution

A description of the approach.

## Scope

- [ ] item 1
- [ ] item 2

## Risks

> [!WARNING]
> What can go wrong.
```

### Meeting minutes

```
# Meeting: the topic, 2026-09-04

Participants: @ivan, @olena

## Decisions

- decision 1

## Actions

- [ ] @ivan — do something by 10.09
```

### An instruction (how-to)

```
# How to do X

## Prerequisites

- access to Y

## Steps

1. Step one
2. Step two

> [!TIP]
> A useful piece of advice for step 2.
```

### An ADR (architecture decision)

```
# ADR: the name of the decision

Status: accepted

## Context

Why the question arises at all.

## Decision

What was decided.

## Consequences

What it changes/what we risk.
```

## 4. Anti-patterns

- **HTML tables instead of markdown tables.** The sanitizer lets them
  through, but the Folio editor gives no table tools for them — use GFM
  pipe tables (ordinary ones or the extended syntax from `folio-tables`).
- **Nested/arbitrary HTML** (div wrappers, custom classes, `style=`) — it is
  either cut out by the sanitizer or loses its formatting. Write markdown.
- **Absolute links to Folio itself** (`https://<host>/s/<space>/...`)
  instead of a relative path to the `.md` — it breaks on a move and does not
  work as in-app navigation. Always a relative path.
- **`# TODO` or an empty heading instead of the real title of the page** —
  the title of the page is taken exactly from it.
- **Directives other than `::pagetree`** (`::toc`, `::include`, `::status`,
  `::embed`, `:::plugin`) — they are not implemented and show up as service
  fallback text or a service wrapper, not as intended.
- **KaTeX formulas (`$...$`, `$$...$$`)** — not implemented in the current
  renderer; the text stays with the dollar signs, do not count on the math
  being rendered.
- **Writing the frontmatter by hand** (`order:`, `icon:` and so on) in the
  markdown you pass to a tool — the server manages these fields itself,
  separately from the body.

## Default scope

Unless the user said otherwise, work within the page that is open now, from
`.folio/runtime/current-context.md`: read and change exactly it (its `id`),
and create new things as its children (`parentPath` from the same place, the
same `space`).

## After creating

- After creating or changing a page, a board or a table ALWAYS end the
  answer with a link the user can follow:
  `[<title>](/s/<space>/p/<id>)` — take `space` and `id` from the answer of
  the tool (`space`, `id`), do not invent them. For several created pages —
  a list of links.
