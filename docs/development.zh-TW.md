# 開發 Figloo

[English](development.md) | 繁體中文

如何建置、測試與發佈 Figloo，以及 repo 的目錄結構。給使用者的安裝與設定步驟在 [installation.zh-TW.md](installation.zh-TW.md)。

## 指令

```sh
pnpm build             # pnpm -r build
pnpm typecheck         # pnpm -r typecheck
pnpm test              # pnpm -r test，執行每個套件的 vitest
pnpm test:integration  # 真實的 Chromium、MCP 程序與 Figma 分頁，見下方說明
pnpm package           # 建置後把 release 檔案寫到 release/
pnpm test:release      # 以 release/ 中的檔案執行狀態整合測試
pnpm --filter @figloo/mcp docs:tools   # 修改工具後重新產生 docs/mcp-tools.md
claude plugin validate --strict plugins/figloo   # 檢查 plugin；對 . 執行則檢查 marketplace
claude plugin eval plugins/figloo --mocks off --ablation none   # skill 是否只在該觸發時觸發
claude plugin eval tests/skill-eval --ablation none   # 以假的工具回應檢查 skill 的工作流程是否依序呼叫工具
```

`pnpm package` 也會檢查擴充功能的 manifest 與三個 `package.json` 的版本是否相同、`plugins/figloo/.claude-plugin/plugin.json` 的版本與 bundle 網址是否和這個版本一致，以及 [CHANGELOG.md](../CHANGELOG.md) 有沒有這個版本的段落，所以升版時要一起改。Plugin 的評估要加 `--mocks off`，因為 `claude plugin eval` 無法替以 bundle 宣告的伺服器提供替身；評估案例沒有開放任何 Figloo 工具，所以不會動到 Figma。因此工作流程的評估改對 `tests/skill-eval/` 執行：這是不發佈的測試外殼，連結同一份 skill，並在 `.mcp.json` 中宣告伺服器，讓案例能以假回應檔取代 Figloo 的工具。它的工具清單 `tests/skill-eval/evals/mocks/figloo/_tools.json` 與 `docs/mcp-tools.md` 一樣由伺服器產生，也以同樣的方式檢查。

`docs/mcp-tools.md` 與伺服器註冊的工具不一致時，`pnpm test` 會失敗。

每次 push 到 `main` 與每個 pull request，GitHub Actions 都會執行 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)：建置、型別檢查、一次一個套件執行單元測試，以及打包。下方的整合測試需要瀏覽器與 Figma 連結，所以在本機執行，另外每天由 [`.github/workflows/figma-canary.yml`](../.github/workflows/figma-canary.yml) 對公開的測試檔執行一次，及早發現 Figma 網頁介面的改版。

發佈一個版本：

1. 更新 `apps/extension/static/manifest.json`、三個 `package.json` 與 `plugins/figloo/.claude-plugin/plugin.json`（版本與 bundle 網址）中的版本，並在 CHANGELOG.md 加上這個版本的段落。段落中第一個 `###` 標題之前的文字，會成為 release 說明的開頭。
2. 執行 `pnpm package` 與 `pnpm test:release`。
3. Commit，在這個 commit 打上 `vX.Y.Z` tag，兩者一起 push：`git push origin main vX.Y.Z`。[`.github/workflows/release.yml`](../.github/workflows/release.yml) 會測試並打包這個 commit、核對 tag 與版本、以它上傳的檔案計算 SHA-256 並寫進說明，然後發佈 release。Release 發佈之前，新安裝的 plugin 下載不到 bundle，所以 tag 要和 commit 一起 push。

從 Actions 頁面手動執行 Release workflow 是演練：只把檔案與說明保留成 artifact，不會發佈任何東西。

整合測試 `tests/integration/get-status.e2e.mjs` 會以建置好的擴充功能啟動 Playwright 的 Chromium，透過選項頁面配對，以訪客身分開啟 Figma 檔案，並在 MCP 程序重新啟動前後，以及第二個伺服器接手又結束時，檢查 `get_status`。它需要網路連線、已建置的 workspace、先下載瀏覽器，以及一個知道連結就能檢視、至少有兩頁的 Figma 設計檔。連結不進版控：把範例檔複製成 git 會忽略的 `tests/integration/.env.local` 並填入連結，或改設定 `FIGLOO_E2E_FIGMA_URL`：

```sh
pnpm exec playwright install chromium
cp tests/integration/.env.example tests/integration/.env.local
```

Google Chrome 正式版從 137 起會忽略 `--load-extension`，所以測試不使用本機安裝的 Chrome。第二個腳本 `tests/integration/explore.e2e.mjs` 會把圖層導覽程式注入可見的訪客 Figma 分頁，檢查展開、列舉、分段取回、越過同名圖層往上找，以及還原面板，所以檔案裡需要有兩個同名、且各自有子圖層的相鄰圖層。設定 `FIGLOO_E2E_HEADED=1` 可以看著它執行。

Figma canary workflow 每天執行這兩個腳本，也可以從 Actions 頁面手動執行。它從 repository secret `FIGLOO_CANARY_FIGMA_URL` 讀取連結，沒有設定時會失敗。它的 log 是公開的，而且會印出圖層名稱，所以必須使用專為測試建立的檔案，絕不能用真正的設計稿。

登入版 canary 檢查訪客碰不到的部分：選取、屬性面板、快照、匯出，以及還原畫面。它只在你的電腦上執行，不在 CI 執行，使用一個登入專用 Figma 測試帳號的瀏覽器 profile；這個帳號對測試檔只有檢視權限，並開啟「Adapt content for screen readers」。先用下方第一個指令登入一次：它會在視窗中開啟這個 profile，不替你輸入任何資料；profile 存在 `~/.figloo/canary-profile`（或 `FIGLOO_CANARY_PROFILE`）。接著在 `tests/integration/.env.local` 設定 `FIGLOO_CANARY_FIGMA_URL`，連結到要拍快照的 frame，這個 frame 裡要有一個帶匯出設定的圖層，然後執行 canary。輸出只有 ref、數量與錯誤碼。

```sh
node tests/canary/login.mjs
pnpm test:canary
```

快照的效能基準會列出 `snapshot_layer` 的時間花在哪裡：對一個 frame 拍好幾次快照，每次都重新讀取 Figma，再印出每個階段的中位數，例如截圖、走訪與逐層點選，只有層數與毫秒數。預設使用 canary 的 profile 與連結；加上 `--attach` 會改用你自己的瀏覽器與設定，這時要讓 Figma 分頁留在畫面上。

```sh
pnpm bench:snapshot --runs 3 --refs 0:2,0:78
pnpm bench:snapshot --attach
```

核心情境驗收需要已登入的瀏覽器，所以不包含在 `pnpm test` 中。在擴充功能已配對、Figma 分頁留在畫面上、沒有其他 Figloo 伺服器在執行，並且選取了卡片中的一個圖層時，它會把完整流程執行十次，檢查每次的結果都相同：

```sh
node tests/acceptance/core-scenario.mjs
```

`FIGLOO_ACCEPT_RUNS` 可以改變執行次數，`FIGLOO_ACCEPT_MCP_ENTRY=release/figloo-mcp-<version>.mjs` 則改用 release 檔案執行。

## 圖示

工具列圖示的圖稿在 `apps/extension/scripts/render-icons.mjs`。修改後，請重新產生已提交的 PNG：

```sh
pnpm --filter @figloo/extension icons
```

## 目錄結構

```text
apps/extension/      Chrome 擴充功能（Manifest V3）：@figloo/extension
apps/mcp/            透過 stdio 溝通的本機 MCP 伺服器與 WebSocket bridge：@figloo/mcp
packages/protocol/   共用的 zod schema、型別與常數：@figloo/protocol
docs/                安裝、疑難排解、工具契約與 agent 安裝步驟
docs/plans/          規劃文件
docs/compatibility/  在真實 Figma 頁面上驗證過的項目與已知限制
plugins/figloo/      Claude Code plugin：figloo-implement skill、它的評估案例，以及它下載的伺服器 bundle 的設定
.claude-plugin/      Marketplace 的 manifest，讓這個 repo 可以用 /plugin marketplace add 加入
scripts/             release 打包、release 檢查與 release 說明
.github/workflows/   CI、版本 tag 觸發的 release workflow，以及每天執行的 Figma canary
tests/fixtures/      回歸測試用的 Figma markup 擷取與匯出檔案
tests/integration/   對真實 Chromium 與 Figma 執行的端對端測試
tests/bench/         在本機執行的快照效能基準
tests/canary/        以專用測試帳號在本機執行的登入版 canary
tests/skill-eval/    不發佈的測試外殼，以假的 Figloo 工具執行 skill 的工作流程評估
tests/acceptance/    在已登入瀏覽器上執行的核心情境驗收
release/             pnpm package 的輸出（不提交）
```
