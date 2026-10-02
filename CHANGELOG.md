# Changelog

Notable changes to Figloo, newest first, for each version published as a [GitHub release](https://github.com/g761007/figloo/releases). The release pages also carry install steps and file checksums. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `summarize_snapshot` lists the design values of a saved snapshot, or of one section of it, without the Figma tab: every color with what it colors, text style, gap, padding side, corner radius, border width, and shadow, each with how many layers use it, and the instances by name with each combination of their component properties. The figloo-implement skill calls it before mapping a design onto the project's tokens and components.

### Changed

- GitHub Actions builds and publishes each release from its version tag, and computes the checksum table in the release notes from the files it uploads. Every push and pull request runs the build, type checks, and unit tests.

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

[Unreleased]: https://github.com/g761007/figloo/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/g761007/figloo/releases/tag/v0.3.2
[0.3.1]: https://github.com/g761007/figloo/releases/tag/v0.3.1
[0.1.0]: https://github.com/g761007/figloo/releases/tag/v0.1.0
[0.0.1]: https://github.com/g761007/figloo/releases/tag/v0.0.1
