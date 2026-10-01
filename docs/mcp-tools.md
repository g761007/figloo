# Figloo MCP tools

Generated from the tools the server registers by `apps/mcp/test/tool-docs.test.ts`; the test fails when this file is out of date. Regenerate it with `pnpm --filter @figloo/mcp docs:tools`.

Every tool returns its result as JSON text and as `structuredContent`. A failed call returns `isError: true` with the text `{"error": {"code", "message", "hint"}}`, where `hint` tells the agent what to do next.

## get_status

Report whether the Figloo browser extension is connected, which Figma design tabs are open, and what each tab can read. Call this first.

No parameters.

| Result field | Type |
|---|---|
| `status` | "DISCONNECTED" or "NO_DESIGN_TAB" or "LOADING" or "READY" or "DEGRADED" or "INCOMPATIBLE" |
| `protocolVersion` | string |
| `bridge` | object with listening, port, error |
| `extension` | object with connected, extensionVersion, userAgent, connectedAt, lastDisconnectAt, lastError |
| `tabs` | array of object with tabId, windowId, url, title, fileKey, fileName, nodeIdFromUrl, readiness, access, uiLocale, capabilities, layerRowCount, visible, probedAt, detail |
| `tabsFresh` | boolean |
| `hint` | string or null |

## get_anchor

Start exploring from the layers the user selected in a Figma tab. Returns the selected layers (the anchors) and a contextId for get_neighbors. anchor is the first selected layer; anchors lists every selected layer found, in layers panel order, at most 20. Fewer anchors than selectionCount means the rest are hidden in collapsed groups; ask the user to reveal them if they matter. Use a tabId from get_status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tabId` | integer | yes | Figma tab from get_status |

| Result field | Type |
|---|---|
| `contextId` | string |
| `tabId` | integer |
| `fileKey` | string |
| `page` | string or null |
| `selectionCount` | integer, at least 0 |
| `anchor` | object with ref, name, nameTruncated, type, depth, position, siblingCount, parentRef, hasChildren, childCount, insideInstance, link |
| `anchors` | array of object with ref, name, nameTruncated, type, depth, position, siblingCount, parentRef, hasChildren, childCount, insideInstance, link |

## get_neighbors

List layers related to a ref within a context. relation is one of: parent; ancestors (nearest first, up to the layer on the page); siblings (all children of the ref's parent in layer order, including the ref); children (direct children only). Returns at most limit summaries (default 20, max 50); pass nextCursor to continue. Only refs returned in this context are accepted, and nothing beyond the requested relation is read. For children, depth (max 3) also lists deeper levels breadth first within the same limit; such a tree has no cursor, so query deeper layers directly when hasMore is true. Listing children may expand layers in the Figma layers panel; they are collapsed again afterwards, and collapsed layers can only be expanded while the Figma tab is visible.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contextId` | string | yes |  |
| `ref` | string | yes | A ref returned earlier in this context |
| `relation` | "parent" or "ancestors" or "siblings" or "children" | yes |  |
| `cursor` | string | no | nextCursor from the previous page of the same ref and relation |
| `limit` | integer 1 to 50 | no |  |
| `depth` | integer 1 to 3 | no | children only: levels to include, default 1 |

| Result field | Type |
|---|---|
| `contextId` | string |
| `ref` | string |
| `relation` | "parent" or "ancestors" or "siblings" or "children" |
| `nodes` | array of object with ref, name, nameTruncated, type, depth, position, siblingCount, parentRef, hasChildren, childCount, insideInstance, link |
| `coverage` | object with fromPosition, toPosition, total |
| `hasMore` | boolean |
| `nextCursor` | string or null |
| `stopReason` | "complete" or "limit" or "time_budget" or "scan_budget" or "output_budget" or "ui_timeout" |
| `uiOps` | integer, at least 0 |
| `elapsedMs` | number, at least 0 |

## list_pages

List the pages of the Figma file open in a tab and which one is shown. Works while the tab is in the background.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tabId` | integer | yes | Figma tab from get_status |

| Result field | Type |
|---|---|
| `tabId` | integer |
| `fileKey` | string |
| `pages` | array of object with name, current |

## explore_page

Open a page of the Figma file (the shown page when page is omitted) and list the layers directly on it, usually frames and sections. Returns a contextId for get_neighbors, inspect_nodes, and capture, so exploring does not depend on what the user selected. Switching pages needs the Figma tab visible on screen and changes the page the user sees. When hasMore is true, continue with get_neighbors(ref = nodes[0].ref, relation = siblings, cursor = nextCursor).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tabId` | integer | yes | Figma tab from get_status |
| `page` | string | no | Page name from list_pages |
| `limit` | integer 1 to 50 | no |  |

| Result field | Type |
|---|---|
| `contextId` | string |
| `tabId` | integer |
| `fileKey` | string |
| `page` | string or null |
| `nodes` | array of object with ref, name, nameTruncated, type, depth, position, siblingCount, parentRef, hasChildren, childCount, insideInstance, link |
| `total` | integer, at least 0 or null |
| `hasMore` | boolean |
| `nextCursor` | string or null |

## get_visual_neighbors

List the siblings of a layer by where they are on screen: direction right, left, below, or above, or nearest (default) for all of them by distance. Each one has its side, whether it shares a row or column with the layer (inLine), the edge-to-edge gap, and its offset and size. Lengths are design pixels, measured on screen and divided by the zoom; text layers, which Figma does not place on screen, are placed from the inspection panel instead. Use inspect_nodes for exact values. Only layers in the same parent are compared; call it again on an ancestor to look further out. Needs Figma's Adapt content for screen readers setting and the Figma tab on screen. Siblings are selected in turn, and the user's selection is put back afterwards.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contextId` | string | yes |  |
| `ref` | string | yes | A ref returned earlier in this context |
| `direction` | "nearest" or "right" or "left" or "below" or "above" | no | Default nearest |
| `limit` | integer 1 to 20 | no | Default 10 |

| Result field | Type |
|---|---|
| `contextId` | string |
| `ref` | string |
| `direction` | "nearest" or "right" or "left" or "below" or "above" |
| `reference` | object with width, height |
| `zoom` | number or null |
| `neighbors` | array of object with ref, name, nameTruncated, type, depth, position, siblingCount, parentRef, hasChildren, childCount, insideInstance, link, side, inLine, gap, offset, size |
| `compared` | integer, at least 0 |
| `unplaced` | array of string |
| `siblingsHasMore` | boolean |
| `userSelectionRestored` | boolean |
| `uiOps` | integer, at least 0 |
| `elapsedMs` | number, at least 0 |

## inspect_nodes

Read what Figma's inspection panel shows for up to 5 layers of a context. layout: size and sizing mode, position in the parent, auto layout flow, padding, gap, corner radius. appearance: fills, borders, shadows, image file names. typography: text content and, per style run, font, weight, style, size, line height, letter spacing. component: component properties and the parent component. Values are exactly as Figma displays them; groups a layer does not have are listed in notShown. Each layer is selected in turn, so the Figma tab must be visible; the user's selection is put back afterwards.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contextId` | string | yes |  |
| `refs` | array of string | yes | Refs returned earlier in this context |
| `groups` | array of "layout" or "appearance" or "typography" or "component" | no | Default: all groups |

| Result field | Type |
|---|---|
| `contextId` | string |
| `nodes` | array of object with ref, name, type, sections, notShown |
| `userSelectionRestored` | boolean |
| `uiOps` | integer, at least 0 |
| `elapsedMs` | number, at least 0 |

## capture

Screenshot a layer of a context, zoomed to fit the screen, or the whole page when ref is omitted. Returns a JPEG at most 1568 px on its long edge as visual reference; read exact values with inspect_nodes. The Figma tab must be visible. The view zooms to the target and stays there; the user's selection is put back.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contextId` | string | yes |  |
| `ref` | string | no | A ref returned earlier in this context; omit for the whole page |

| Result field | Type |
|---|---|
| `contextId` | string |
| `ref` | string or null |
| `width` | integer |
| `height` | integer |
| `cropSource` | "layer" or "canvas" |
| `zoom` | string or null |
| `userSelectionRestored` | boolean |

## export_asset

Export a layer of a context with Figma's Export button and hand the files over: SVG markup inline, and PNG or JPG up to 1568 px as an image. Choose format and scale for the project, for example by checking how it already stores icons: SVG for web or Android vector drawables, PDF or PNG at 1x, 2x, and 3x for iOS, PNG at 1x to 4x for Android densities. One call exports one scale. With format, a temporary setting in that format and scale is added and removed again, unless the layer already has that exact setting, and only files in that format are returned. Without format, the designer's own export settings decide, and a layer without settings exports as SVG. With saveTo, the files are also written inside the project directory. Figma names files after the layer without a scale suffix, so give a full file name such as icons/close@2x.png for each scale, or end saveTo with a slash to keep Figma's name. Figloo normally receives the file inside the page, so the browser saves nothing; if that fails it falls back to the browser's download and reports its path. The Figma tab must be visible.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contextId` | string | yes |  |
| `ref` | string | yes | A ref returned earlier in this context |
| `format` | "svg" or "png" or "jpg" or "pdf" | no | Pick it for the project; without it the designer's export settings decide |
| `scale` | "0.5x" or "0.75x" or "1x" or "1.5x" or "2x" or "3x" or "4x" | no | Default 1x |
| `saveTo` | string | no | Path inside the project, for example src/assets/icons/close.svg or src/assets/icons/ |
| `overwrite` | boolean | no |  |

| Result field | Type |
|---|---|
| `contextId` | string |
| `ref` | string |
| `source` | "direct" or "download" |
| `files` | array of object with name, mimeType, bytes, savedTo, downloadPath, svg |
| `usedExistingSettings` | boolean |
| `userSelectionRestored` | boolean |

## snapshot_layer

Read a layer and everything inside it in one go, for implementing a page: a screenshot, and for each layer its place, size, and all that inspect_nodes shows, saved as a snapshot that query_snapshot reads without Figma. Use it on the page's root, such as the frame the user selected (get_anchor). Instances count as one layer; read inside them with get_neighbors. Returns the screenshot, the snapshot id, and an outline with one line per layer: ref, type, name, x,y and width×height in design pixels from the root's top-left corner (? when Figma shows no place), the start of its text, and marks for hidden layers, instances with layers of their own, and export settings. A layer at (x, y) shows at image.rootInImage + (x, y) × image.scale in the screenshot. A saved snapshot comes back without reading Figma until expiresAt; pass refresh: true when the user says the design changed. Reading takes about 40 s for 300 layers, at most 3 minutes, for up to 400 layers; a larger subtree fails and lists the root's children. Meanwhile the Figma tab must stay visible and the user cannot use Figma; a click in Figma stops it. The user's selection is put back; the view stays zoomed to the root.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contextId` | string | yes |  |
| `ref` | string | yes | A ref returned earlier in this context, outside instances |
| `refresh` | boolean | no | Read Figma again even when a saved snapshot has not expired |

| Result field | Type |
|---|---|
| `contextId` | string |
| `snapshot` | string |
| `fileKey` | string |
| `page` | string or null |
| `rootRef` | string |
| `createdAt` | string |
| `expiresAt` | string |
| `fromCache` | boolean |
| `layerCount` | integer, at least 1 |
| `image` | object with width, height, rootInImage, scale |
| `outline` | string |
| `outlineLayers` | integer, at least 0 |
| `nextCursor` | string or null |
| `elapsedMs` | number, at least 0 |

## query_snapshot

Look layers up in a snapshot from snapshot_layer. Reads the saved file only, so it needs no Figma tab and works after the page reloads. refs: those layers in full, up to 20: bounds with where they came from, hidden, export settings, and every inspection panel section as inspect_nodes returns them. Otherwise filter by text (in names and text content, ignoring case), type (such as Text, Instance, or Auto layout), and under (only layers inside that ref); filters combine, and none lists every layer. Matches come as outline lines, or in full with details: true, one page at a time; pass nextCursor for the next page. An expired snapshot fails; take a new one with snapshot_layer.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `snapshot` | string | yes | The snapshot id from snapshot_layer |
| `refs` | array of string | no | Layers to return in full; not combined with the filters |
| `text` | string | no |  |
| `type` | string | no |  |
| `under` | string | no | A ref in the snapshot |
| `details` | boolean | no | Return matches in full instead of as outline lines |
| `cursor` | string | no | nextCursor from the previous page of the same query |

| Result field | Type |
|---|---|
| `snapshot` | string |
| `expiresAt` | string |
| `matched` | integer, at least 0 |
| `from` | integer, at least 1 |
| `outline` | string or null |
| `layers` | array of object with ref, name, type, depth, parentRef, position, siblingCount, hasChildren, hidden, bounds, sections, exports or null |
| `missing` | array of string |
| `hasMore` | boolean |
| `nextCursor` | string or null |

## release_context

Forget an exploration context and the refs it returned.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `contextId` | string | yes |  |

| Result field | Type |
|---|---|
| `released` | boolean |

## Error codes

| Code | Hint |
|---|---|
| `BAD_MESSAGE` | No hint; the message says what went wrong. |
| `BUDGET_EXCEEDED` | The operation ran out of its time or UI budget; narrow the request or retry. |
| `BUSY` | Another operation is running in this tab; retry after it finishes. |
| `CONTEXT_EXPIRED` | The Figma tab reloaded or switched files; call get_anchor again. |
| `CONTEXT_NOT_FOUND` | The context was released or expired; call get_anchor again. |
| `EXPORT_BLOCKED` | Figma handed over no file and the browser started no download. If the browser blocked repeated downloads from figma.com, ask the user to allow them in the site settings, then retry. |
| `EXPORT_PENDING` | The browser is waiting to save the export, probably behind a Save dialog. Ask the user to confirm it, or to turn off asking where to save each file. |
| `INSIDE_INSTANCE` | Layers inside an instance get new IDs when the page reloads, so a snapshot needs a root outside instances: use the instance itself or a layer above it. |
| `INTERNAL` | No hint; the message says what went wrong. |
| `INVALID_ARGUMENT` | Check the tool's parameters against its description. |
| `INVALID_CURSOR` | Pass nextCursor exactly as returned, with the same contextId, ref, and relation. |
| `NODE_NOT_FOUND` | The layer is no longer in the layers panel; call get_anchor again. |
| `NOT_CONNECTED` | Call get_status for setup steps. |
| `NO_SELECTION` | Ask the user to select the layers to work on in Figma, then call get_anchor again. |
| `PAGE_CHANGED` | The user switched to another Figma page; call get_anchor again. |
| `PROTOCOL_MISMATCH` | No hint; the message says what went wrong. |
| `SAVE_REFUSED` | saveTo must be a path inside the project directory, and existing files are only replaced with overwrite: true. |
| `SNAPSHOT_EXPIRED` | Take a new snapshot with snapshot_layer, which needs a contextId from get_anchor or explore_page. |
| `SNAPSHOT_NOT_FOUND` | Pass the snapshot id exactly as snapshot_layer returned it; without one, take a snapshot with snapshot_layer. |
| `SUBTREE_TOO_LARGE` | Snapshot a smaller root: call snapshot_layer on one of the children listed in the message, or on a layer further down. |
| `TAB_IN_BACKGROUND` | Ask the user to bring the Figma tab to the front (visible on screen, it may sit beside other windows), then retry. Reading pages, the selection, and already expanded layers still works from the background. |
| `TAB_NOT_FOUND` | Call get_status to list the open Figma tabs and their tabId. |
| `TIMEOUT` | The Figma tab did not answer in time; call get_status. |
| `UI_NOT_READY` | Call get_status to see what the Figma tab can do right now. |
| `UNAUTHORIZED` | No hint; the message says what went wrong. |
| `UNKNOWN_REF` | Pass a ref returned earlier in this context. |
| `USER_INTERRUPTED` | The user interacted with Figma during the operation. Check with the user before retrying. |
