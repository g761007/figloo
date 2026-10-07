# Roadmap

Where Figloo is going, by area and by release. Figloo is versioned 0.x: a minor version adds features, a patch fixes problems, and tools and results may still change between minor versions. [CHANGELOG.md](CHANGELOG.md) lists what each release changed. The detailed plan behind this roadmap, in Traditional Chinese, is [docs/plans/2026-10-06-productization-and-reliability.md](docs/plans/2026-10-06-productization-and-reliability.md).

Current release: 0.6.0.

## Principles

1. **User intent first.** The user's selection is the main context.
2. **Snapshot first for large work.** Implementing a whole screen starts with a snapshot.
3. **Bounded live exploration.** No unbounded scans of a Figma file.
4. **Local by default.** Figloo needs no cloud service of its own.
5. **Read-only by design.** Figloo never edits the design.
6. **Compatibility is a product feature.** Keeping up with Figma's web UI is core quality, not an implementation detail.
7. **Skills define the workflow.** The MCP tools provide capabilities; the figloo-implement skill decides how to use them.
8. **Reuse project conventions.** Agents use the project's tokens, components, and asset conventions before Figma's raw values.
9. **Fail loudly.** When Figloo cannot read part of Figma's UI, it says so instead of returning an empty value that looks normal.

A new tool is added only for a new kind of operation. Another filter over data Figloo already reads goes into `query_snapshot` or an existing parameter.

## Done after 0.4.1: documentation and the Figma canary

These changed no released files, so they shipped without a release.

- A product-first README, with installation and troubleshooting in their own documents, in English and Traditional Chinese.
- This roadmap and [SECURITY.md](SECURITY.md).
- A daily canary on GitHub Actions that runs the integration tests against a public Figma file as a guest, to notice changes in Figma's web UI before users do.

## 0.4.2 (released): what the canary found first

On its first green run, the canary showed that Figloo stopped at the "Fixed" and "Scrolls" header rows Figma puts among the children of a frame with layers that stay put while it scrolls, and that the integration tests passed anyway with no layers read. 0.4.2 fixes the reading and makes the tests fail on reads that stop early.

## 0.4.3 (released): fail loudly

When Figloo cannot read part of Figma's UI, it now says so instead of returning an empty value that looks normal. A file opened with edit access, where Figma shows the Design panel instead of the inspection panel, is reported by `get_status` and refused at once by the tools that read properties and exports. Export settings and inspection panel sections Figloo cannot read are marked as unreadable, and snapshots count the layers that have them.

## After 0.4.3: a signed-in canary, then refactoring

- **A signed-in canary**, run locally with a dedicated test account, for what only appears once a layer is selected, such as the inspection panel and the export section. A guest cannot select layers, so the daily canary does not reach them. Done as `pnpm test:canary`, run by hand when it matters, such as before a release.
- **Internal refactoring** with no change in behavior, once that canary can check it: `apps/extension/src/adapter/ops.ts` and `apps/extension/src/background.ts` are split into modules by concern. `packages/protocol/src/index.ts` stays one file for now, since its schemas refer to each other.

Refactoring alone makes no release. A fix for a problem a canary finds ships at once, as the next patch, as 0.4.2 did.

## 0.5.0 (released): reliability and developer experience

- `get_status` reports, for each tab, which capabilities Figloo found and which tools a missing one affects, such as the screen reader mirror that `get_visual_neighbors` and view restore need.
- One list of the parts of Figma's UI that Figloo depends on, each marked by how stable it is, shared by the readiness probe, the canary, and Diagnostics.
- Error codes grouped by kind, each saying whether a retry can help, next to the hints they already carry.
- `figloo-mcp doctor` for what can go wrong before the extension connects: Node.js, the config file, the pairing token, and the port. `get_status` checks the rest step by step.
- `PROTOCOL_MISMATCH` names the versions on both sides and which one to update.
- A better agent install, troubleshooting built around these checks, and an updated compatibility table.

Done when a coding agent in a fresh environment follows the README Quickstart, installs Figloo, and completes a first design-to-code task, without the user needing to know how Figloo works. That run is still to be made with the maintainer.

## 0.6.0 (released): design intelligence

- `map_tokens` puts a snapshot's colors, text styles, spacing, and radii next to the tokens the project already defines, exact or near, across web, iOS, Android, and Flutter projects, and lists project components whose names match the design's instances.
- The figloo-implement skill uses it: exact matches as they are, near and unmatched values shown to the user before choosing, and a mapping table in its report.
- Workflow evals check that the skill calls the tools in order and asks before taking a near token, with Figloo's tools mocked.

Next in this area, once real projects have used it: grouping a design's values by what they are for, and detecting more of a project's conventions.

## 0.7.0: performance

- Snapshot benchmarks first. Today `snapshot_layer` reads about 300 layers in 35 to 40 seconds.
- Research into incremental snapshots. The layers panel shows structure, not properties, so a changed color or spacing cannot be seen without selecting each layer. Unless another signal turns up, incremental snapshots can only cover structural changes.
- Fewer UI operations per read, caching, and large screens.

## 0.8 and later: compatibility and distribution

- Figma UI languages other than English, starting with the parts that depend on English labels.
- More Chromium browsers, and noticing a new generation of Figma's UI.
- The Chrome Web Store, if its policy allows the permissions Figloo needs. Publishing there changes the extension ID the server trusts, so it needs a migration plan.

## 1.0

Figloo stays 0.x until all of these hold:

- The core workflow is stable: open Figma, select a screen, take a snapshot, implement it, export its assets, and verify the result.
- A signed-in canary covers the UI that appears after selection and has stayed green for weeks, every part of the UI Figloo reads fails loudly when it cannot be read, and the snapshot format is stable.
- Installing is easy, `doctor` and the update path are clear, errors say how to recover, and the Quickstart passes in a fresh environment.
- Security is documented, and the tool contract and the figloo-implement skill are stable and covered by evals.

## Not planned

Unless a clear use case comes up: many more MCP tools, reverse-engineering Figma's object model, scanning whole large files, a cloud backend, accounts, remote snapshot storage, or a team collaboration platform. Editing designs is out of scope.
