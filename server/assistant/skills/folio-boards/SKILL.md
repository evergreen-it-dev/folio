---
name: Folio Boards
description: Generate Excalidraw boards with create_board's sketch DSL and tidy EXISTING boards with board_ops (align/distribute/auto_layout) — layout method, palette, worked examples.
version: "1.0.0"
tags: [folio, boards, excalidraw, diagrams]
---

# Excalidraw boards through `create_board`/`update_board`

A board (`kind: board`) is a separate page in the tree of a space, a
full-screen Excalidraw. The agent does not draw every element of the scene
by hand — it describes the board with the compact `sketch` DSL, and the
server lays it out into real Excalidraw elements itself.

## When to use a board, and when mermaid in a document

- **A simple diagram inside a document** (a flowchart, sequence, gantt and so
  on) is handier and cheaper as a ```mermaid block right in the body of the
  page (the `folio-content` skill, section "Mermaid diagrams"): it creates no
  separate page, is easily edited as text, is versioned as a line in git.
- **A board** — when exactly a separate diagram page in the tree is needed
  (an architecture, a map of a process that people want to open and refine
  by hand in the Excalidraw editor), or when "make a board" is asked for
  explicitly.

## The contract of `create_board` / `update_board`

```
create_board({ space, parentPath, title, sketch? | scene? })
update_board({ id, sketch? | scene? })
```

Pass `sketch` — the compact DSL below. Use the full `scene` (raw Excalidraw
elements) only for a pinpoint edit of an already existing board: first
`read_page` (for a board it returns `scene`), then make changes in the array
of elements you got, and send it back through `update_board({ id, scene })`.
Do not generate a `scene` from scratch — it is the format of the Excalidraw
engine, not a DSL that is convenient to write.

## The `sketch` DSL

```ts
sketch = {
  background?: string,   // hex of the board background, '#ffffff' by default
  nodes: [{
    id: string,           // unique within the sketch, referenced by edges/frame
    type: 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'frame',
    label?: string,
    x: number,
    y: number,
    w?: number,            // the default depends on the type, see below
    h?: number,
    color?: string,        // stroke, hex, default '#1e1e1e'
    background?: string,   // fill hex or 'transparent'
    fontSize?: 16 | 20 | 28,
    frame?: string,         // id of the type:'frame' node this node lies in
  }],
  edges: [{
    id?: string,
    from: string,           // id of the source node
    to: string,             // id of the target node
    label?: string,
    elbowed?: boolean,       // default true — orthogonal (elbow) arrows
    start?: 'arrow' | null,  // default null
    end?: 'arrow' | null,    // default 'arrow'
    color?: string,
  }],
}
```

The default sizes of nodes (when `w`/`h` are not set): `rectangle` 200×80,
`ellipse` 160×100, `diamond` 180×120.

## The layout method

- **The grid**: a step of ~260px along x, ~140px along y — that is enough
  for arrows and labels not to overlap even without manual tuning.
- **The direction of the flow**: left to right for processes/flowcharts, top
  to bottom for hierarchies/decision trees — pick one direction and keep to
  it across the whole board.
- **Swimlanes / logical groups** — through `frame`: create a node with
  `type: 'frame'` and large `w`/`h`, and put `frame: '<id of the frame>'`
  into every child node.
- **The size of a board**: roughly up to ~40 nodes. If there are more, split
  it into several boards or group it into mermaid + a text description.
- **Labels**: short, ≤ 4 words per line (`label`), not a whole sentence —
  long text wraps by itself but becomes unreadable in a narrow node.
- **`diamond`** — for a decision point (yes/no, a branch), not for an
  ordinary step of the process.

### The palette of backgrounds (pastel, Excalidraw)

| Color | hex |
|---|---|
| blue | `#a5d8ff` |
| green | `#b2f2bb` |
| yellow | `#ffec99` |
| pink | `#ffc9c9` |
| violet | `#d0bfff` |

Pick 1 color per category/type of node (for example: start/end — one
color, steps of the process — another, decision points — a third), do not
color every node arbitrarily.

## Example 1 — a flowchart of a process (7 nodes, left to right)

```json
{
  "background": "#ffffff",
  "nodes": [
    { "id": "start", "type": "ellipse", "label": "Request received", "x": 0, "y": 60, "background": "#a5d8ff" },
    { "id": "check", "type": "diamond", "label": "Data complete?", "x": 260, "y": 40, "background": "#ffec99" },
    { "id": "ask", "type": "rectangle", "label": "Ask for data", "x": 260, "y": 220, "background": "#ffc9c9" },
    { "id": "review", "type": "rectangle", "label": "Review", "x": 520, "y": 60, "background": "#b2f2bb" },
    { "id": "decision", "type": "diamond", "label": "Approved?", "x": 780, "y": 40, "background": "#ffec99" },
    { "id": "approve", "type": "rectangle", "label": "Carry out", "x": 1040, "y": -20, "background": "#b2f2bb" },
    { "id": "reject", "type": "rectangle", "label": "Reject", "x": 1040, "y": 160, "background": "#ffc9c9" }
  ],
  "edges": [
    { "from": "start", "to": "check" },
    { "from": "check", "to": "review", "label": "yes" },
    { "from": "check", "to": "ask", "label": "no" },
    { "from": "ask", "to": "check" },
    { "from": "review", "to": "decision" },
    { "from": "decision", "to": "approve", "label": "yes" },
    { "from": "decision", "to": "reject", "label": "no" }
  ]
}
```

## Example 2 — an architecture with two frames (swimlanes)

```json
{
  "nodes": [
    { "id": "client_frame", "type": "frame", "label": "Client", "x": 0, "y": 0, "w": 500, "h": 300 },
    { "id": "server_frame", "type": "frame", "label": "Server", "x": 600, "y": 0, "w": 500, "h": 300 },

    { "id": "web", "type": "rectangle", "label": "Web UI", "x": 40, "y": 60, "frame": "client_frame", "background": "#a5d8ff" },
    { "id": "editor", "type": "rectangle", "label": "Editor", "x": 40, "y": 180, "frame": "client_frame", "background": "#a5d8ff" },

    { "id": "api", "type": "rectangle", "label": "REST/MCP API", "x": 640, "y": 60, "frame": "server_frame", "background": "#b2f2bb" },
    { "id": "db", "type": "rectangle", "label": "PostgreSQL", "x": 640, "y": 180, "frame": "server_frame", "background": "#d0bfff" }
  ],
  "edges": [
    { "from": "web", "to": "api", "label": "HTTP" },
    { "from": "editor", "to": "api", "label": "WS" },
    { "from": "api", "to": "db", "label": "SQL" }
  ]
}
```

Write the labels in the language the user writes in.

## Editing an EXISTING board — `board_ops`, not regeneration

When the user asks to "align it", "make it tidy", "place it evenly", "move
it closer", "the same size", "lay it out left to right" on a board that
already exists (usually the currently open page of kind `board`):

1. `read_page({ id })` — for a board it returns `scene.shapes` (id, type,
   label, x, y, w, h, cx, cy), `scene.arrows` (from, to, label) and
   `layout.rows` / `layout.cols` (clusters by y / by x with a threshold of
   40px). That is enough to understand which blocks were meant to stand in
   one row or column.
2. Plan the operations in terms of `board_ops` and apply them in ONE call:

```
board_ops({ id, ops: [
  { op: 'auto_layout', direction: 'LR', colGap: 260, rowGap: 140 },
  { op: 'align', ids: ['a','b','c'], edge: 'centerY' },
  { op: 'distribute', ids: ['a','b','c'], axis: 'x', gap: 60 },
  { op: 'resize', ids: ['a','b','c'], w: 200, h: 80 },
  { op: 'snap', grid: 20 }
]})
```

   The operations: `align` (edge: left|centerX|right|top|centerY|bottom, the
   reference is the first id), `distribute` (axis x|y, optionally a fixed
   `gap`), `move` (ids, dx, dy), `resize` (ids, w?, h?), `snap` (grid,
   without ids — all shapes), `auto_layout` (direction LR|TB, colGap,
   rowGap; a layered layout by the arrows, unconnected shapes go into a
   separate row). The server moves bound text together with its shape itself
   and RE-ROUTES the arrows by their bindings; the ids of elements do not
   change.
3. A typical recipe for a "not so good" process diagram: `auto_layout LR` →
   for every row from `layout.rows` `align centerY` → `distribute x` →
   `resize` to a common size for blocks of one type → `snap 20`.
4. After the call re-read with `read_page` and check `layout.rows`/`cols`:
   rows/columns must have the same `cy`/`cx`. Tell the user what exactly
   was changed (the summary of the tool) and give a link to the board.

Do not use `update_board({ sketch })` for an existing board — it destroys
the exact diagram; `update_board({ scene })` is only for pinpoint edits of
the content (the text of a label, a color), when `board_ops` does not fit.

## Rules for writing

- First check whether a board with such a title already exists in the
  section you need (`list_tree`/`search_pages`) — do not create a duplicate.
- For laying out/aligning an existing board — `board_ops` (see above); for
  pinpoint edits of the content: `read_page` → changes in `scene` →
  `update_board({ id, scene })`. Do not rewrite the whole board anew through
  `sketch` when a pinpoint edit is asked for (add one node, rename a label)
  — it destroys the manual edits made in the Excalidraw editor of the UI.
- After a write re-read the page (`read_page`) and confirm to the user what
  exactly was added/changed before reporting success.

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
