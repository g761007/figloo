# Reading a snapshot

## Outline lines

`snapshot_layer` and `query_snapshot` list layers as outline lines, one per layer, in layers panel order:

```text
  12:340 Auto layout "Card" 16,120 343×96 [export PNG 2x]
    12:341 Text "Title" ?,? 200×24 text "Order #1024 is on its…"
    12:342 Instance "Icon/Chevron" 311,36 16×16 [has layers]
```

Each line holds, in order:

| Part | Meaning |
|---|---|
| Indent | Two spaces per level below the snapshot's root |
| `12:340` | The layer's ref, for `query_snapshot` and the other tools |
| `Auto layout` | The type the layers panel's icon names, such as Frame, Auto layout, Section, Group, Text, Instance, Component, or Image; `?` when unknown |
| `"Card"` | The layer's name, cut at 60 characters |
| `16,120` | Its top-left corner in design pixels from the root's top-left corner. `?,?` when Figma shows no position, which is how auto layout places text |
| `343×96` | Width and height in design pixels, when known |
| `text "…"` | The start of a text layer's content, cut at 40 characters, when it differs from the name. The full text is in the `content` section |
| `[hidden]` | Hidden in Figma, or inside a hidden layer |
| `[has layers]` | An instance with layers of its own; a snapshot does not read inside instances |
| `[export …]` | The export settings the designer gave the layer, such as `PNG 2x` or `SVG` |

## Places in the screenshot

A layer at `x,y` in the outline appears in the screenshot at `image.rootInImage + (x, y) × image.scale`, in image pixels.

`image.alignment` says how far to trust that:

- `confirmed`: Figloo checked the root's place against the screenshot.
- `corrected`: Figma reported a stale place, and Figloo moved it to where the screenshot shows the root.
- `unconfirmed`: not checked; places read off the screenshot may be off by a few dozen pixels.

The outline's own numbers are relative to the root and are not affected by alignment.

## A layer in full

`query_snapshot` with `refs`, or with `details: true`, returns layers in full:

| Field | Meaning |
|---|---|
| `bounds` | `x`, `y`, `width`, `height` as in the outline, and `source`: `mirror` (measured on screen), `panel` (the panel's Top and Left added to its frame's place), or `unknown` (the size at most) |
| `hidden`, `exports` | As the outline marks them; `exports` is null when Figloo could not confirm the export section belonged to this layer |
| `sections` | The inspection panel, block by block, in panel order |

Each section has a `kind`, such as `properties`, `colors`, `borders`, `shadows`, `typography1`, or `content`; a `group` (`layout`, `appearance`, `typography`, `component`, or `other`); a `title`; `properties` as `{ group, name, value }` exactly as the panel shows them; `colors` as `{ value, opacity }`, where `value` is a hex code or the name of a color style; and `text`, which holds the text content for `content` and the parent component's name for `selection_hierarchy`. What the property names mean: [inspection-fields.md](inspection-fields.md).
