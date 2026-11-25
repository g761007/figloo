---
name: figloo-implement
description: Implement, survey, inspect, or export from a Figma design open in the user's browser, through the Figloo MCP tools (get_anchor, survey_frames, snapshot_layer, query_snapshot, export_asset). Use when the user pastes a prompt copied from Figloo's popup, asks to build or match a Figma page, screen, or component they have open, asks to go through many screens of it first, such as for a new app, a new feature, or a redesign, or asks for icons and images from it. Only for designs Figloo reads in a browser tab; Figma links meant for the Figma REST API or Figma's own MCP server belong to those tools.
---

# Working from a Figma design with Figloo

Figloo reads the Figma design open in the user's browser through Figma's web UI, as a viewer would. Each tool's description covers its parameters, limits, and errors; this skill covers the workflow around them.

Pick the flow from the request:

- Build or update a page or component: **Implementing**, below.
- Work that spans many frames, such as a new app, a new feature, or a redesign, or an overview before planning: **Surveying several frames**, after Implementing.
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
- The request spans many frames: survey them first, see **Surveying several frames**.

### 3. Snapshot

Tell the user first: reading takes about 40 seconds per 600 layers, the Figma tab has to be on screen when it starts, and Stop or Esc on Figma's overlay cancels it cleanly. Then call `snapshot_layer` with the context and the layer's ref.

- One call reads for at most 3 minutes. While it returns `complete: false`, tell the user the progress and call it again with the same context and ref; it reads on where the last call stopped.

- The snapshot is saved for 24 hours and comes back without reading Figma again; pass `refresh: true` only when the user says the design changed.
- After a refresh, `changes` counts what is new, changed, and removed since the previous snapshot, and `query_snapshot` with `changed: true` lists the new and changed layers. Update only the code for those layers and remove what the removed ones built.
- After Figma reloaded, a context from before fails with `CONTEXT_EXPIRED`: get a new one with `get_anchor` or `explore_page` and pass the same root to `snapshot_layer`. The saved snapshot comes back, and its refs work in the new context.
- `SUBTREE_TOO_LARGE`, above 2,000 layers: snapshot the children it lists, one at a time, and treat each as a section.

Done when you hold the snapshot id, the screenshot, and the whole outline. When `outlineLayers` is below `layerCount`, page through the rest with `query_snapshot` and `nextCursor`.

### 4. See the whole

From the screenshot and the outline's top two levels, write a short plan: the page's sections in order, and its repeated patterns. Instances that share a name usually map to one component or one list item. The outline's format is in [references/snapshot-outline.md](references/snapshot-outline.md).

Done when every top-level layer belongs to a section of the plan.

### 5. Map to the project

Call `map_tokens` with the snapshot id. It reads the project's token definitions and puts every color, text style, spacing value, and corner radius of the snapshot next to them: exact matches, near ones with what differs, and values with none. It also lists the project components whose names share each instance's words. In a monorepo, pass `path` to the app the design is for. `scanned.sources` shows where it found tokens; when that is empty or misses where the project really keeps them, or `scanned.complete` is false, search the project yourself as well. `summarize_snapshot` has the rest of the design's values, such as borders and shadows.

Also search the project for what `map_tokens` does not cover: icons and images, and how the project adds new tokens and components (its README, contributing notes, or existing code). Then map the summary and the plan onto the project:

- An exact match: use that token.
- A near match or no match: show the user a short table of the design value, the closest token, and what differs, and ask whether to reuse the token or add a new one the way the project adds them. Do not pick a near token on your own; a difference in the design may be deliberate.
- A color given as a style name maps to the token of that name; a value bound to a Figma variable (its `variable`) maps to the token named like the variable, which `map_tokens` lists first.
- Every repeated pattern uses an existing component, extended the way the project extends them, or a new component in the project's style. Read a candidate before reusing it.

Done when the plan names a token for every color, text style, spacing value, and radius, and a component for every repeated pattern, with the user's answers for the near and unmatched ones.

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

Tell the user what you implemented, how the design mapped onto their components and tokens (a table of each design value with the token it uses, and whether it matched exactly, nearly, or became a new token), the assumptions you made, and what remains.

## Surveying several frames

When the work spans many frames, read them all cheaply before snapshotting any: a survey walks each frame's layers without reading inspection panels, so a page of 70 frames takes about 30 seconds and a short overview instead of many snapshots.

1. **Scope.** Connect as in Implementing step 1, then agree on the frames with the user: the frames or sections they select (`get_anchor`), or the page shown in Figma (`explore_page` without `page`). Do not switch Figma pages yourself; when related frames are on another page, ask the user. Done when you hold a contextId on the right page, and the refs of the frames or sections when the user picked some.
2. **Survey.** Call `survey_frames` with the contextId, and `refs` when the user picked frames or sections. While it returns `complete: false`, call it again with the same arguments. Done when you hold the overview.
3. **Read it.** The overview numbers the frames `#1`, `#2`, …, and lists flows by name, sections, the designers' notes in full, the components shared across frames, names that may mean one component, and what is worth a look. The notes are the designers' intent, such as token values and when to use a dialog or a sheet; names are only hints, since many layers keep names Figma gave them.
4. **Look where names say little.** For frames the overview marks as mostly auto-named, or frames whose names do not tell them apart, call `survey_thumbnails` with the survey id and those frame numbers. Tell the user first: Figma's view moves from frame to frame, about 1.4 seconds each, Figma stays locked until it ends, and Stop or Esc on its overlay ends it early. While `remaining` is not empty, call it again with `frames` set to `remaining`.
5. **Report and propose.** Tell the user, briefly: the flows and their frames; the components shared across frames, and the ones that appear under several names or as detached copies; the rules and token values in the notes; and what looked inconsistent. Then propose which frames to snapshot and why, such as one frame per distinct layout, the frames that use components no other frame does, and a component or style guide frame when there is one, with the time from the overview's estimates. Do not snapshot before the user agrees. Done when the user agreed on the list.
6. **Go on.** Snapshot each agreed frame as in Implementing step 3. To plan the work, run `summarize_snapshot` and `map_tokens` on each snapshot and combine them into a list of shared tokens and components, which values are new, and the order to build the screens in; to build, follow Implementing from step 4 for each frame.

## Looking

Use steps 1 and 2 to reach the layer, then:

- `capture` for a picture of a layer or the page.
- `survey_frames` for an overview of many frames, and `survey_thumbnails` to see them; see **Surveying several frames**.
- `get_neighbors` for structure, a page at a time; `get_visual_neighbors` for what sits beside a layer on screen.
- `inspect_nodes` for the exact values of up to 5 layers. For more than that, or a whole page, take a snapshot and use `query_snapshot`.
- `summarize_snapshot` on a snapshot for what a page uses overall: its colors, text styles, spacing, radii, shadows, and components; `map_tokens` for which of them the project already has.

Quote values as Figma shows them.

## Exporting

Use steps 1 and 2 to reach the layer, then call `export_asset` once per format and scale the project needs, with `saveTo` inside the project. Match the format, scale, and file naming of the assets the project already has.

For many layers, such as every icon of a page, take a snapshot and call `export_assets` with its id and a folder, once per format and scale. Figma exports nothing for `[hidden]` layers, so they are skipped, and `export_asset` answers `LAYER_HIDDEN` for them. When it returns `remaining`, call it again with those refs; on `stoppedBy`, deal with the reason first, for example by asking the user to bring the Figma tab back on screen. Rename the files to the project's conventions afterwards.
