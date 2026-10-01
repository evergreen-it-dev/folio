---
name: Folio Tables
description: Work with Folio data tables (kind table) through folio_table_* MCP tools — schema-first, column types, filters, and typical schemas for a risk register, sprint plan, or backlog.
version: "1.0.0"
tags: [folio, tables, data]
---

# Folio data tables (`kind: table`)

A separate kind of page next to the document and the board: a grid with a
schema of columns, rows and tab views, stored as one `.table.md` file in
git. The normative specification is `docs/spec-tables.md`; this skill is an
operational digest for the `folio_table_*` tools from `server/mcp.ts`.

**This is not the same as an extended markdown table inside a document**
(colspan/rowspan/backgrounds — the `folio-content` skill). A data table is a
page of its own, with its own schema of types and its own API.

## The iron rule: the schema first

Before any reading or writing of rows — **always `folio_table_schema` as the
first call**. The ids of columns, the types and the allowed values of
`select`/`status` cannot be guessed from the name of a column or from
experience with a "similar" table — every table has its own real schema.

## The workflow

1. `folio_table_list` (optionally with `space`) — find the table you need,
   if its `id` is not known yet.
2. `folio_table_schema` — the real columns (id/name/type/options), the
   views, the number of rows.
3. Reading rows — `folio_table_query` with `filter`/`sort`/`q`/`view`/
   `limit`/`offset`, `format: 'markdown'` for a concise look or `'json'` for
   exact values.
4. Writing — `folio_table_insert`/`folio_table_update`/`folio_table_delete`/
   `folio_table_add_column`, in AGENT mode only.
5. After a write — re-read (`folio_table_query`/`folio_table_schema`) and
   only then confirm the result to the user.

## Column types (v1)

| Type | What it is | The value in the API |
|---|---|---|
| `text` | single-line text | `string` |
| `longtext` | multi-line text | `string` (with line breaks) |
| `number` | a number, with `precision` (0-6 digits) | `number` |
| `date` | a date, optionally with time (`time: true`) | an ISO string |
| `checkbox` | yes/no | `boolean` |
| `select` | one (or, with `multiple: true`, several) values from the `options` list | `string` or `string[]` |
| `status` | the same as select, but semantically for the state of a process | `string` |
| `user` | a member of the space (@handle), `multiple` — several | `string` or `string[]` |
| `link` | a URL (or a relative path to a Folio page) with an optional caption | `string` |

`multiple` is a property of a column (`select`/`user`), not a separate type.

### The `status` preset (a starting set, editable)

`PLANNING` (purple) → `WAITING` (gray) → `QUESTIONS` (orange) →
`IN PROG` (blue) → `DONE` (green) → `REPLAN` (yellow) → `FAILED` (red) →
`CANCELLED` (gray). The order of the values is the sort order and the order
in the dropdown. It is a starting example, not a rigid enum — read the real
`options` of the table through `folio_table_schema`, the set can differ.

### Values in cells (for `folio_table_insert`/`folio_table_update`)

- `select`/`status` (one value) — a label string from `options` that really
  exists in the schema; do not invent a new value without need (a new value
  needs `allowCreate`, and it is better to tell the user about it directly).
- `select`/`user` with `multiple: true` — an array of strings (`string[]`),
  not a comma-separated string.
- `date` — ISO 8601 (`"2026-09-04"` or `"2026-09-04T14:30"`).
- `checkbox` — a `boolean` (`true`/`false`), not the string `"yes"`.
- An empty value for any type — `null`, or omit the key (omitted columns get
  the default of the column, not an empty value).

## Filters (`folio_table_query`/`folio_table_update`)

```
filter = { op: 'and' | 'or', rules: [{ column, operator, value? }] }
```

`column` is the id of a column from the schema. The operators: `is`,
`is_not`, `contains`, `not_contains`, `starts_with`, `is_empty`,
`is_not_empty`, `gt`, `lt`, `gte`, `lte`, `between`, `is_any_of`,
`is_none_of`, `has_all`, `has_any`, `is_checked`, `is_unchecked`, `is_me`,
`today`, `this_week`, `last_n_days`. Sorting — `[{ column, dir: 'asc' |
'desc' }]`.

**A bulk update by a filter always requires `limit`** — `folio_table_update`
without `rowId` and without `limit` with a given `filter` returns an error.
It is a deliberate safeguard against an unlimited group edit, not a whim of
the API.

## Creating a table (`folio_table_create`)

```json
{
  "space": "engineering",
  "parentPath": "planning",
  "title": "Risk register",
  "columns": [
    { "name": "Risk", "type": "text" },
    { "name": "Description", "type": "longtext" },
    { "name": "Probability", "type": "select", "options": [
      { "value": "low", "color": "green" },
      { "value": "medium", "color": "yellow" },
      { "value": "high", "color": "red" }
    ]},
    { "name": "Impact", "type": "select", "options": [
      { "value": "low", "color": "green" },
      { "value": "medium", "color": "yellow" },
      { "value": "high", "color": "red" }
    ]},
    { "name": "Owner", "type": "user" },
    { "name": "Status", "type": "status", "options": [
      { "value": "PLANNING", "color": "purple" },
      { "value": "IN PROG", "color": "blue" },
      { "value": "DONE", "color": "green" }
    ]},
    { "name": "Due", "type": "date" },
    { "name": "Closed", "type": "checkbox" }
  ]
}
```

The ids of columns can be left out — the server derives them from `name`
itself (transliteration + slug, `[a-z0-9_]{1,32}`); set `id` explicitly only
when a particular stable name is needed. Name the columns and the values in
the language the user writes in.

### Two more typical schemas

**A sprint plan**: `Week` (select), `Task` (text), `Assignee` (user),
`Estimate` (number, precision 0), `Status` (status), `Done` (checkbox).

**A backlog**: `Name` (text), `Description` (longtext), `Priority` (select:
low/medium/high), `Type` (select: bug/feature/tech debt), `Link` (link),
`Created` (date).

## Bulk insert (`folio_table_insert`)

```json
{
  "id": "<table page id>",
  "rows": [
    { "week": "W36", "task": "Set up CI", "owner": "@ivan", "status": "IN PROG" },
    { "week": "W36", "task": "API review", "owner": "@olena", "status": "PLANNING" }
  ]
}
```

The keys of the object are the ids of columns from the schema (not the
displayed `name`s).

## Views

`folio_table_query` can apply an already saved view through `view` (the id
of a view from the schema) instead of repeating `filter`/`sort` by hand —
handy when the user says "show it as in the 'In progress' tab". The first
view ("All records", named in the language of the person who creates the
table) is created automatically together with the table; the agent cannot
delete the last view.

## Typical pitfalls

- A skipped `folio_table_schema` before a write is the main cause of
  errors: a wrong column id, a select/status value that does not exist.
- `folio_table_update` without `rowId` and without `filter`+`limit` is
  rejected.
- A `select`/`status` value that is not in `options` is not lost (the UI
  shows it as "outside the list"), but it is almost always a sign of a
  mistake: check against the real `options` from the schema, do not invent a
  label.
- `folio_table_insert`/`update` are available only to the write scope and
  the `editor+` role in the space (and only in AGENT mode).

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
