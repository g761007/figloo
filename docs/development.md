# Developing Figloo

English | [繁體中文](development.zh-TW.md)

How to build, test, and release Figloo, and how the repository is laid out. Install and set-up steps for users are in [installation.md](installation.md).

## Commands

```sh
pnpm build             # pnpm -r build
pnpm typecheck         # pnpm -r typecheck
pnpm test              # pnpm -r test (vitest in every package)
pnpm test:integration  # real Chromium + real MCP process + real Figma tabs, see below
pnpm package           # build, then write the release files into release/
pnpm test:release      # the status integration test, run against the files in release/
pnpm --filter @figloo/mcp docs:tools   # regenerate docs/mcp-tools.md after changing a tool
claude plugin validate --strict plugins/figloo   # check the plugin; run it on . for the marketplace
claude plugin eval plugins/figloo --mocks off --ablation none   # whether the skill fires when it should, and only then
claude plugin eval tests/skill-eval --ablation none   # whether the skill's workflow calls the tools in order, with mocked tools
```

`pnpm package` also checks that the extension's manifest and the three `package.json` files carry the same version, that `plugins/figloo/.claude-plugin/plugin.json` carries it with the URL of that version's bundle, and that [CHANGELOG.md](../CHANGELOG.md) has a section for the version, so bump them together. The plugin evals need `--mocks off`, since `claude plugin eval` cannot stand in for a server declared through a bundle; the cases grant no Figloo tools, so nothing reaches Figma. The workflow evals therefore run against `tests/skill-eval/`, a harness that is never published: it links the same skill and declares the server in `.mcp.json`, so its cases answer Figloo's tools from mock files. Their tool list, `tests/skill-eval/evals/mocks/figloo/_tools.json`, comes from the server like `docs/mcp-tools.md` and is checked the same way.

`pnpm test` fails when `docs/mcp-tools.md` no longer matches the tools the server registers.

GitHub Actions runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) on every push to `main` and every pull request: build, typecheck, the unit tests one package at a time, and packaging. The integration tests below need a browser and a Figma link, so they run locally, and once a day in [`.github/workflows/figma-canary.yml`](../.github/workflows/figma-canary.yml) against a public test file, to catch changes in Figma's web UI early.

To release a version:

1. Bump the version in `apps/extension/static/manifest.json`, the three `package.json` files, and `plugins/figloo/.claude-plugin/plugin.json` (its version and bundle URL), and add the version's section to CHANGELOG.md. Text above the section's first `###` heading becomes the introduction of the release notes.
2. Run `pnpm package` and `pnpm test:release`.
3. Commit, tag the commit `vX.Y.Z`, and push both at once: `git push origin main vX.Y.Z`. [`.github/workflows/release.yml`](../.github/workflows/release.yml) tests and packages the tagged commit, checks the tag against the version, writes the notes with the SHA-256 of the files it uploads, and publishes the release. New plugin installs cannot download the bundle until the release is out, so push the tag together with the commit.

Running the Release workflow by hand from the Actions tab is a dry run: it keeps the files and the notes as an artifact and publishes nothing.

The integration test (`tests/integration/get-status.e2e.mjs`) launches Playwright's Chromium with the built extension, pairs it through the options page, opens a Figma file as a guest, and checks `get_status` before and after restarting the MCP process, and while a second server takes the extension over and exits again. It needs network access, a built workspace, the browser download, and a Figma design file that anyone with the link can view and that has at least two pages. The link is not committed: copy the example file to `tests/integration/.env.local`, which git ignores, and fill it in, or set `FIGLOO_E2E_FIGMA_URL` instead:

```sh
pnpm exec playwright install chromium
cp tests/integration/.env.example tests/integration/.env.local
```

Branded Google Chrome 137 and newer ignore `--load-extension`, which is why the test does not use the installed Chrome. A second script, `tests/integration/explore.e2e.mjs`, injects the layer navigation code into a visible guest Figma tab and checks expanding, listing, paging, climbing past same-named layers, and restoring the panel, so the file needs two same-named sibling layers with children. Set `FIGLOO_E2E_HEADED=1` to watch them.

The Figma canary workflow runs both scripts every day, and on demand from the Actions tab. It reads the link from the repository secret `FIGLOO_CANARY_FIGMA_URL` and fails when the secret is missing. Its logs are public and show layer names, so the file must be one made for the test, never a real design.

The signed-in canary checks what a guest cannot reach: the selection, the inspection panel, snapshots, exports, and putting the view back. It runs on your machine only, never in CI, with a browser profile signed in to a dedicated Figma test account that only views the test file and has "Adapt content for screen readers" on. Sign in once with the first command below, which opens the profile in a window and types nothing for you; the profile stays in `~/.figloo/canary-profile` (or `FIGLOO_CANARY_PROFILE`). Then set `FIGLOO_CANARY_FIGMA_URL` in `tests/integration/.env.local` to a link to the frame to snapshot, which must hold a layer with export settings, and run the canary. It prints refs, counts, and codes only.

```sh
node tests/canary/login.mjs
pnpm test:canary
```

The snapshot benchmark shows where `snapshot_layer`'s time goes: it snapshots a frame several times, reading Figma again each time, and prints the median of every phase, such as the screenshot, the walk, and selecting each layer, with layer counts and milliseconds only. By default it uses the canary profile and link; with `--attach` it uses your own browser and config instead, so keep the Figma tab in front.

```sh
pnpm bench:snapshot --runs 3 --refs 0:2,0:78
pnpm bench:snapshot --attach
```

The core-scenario acceptance run needs a signed-in browser, so it is not part of `pnpm test`. With the extension paired, the Figma tab on screen, no other Figloo server running, and one layer inside a card selected, it runs the whole flow ten times and checks that every run returns the same result:

```sh
node tests/acceptance/core-scenario.mjs
```

`FIGLOO_ACCEPT_RUNS` changes the number of runs, and `FIGLOO_ACCEPT_MCP_ENTRY=release/figloo-mcp-<version>.mjs` runs it against the release file.

## Icons

The toolbar icon's artwork lives in `apps/extension/scripts/render-icons.mjs`. After changing it, regenerate the committed PNGs:

```sh
pnpm --filter @figloo/extension icons
```

## Repository layout

```text
apps/extension/      Chrome extension (Manifest V3): @figloo/extension
apps/mcp/            Local MCP server over stdio plus the WebSocket bridge: @figloo/mcp
packages/protocol/   Shared zod schemas, types, and constants: @figloo/protocol
docs/                Installation, troubleshooting, the tool contract, and the agent install steps
docs/plans/          Planning documents
docs/compatibility/  What was verified on real Figma pages, and known limits
plugins/figloo/      Claude Code plugin: the figloo-implement skill, its evals, and the server bundle it downloads
.claude-plugin/      Marketplace manifest, so the repository can be added with /plugin marketplace add
scripts/             Release packaging, the release check, and the release notes
.github/workflows/   CI, the release workflow a version tag starts, and the daily Figma canary
tests/fixtures/      Captured Figma markup and export files for regression tests
tests/integration/   End-to-end tests against real Chromium and Figma
tests/bench/         Snapshot benchmark, run locally
tests/canary/        Signed-in canary for a dedicated test account, run locally
tests/skill-eval/    Unpublished harness for the skill's workflow evals, with mocked Figloo tools
tests/acceptance/    Core-scenario acceptance run for a signed-in browser
release/             Output of pnpm package (not committed)
```
