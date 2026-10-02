---
name: figloo-implement
description: Implement, inspect, or export from a Figma design open in the user's browser, through the Figloo MCP tools (get_anchor, snapshot_layer, query_snapshot, export_asset). Use when the user pastes a prompt copied from Figloo's popup, asks to build or match a Figma page, screen, or component they have open, or asks for icons and images from it. Only for designs Figloo reads in a browser tab; Figma links meant for the Figma REST API or Figma's own MCP server belong to those tools.
---

# Working from a Figma design with Figloo

Figloo reads the Figma design open in the user's browser through Figma's web UI, as a viewer would. Each tool's description covers its parameters, limits, and errors; this skill covers the workflow around them.

Pick the flow from the request:

- Build or update a page or component: **Implementing**, below.
- Answer a question about a design: **Looking**, at the end.
- Get icons or images: **Exporting**, at the end.

## Implementing

### 1. Connect

Call `get_status`. Done when you have the `tabId` of a `READY` or `DEGRADED` tab.

- A prompt the user pasted names a `tabId`: use it. Several design tabs and no prompt: ask the user which file.
- `bridge.role` is `standby`: another agent session holds Figloo. Your first Figma tool call takes over once that session has been idle for 10 seconds; on `BUSY`, tell the user which session holds it and retry shortly.
- Otherwise follow `hint`.

### 2. Settle the scope

Call `get_anchor` with the `tabId`. Done when you and the user agree on the one layer to implement.

- A frame on the canvas or directly in a section is a page: implement it.
- A smaller layer, or several layers: confirm whether the user wants just that part or its whole page (`get_neighbors` with `ancestors` finds the page).
- Nothing selected: find the frame with `list_pages` and `explore_page`, or ask the user to select it.

### 3. Snapshot

Tell the user first: reading takes about 40 seconds per 300 layers, the Figma tab has to be on screen when it starts, and Stop or Esc on Figma's overlay cancels it cleanly. Then call `snapshot_layer` with the context and the layer's ref.

- One call reads for at most 3 minutes. While it returns `complete: false`, tell the user the progress and call it again with the same context and ref; it reads on where the last call stopped.

- The snapshot is saved for 24 hours and comes back without reading Figma again; pass `refresh: true` only when the user says the design changed.
- After Figma reloaded, a context from before fails with `CONTEXT_EXPIRED`: get a new one with `get_anchor` or `explore_page` and pass the same root to `snapshot_layer`. The saved snapshot comes back, and its refs work in the new context.
- `SUBTREE_TOO_LARGE`, above 2,000 layers: snapshot the children it lists, one at a time, and treat each as a section.

Done when you hold the snapshot id, the screenshot, and the whole outline. When `outlineLayers` is below `layerCount`, page through the rest with `query_snapshot` and `nextCursor`.

### 4. See the whole

From the screenshot and the outline's top two levels, write a short plan: the page's sections in order, and its repeated patterns. Instances that share a name usually map to one component or one list item. The outline's format is in [references/snapshot-outline.md](references/snapshot-outline.md).

Done when every top-level layer belongs to a section of the plan.

### 5. Map to the project

Call `summarize_snapshot` with the snapshot id. It lists every color with what it colors, every text style, gap, padding side, corner radius, border width, and shadow, each with how many layers use it, and the instances by name with their component properties.

Search the project for what it already has: components, color and typography tokens, the spacing scale, radii, icons and images, and how it adds new ones (its README, contributing notes, or existing code). Then map the summary and the plan onto them:

- Every color, text style, spacing value, and radius goes through a token: the existing one with that value or meaning (a color given as a style name maps to the token of that name), or a new token added the way the project adds them.
- Every repeated pattern uses an existing component, extended the way the project extends them, or a new component in the project's style.
- Ask the user only where the project shows no way of adding tokens or components.

Done when the plan names a token for every color, text style, spacing value, and radius, and a component for every repeated pattern.

### 6. Fetch details by section

For each section, call `query_snapshot` with `under` set to the section's ref and `details: true`; that returns the section's layers with their inspection panels, a page at a time. Reach inside instances marked `[has layers]` with `get_neighbors` and `inspect_nodes` only when the implementation needs their insides. What the fields mean, with CSS, SwiftUI, and Compose equivalents: [references/inspection-fields.md](references/inspection-fields.md).

Done when you have the values for every layer the section's code uses.

### 7. Build

Write the code section by section, in the project's own conventions, with every value coming from the tokens and components of step 5.

- Layout follows the panel: a frame with `Flow`, `Gap`, and `Padding` is a flex or stack container. Children at `?,?` in the outline are placed by that auto layout, so they flow in it. Absolute positions are for layers inside frames without auto layout.
- `[hidden]` layers stay out unless the user asks for them.
- Text comes from the `content` section, which holds the full text even where the outline cuts it.
- Images and icons come from `export_assets` with the snapshot id, which exports every layer with an `[export …]` mark into one folder, or from `export_asset` for one layer; use the format and scale the project uses for its existing assets.
- An asset `export_asset` cannot deliver yet gets a placeholder of its size and goes on the report's list.

Done when every section of the plan has code and every listed asset is in the project.

### 8. Compare

When you can render the result (a dev server, a simulator, a preview), capture it and compare it with the snapshot's screenshot side by side. Fix the differences or list them. With `image.alignment` of `unconfirmed`, rely on the outline's numbers over positions read off the screenshot.

### 9. Report

Tell the user what you implemented, how the design mapped onto their components and tokens, the assumptions you made, and what remains.

## Looking

Use steps 1 and 2 to reach the layer, then:

- `capture` for a picture of a layer or the page.
- `get_neighbors` for structure, a page at a time; `get_visual_neighbors` for what sits beside a layer on screen.
- `inspect_nodes` for the exact values of up to 5 layers. For more than that, or a whole page, take a snapshot and use `query_snapshot`.
- `summarize_snapshot` on a snapshot for what a page uses overall: its colors, text styles, spacing, radii, shadows, and components.

Quote values as Figma shows them.

## Exporting

Use steps 1 and 2 to reach the layer, then call `export_asset` once per format and scale the project needs, with `saveTo` inside the project. Match the format, scale, and file naming of the assets the project already has.

For many layers, such as every icon of a page, take a snapshot and call `export_assets` with its id and a folder, once per format and scale. Figma exports nothing for `[hidden]` layers, so they are skipped, and `export_asset` answers `LAYER_HIDDEN` for them. When it returns `remaining`, call it again with those refs; on `stoppedBy`, deal with the reason first, for example by asking the user to bring the Figma tab back on screen. Rename the files to the project's conventions afterwards.
