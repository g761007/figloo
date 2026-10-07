# Changelog

Notable changes to Figloo, newest first, for each version published as a [GitHub release](https://github.com/g761007/figloo/releases). The release pages also carry install steps and file checksums. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A GitHub Actions workflow runs the integration tests every day against a public Figma file as a guest, to notice changes in Figma's web UI before users run into them.
- `SECURITY.md` describes the local bridge, the extension's permissions, the data Figloo keeps and where design content goes, and how to report a vulnerability. `ROADMAP.md` lists what comes next.

### Changed

- The README starts with what Figloo is for and how it works. Installation and troubleshooting moved to `docs/installation.md` and `docs/troubleshooting.md`, each also in Traditional Chinese.

### Fixed

- For a frame with layers that stay put while it scrolls, Figma's layers panel lists its children under "Fixed" and "Scrolls" header rows. Figloo stopped at the first header: `get_neighbors` returned no children, siblings, or ancestors for the layers of such a frame, only `hasMore: true` and a cursor, and `snapshot_layer` could not read it. Header rows are now passed over, and since they are shorter than layer rows, the rows of the panel are counted and scrolled to from where Figma draws them. The daily canary found this, and the integration tests now fail when a read stops early instead of passing with fewer layers.

## [0.4.1] - 2026-10-06

### Fixed

- `export_asset` and `export_assets` failed every time with `UI_NOT_READY: Figma did not add an export setting` after Figma replaced the file type control of export settings with a new select. Each failed call left a PNG setting behind in the tab, and a layer's own settings were ignored, so a call without `format` exported SVG. `snapshot_layer` reported no export settings for any layer, so retake snapshots made since then. Figloo now reads both the new select and the old control, names Figma's JPEG `JPG` as the tools do, and says so when Figma added a setting that Figloo cannot read instead of reporting that Figma added none.
- `export_asset` with `format` and `scale` returned two files when the layer's own settings use that format at another scale, such as the designer's PNG 1x next to a requested PNG 3x, and a `saveTo` file name then failed with `EEXIST` because it was taken for a folder. For PNG and JPG only the file at the requested scale comes back now, told apart by its size since Figma names the extra file inconsistently, such as `-1` or `@3x`. When several files still come back, a `saveTo` with a file extension is refused before anything is written and the message lists the files; a folder ending with `/` saves them all. `export_assets` keeps the requested scale the same way. Keeping one scale needs the extension and the MCP server of this release together; the `saveTo` check needs only the server.

## [0.4.0] - 2026-10-03

### Added

- `capture` and `snapshot_layer` put the user's zoom and place on the canvas back once they are done, as they already did with the selection, and say so in `viewRestored`. This needs "Adapt content for screen readers" in Figma, whose screen reader mirror tells exactly where the view is. The view stays where it is when the user uses Figma meanwhile.
- `snapshot_layer` compares a new snapshot with the previous one of the same root: it counts the layers new, changed, and removed, names the removed ones, and marks the others in the outline with what changed, such as `[changed: layout, content]`. `query_snapshot` with `changed: true` lists them. An expired snapshot is kept 30 days for this comparison.
- "Diagnostics" in the popup shows a short report for bug reports and copies it: the extension, protocol, and server versions, the browser, the connection, the tab's readiness and the parts of Figma's UI Figloo found, and the codes of the latest errors. It holds no file, page, or layer names and no links. A bug report form on GitHub asks for it.
- `export_assets` exports several layers one after another into one folder of the project: the given refs, or every layer a snapshot marks with export settings. Files keep Figma's names, with the layer's ref added when a name repeats; a call does up to 50 layers in about 150 seconds and hands back the rest.
- `summarize_snapshot` lists the design values of a saved snapshot, or of one section of it, without the Figma tab: every color with what it colors, text style, gap, padding side, corner radius, border width, and shadow, each with how many layers use it, and the instances by name with each combination of their component properties. The figloo-implement skill calls it before mapping a design onto the project's tokens and components.

### Changed

- `snapshot_layer` reads layers of up to 2,000 layers, up from 400. A call still reads for at most three minutes; when layers are left, it returns `complete: false` with its progress, and calling it again with the same root reads on where it stopped. Until the snapshot is whole, `query_snapshot`, `summarize_snapshot`, and `export_assets` answer `SNAPSHOT_INCOMPLETE`.
- A saved snapshot works after the Figma tab reloads: pass its root to `snapshot_layer` with a new context, and every ref of the snapshot works in that context again. Figloo now tells the tab the way down to these layers, so `inspect_nodes`, `capture`, `export_asset`, and the other tools find them even though the page has not shown them since it loaded.
- `export_asset` and `export_assets` report `LAYER_HIDDEN` at once for a hidden layer, or one inside a hidden layer, which Figma does not export, instead of `EXPORT_BLOCKED` after 12 seconds. An `EXPORT_BLOCKED` message now says what Figma did in the page, such as making no file.
- The extension and the MCP server speak bridge protocol 0.3.0, so both must be replaced together; a mismatched pair reports `PROTOCOL_MISMATCH` in `get_status`.
- GitHub Actions builds and publishes each release from its version tag, and computes the checksum table in the release notes from the files it uploads. Every push and pull request runs the build, type checks, and unit tests.

### Fixed

- Snapshots marked instances inside hidden layers, and hidden instances, as visible: Figma dims such rows in purple instead of greying them. They count as hidden now, and so does every layer inside a hidden layer.

## [0.3.2] - 2026-10-02

### Added

- Figloo is released under the MIT License.
- A Quickstart in the README: one sentence to paste into Claude Code or Codex, which installs Figloo by following `docs/agent-install.md` and walks the user through the steps only they can do.

### Changed

- A new icon: an igloo built from rows like a layers panel, white on an indigo tile, in place of the gradient igloo. Tabs Figloo cannot use still show it in gray.

### Fixed

- A read that ran out of time or UI operations could leave the last layer it read selected and the layers panel scrolled away, when the layer the user had selected was out of view in the panel. Figloo now selects the user's layers again and scrolls the panel back.

## [0.3.1] - 2026-10-02

The first published release since 0.1.0. It includes the changes made as 0.2.0 and 0.3.0, which were not released on their own.

### Added

- Several agent sessions can use Figloo, one at a time. One session's server serves the extension and the others stand by. A standby session takes the extension over when one of its tools needs Figma and the serving session has been idle for 10 seconds, and takes over on its own within a few seconds when the serving session exits.
- Sessions are named after the agent, the project folder, and the start time, for example `Claude Code · shop (started 09:15)`. `get_status`, the toolbar tooltip, the popup, and the options page show which one Figloo serves; the options page also shows the last handover.
- `get_status` reports the bridge's `role` and `holder`, and while standing by lists the serving session's tabs. With several design tabs open, its hint asks the agent to use the `tabId` from the pasted prompt or to ask the user.
- While `snapshot_layer` reads, Figma shows an overlay with the progress and a Stop button. Stop or Esc ends the read and puts the layers panel and the selection back.
- `snapshot_layer` pauses while the Figma tab is in the background and continues once it is back, within its three minutes. A read that runs out of time in the background puts the layers panel back when the tab returns.
- The figloo-implement skill guides an agent through implementing a Figma page or component, looking at a design, and exporting assets.
- A Claude Code plugin and marketplace install the MCP server and the skill together. The server also ships as an MCP bundle, `figloo-mcp-<version>.mcpb`.
- `list_pages` results include `complete`, which is false when the pages list kept changing or showed signs of pages it had not drawn.

### Changed

- A tool that needs Figma while another session is using Figloo returns `BUSY` with that session's name.
- `list_pages` waits until Figma's pages list stops changing, up to two seconds, so each call takes about 200 ms longer.
- Servers from 0.1.0 cannot hand the extension over. Restart every agent session that still runs one. The bridge protocol stays 0.2.0.

### Fixed

- `list_pages` could return only some of a file's pages on its first call.

## [0.1.0] - 2026-10-02

### Added

- `snapshot_layer` reads a layer and everything inside it, up to 400 layers, in one call: a screenshot, and each layer's place, size, visibility, export settings, and inspection panel. Snapshots are saved under `~/.figloo/snapshots/` for 24 hours, set by `snapshotTtlHours` in the config file. `image.alignment` says whether the root's place in the screenshot was checked against the screenshot itself.
- `query_snapshot` looks layers up in a saved snapshot without the Figma tab: by ref, or by text, type, and the layer they are inside.
- `get_visual_neighbors` lists a layer's siblings by where they are on screen, with the side, gap, and offset in design pixels.
- When the selected layer is a screen frame, the popup's prompt asks the agent to implement that page and to take a snapshot of it first.
- The README is also available in Traditional Chinese (Taiwan).

### Changed

- `get_anchor` returns up to 20 selected layers instead of refusing a multiple selection.
- The extension and the MCP server speak bridge protocol 0.2.0, so both files must be replaced together; a mismatched pair reports `PROTOCOL_MISMATCH` in `get_status`.

### Fixed

- `capture` no longer crops around a layer's old place when the zoom barely changes, for example from 100% to 93%.
- `get_visual_neighbors` measures lines, which have no height on screen.

## [0.0.1] - 2026-10-01

### Added

- The first release: a Chrome extension and a local MCP server that let a coding agent read a Figma design file through the Figma web UI, for engineers with view access. Figloo never edits the design.
- `get_status`, `list_pages`, `explore_page`, `get_anchor`, and `get_neighbors` list pages and walk the layer tree in bounded steps.
- `inspect_nodes` returns what Figma's inspection panel shows for up to 5 layers.
- `capture` takes a screenshot of a layer or a whole page.
- `export_asset` exports icons and images as SVG, PNG, JPG, or PDF and hands them straight to the agent.
- The toolbar icon and popup show the tab's status, the selected layer's path and children, and a prompt to copy for the agent.
- `figloo-mcp pair` prints the pairing token and port to paste into the extension's options page.

[Unreleased]: https://github.com/g761007/figloo/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/g761007/figloo/releases/tag/v0.4.1
[0.4.0]: https://github.com/g761007/figloo/releases/tag/v0.4.0
[0.3.2]: https://github.com/g761007/figloo/releases/tag/v0.3.2
[0.3.1]: https://github.com/g761007/figloo/releases/tag/v0.3.1
[0.1.0]: https://github.com/g761007/figloo/releases/tag/v0.1.0
[0.0.1]: https://github.com/g761007/figloo/releases/tag/v0.0.1
