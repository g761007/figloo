# Figloo

[English](README.md) | 繁體中文

Figloo 由 Chrome 擴充功能與本機 MCP 伺服器組成，讓 coding agent 偵測已開啟的 Figma 設計稿分頁，以使用者目前的選取為錨點，透過 Figma 網頁介面探索附近的圖層與屬性，不必掃描整份文件。它只讀取 DOM 與網頁介面呈現的內容，不使用 Figma REST API、官方 Figma MCP、Figma plugin 或私有的內部狀態。它可能會改變檢視範圍與選取，但絕不編輯設計稿。

> 本文件譯自英文版 [README.md](README.md)，兩者不一致時以英文版為準。

## 狀態

MVP 已完成，也就是[計畫](docs/plans/2026-09-30-figloo-mvp-plan.md)中的 M0 到 M4 里程碑。Agent 可以列出 Figma 檔案的頁面、開啟頁面或從使用者的選取出發、每次在有上限的範圍內逐層瀏覽圖層、讀取 Figma 屬性面板顯示的內容、截圖，以及匯出 icon 與圖片。Figloo 的目標使用者是對檔案有檢視權限的工程師；它絕不編輯設計稿。

- [docs/mcp-tools.md](docs/mcp-tools.md)：每個工具的參數、回傳結果與錯誤碼。
- [docs/compatibility/](docs/compatibility/README.md)：支援的瀏覽器與 Figma 設定、已知限制，以及在真實 Figma 頁面上驗證過的項目。

## 需求

- Node.js 24，用來執行 MCP 伺服器（見 `.node-version`）
- pnpm 10，用來從原始碼建置（見 `package.json` 的 `packageManager`）
- 能載入未封裝擴充功能的 Chromium 系瀏覽器：Arc 已驗證，Chrome 116 以上預期可用
- 對檔案至少有檢視權限的 Figma 帳號，並使用 Figma 的英文介面

## 安裝

### 使用 release 檔案

`pnpm package` 會在 `release/` 產生兩個可以交給其他人的檔案：

| 檔案 | 用法 |
|---|---|
| `figloo-extension-<version>.zip` | 解壓縮到一個會保留的資料夾，瀏覽器會從那裡載入擴充功能。 |
| `figloo-mcp-<version>.mjs` | 放在任何位置都可以。它就是完整的 MCP 伺服器，只需要 Node.js 24。 |

接著依照[設定](#設定)的步驟進行，把原始碼中的路徑換成解壓縮後的資料夾與 `.mjs` 檔案。

### 從原始碼

```sh
pnpm install
pnpm build
```

`pnpm build` 會依相依順序建置 workspace 中的套件。請在 `typecheck` 與 `test` 之前執行，因為另外兩個套件會使用 `@figloo/protocol` 的建置結果。pnpm 可能會提示略過了 esbuild 的建置腳本，建置並不需要它。

## 設定

### 1. 載入擴充功能

1. 開啟 `chrome://extensions`（或 `arc://extensions`），打開「開發人員模式」，再按「載入未封裝項目」（Load unpacked）。
2. 選擇 `apps/extension/dist`，或 release 檔案解壓縮後的資料夾。

擴充功能的 ID 由 `apps/extension/static/manifest.json` 的 `key` 欄位固定，所以在每台電腦上都相同（`offikfnknfkgijgianpfcghbccmkcjnb`）。本機伺服器只接受這個 ID 的連線。

擴充功能會要求存取所有網站（`<all_urls>`），因為 Chrome 只允許具備這項權限的擴充功能，在使用者沒有點擊圖示的情況下截取分頁畫面。它的 content script 仍然只在 Figma 設計稿中執行。

`export_asset` 會在頁面內接收 Figma 匯出的檔案：每次匯出期間，擴充功能會包住 Figma 用來開始下載的函式，取得檔案後再放回原本的函式，所以瀏覽器不會存下任何檔案。`downloads` 權限只用於備援：無法在頁面內取得檔案時，擴充功能會等候瀏覽器自己下載這次的匯出，並回報存檔位置。

更新 Figloo 後，請執行 `pnpm build`，再按擴充功能卡片上的重新載入按鈕，讓瀏覽器載入新檔案與新的權限。

### 2. 在 agent 中註冊 MCP 伺服器

使用 Claude Code 時，註冊一次就能用在所有專案，之後請開一個新的工作階段：

```sh
claude mcp add -s user figloo -- node /absolute/path/to/figloo/apps/mcp/dist/index.js
```

使用 release 檔案時，改用它的路徑，例如 `node /absolute/path/to/figloo-mcp-0.0.1.mjs`。在工作階段中，`/mcp` 會顯示伺服器是否已連線。

其他 MCP client 可以用類似下面的設定啟動伺服器（請替換路徑）：

```json
{
  "mcpServers": {
    "figloo": {
      "command": "node",
      "args": ["/absolute/path/to/figloo/apps/mcp/dist/index.js"]
    }
  }
}
```

伺服器透過 stdio 使用 MCP，並在同一個程序中監聽 `ws://127.0.0.1:47129`，等候擴充功能連線。要改用其他連接埠，請設定 `FIGLOO_PORT`，或修改設定檔中的 `port`。連接埠已被占用時，`get_status` 會回報錯誤，伺服器不會因此當掉。

### 3. 配對一次

```sh
node apps/mcp/dist/index.js pair
```

使用 release 檔案時，執行 `node figloo-mcp-<version>.mjs pair`。

這會印出存在 `~/.figloo/config.json` 中的配對 token 與連接埠。這個檔案在第一次執行時建立，權限為 0600，也可以用 `FIGLOO_CONFIG_DIR` 指定其他目錄。開啟擴充功能的選項頁面，貼上這兩個值，再按「Save and connect」。之後只要 MCP 伺服器在執行，擴充功能就會自動連線，任一方重新啟動後也會重新連線。

### 4. 準備 Figma

- 在裝了擴充功能的瀏覽器中登入 Figma。對檔案有檢視權限就夠了。
- 使用 Figma 的英文介面，並保持介面展開：Cmd+\ 可以切換，縮到最小的介面會隱藏圖層面板。
- 在 Main menu、Preferences、Accessibility settings 中打開「Adapt content for screen readers」。這樣截圖就能依圖層在畫面上的位置裁切，`get_visual_neighbors` 也能得知圖層的位置。
- Agent 工作期間，請讓 Figma 分頁留在畫面上，放在 agent 視窗旁邊就可以。Figma 在背景分頁中會忽略選取與展開，所以 Figloo 會回報 `TAB_IN_BACKGROUND`，不會自行猜測。

## 工具列圖示

圖示會顯示 Figloo 能否使用你目前正在看的分頁。把游標移到圖示上，可以看到原因，以及是否有 coding agent 連線。

| 圖示 | 意思 |
|---|---|
| 彩色 | Figloo 可以讀取的 Figma 設計稿。 |
| 彩色加上琥珀色 `!` | Figloo 可以讀取但有限制的設計稿，例如訪客模式或介面縮到最小。 |
| 灰色 | 不是 Figma 設計稿，或檔案仍在載入中。 |
| 灰色加上紅色 `!` | Figloo 無法讀取的 Figma 設計稿頁面。 |

點擊圖示會開啟 popup 視窗。它會顯示檔案、頁面，以及 Figloo 與 coding agent 是否就緒。在 Figma 中選取一個圖層時，它還會顯示這個圖層從頁面開始的路徑，以及它的直接子層。讀取子層時，圖層面板中的這個圖層可能會短暫展開，Figloo 會再把它收合。

「Copy prompt for the agent」會複製一段文字，讓你在描述任務之前貼到 coding agent 中。這段文字寫出檔案、分頁與選取的圖層，並告訴 agent 先使用哪些 Figloo 工具。沒有選取時，這段提示會請 agent 自行探索檔案。複製之前，popup 視窗會先顯示提示內容。

圖示的圖稿在 `apps/extension/scripts/render-icons.mjs`。修改後，請重新產生已提交的 PNG：

```sh
pnpm --filter @figloo/extension icons
```

## 工具

| 工具 | 說明 |
|---|---|
| `get_status` | 回報 bridge 的狀態、擴充功能是否已連線，以及每個已開啟的 Figma 設計稿分頁。每個分頁都包含就緒狀態（`LOADING`、`READY`、`DEGRADED`、`INCOMPATIBLE`）、存取權限（`edit`、`view`、`guest`、`unknown`）、介面語言、分頁是否可見，以及 content script 找到了哪些介面區塊。有需要注意的地方時，會附上 `hint`。 |
| `list_pages` | 列出分頁中 Figma 檔案的頁面，以及目前顯示的是哪一頁。 |
| `explore_page` | 開啟頁面（必要時切換），列出直接位於頁面上的圖層，並附上 `contextId`。 |
| `get_anchor` | 回傳使用者在分頁中選取的圖層，依圖層面板順序最多 20 個，並附上 `contextId`。 |
| `get_neighbors` | 列出同一個 context 中回傳過的圖層的 `parent`、`ancestors`、`siblings` 或 `children`。每次最多回傳 50 個圖層，預設 20 個；更多內容請依 `nextCursor` 續查。`children` 也接受 `depth`（最多 3 層），以廣度優先列出子樹。 |
| `get_visual_neighbors` | 依畫面位置列出圖層的同層圖層：在它右側、左側、下方或上方，或依距離由近到遠，並附上以設計稿像素表示的距離與位移。Frame、群組、形狀與 instance 從畫面上量測，文字圖層則取自屬性面板。需要開啟「Adapt content for screen readers」。 |
| `inspect_nodes` | 讀取最多 5 個圖層的 Figma 屬性面板：尺寸與尺寸模式、位置、auto layout 方向、padding、gap、圓角、填色、邊框、陰影、文字內容、每段樣式的字型設定，以及元件屬性。數值與 Figma 顯示的完全相同。 |
| `capture` | 截取縮放到剛好容納的圖層，或整個頁面。回傳長邊最多 1568 px 的 JPEG。 |
| `export_asset` | 以 Figma 的 Export 按鈕的方式匯出圖層，格式可以是 SVG、PNG、JPG 或 PDF，讓 agent 依專案需要選擇格式與倍率，例如網頁用 SVG，iOS 用 PDF 或 1x、2x、3x 的 PNG。SVG 以文字回傳，長邊最多 1568 px 的 PNG 或 JPG 以圖片回傳。加上 `saveTo` 時，也會把檔案寫到專案目錄中的該路徑；專案目錄是 Claude Code 設定的 `CLAUDE_PROJECT_DIR`，沒有時則是伺服器的工作目錄。既有檔案只在加上 `overwrite: true` 時取代。Figma 的檔名是圖層名稱，不含倍率後綴，所以每種倍率請存成不同的檔名。沒有 `format` 時，圖層有自己的匯出設定就沿用，沒有設定的圖層則匯出成 SVG。有 `format` 時，會加上一組該格式與 `scale`（預設 1x）的臨時設定，匯出後再移除；圖層已有完全相同的設定時則直接沿用。圖層本身的設定絕不會被改動。Figma 把多個檔案打包成的 ZIP 會自動解開。 |
| `release_context` | 捨棄一個 context 與其中的圖層 ref。 |

完整的契約，包括每個參數、回傳欄位與錯誤碼，見 [docs/mcp-tools.md](docs/mcp-tools.md)。

典型的流程是：先呼叫 `get_status`，接著用 `list_pages` 與 `explore_page`，使用者有選取時改用 `get_anchor`。然後用 `capture` 看頁面或 frame，用 `get_neighbors` 找出重要的部分，用 `inspect_nodes` 取得精確數值，再用 `export_asset` 取得 icon 與圖片。每次呼叫都有上限，並回報用了多少次 UI 操作。

Figma 只在分頁可見時套用選取、展開、縮放與切換頁面。讀取頁面、選取與已展開的圖層，在背景分頁也能運作；`get_visual_neighbors`、`inspect_nodes`、`capture`、`export_asset`、切換頁面與展開收合的圖層，則會回報 `TAB_IN_BACKGROUND`，直到 Figma 分頁回到畫面上。把 Figma 放在 agent 視窗旁邊就夠了。這些工具會依序選取圖層，`capture` 還會縮放畫面；之後會還原使用者的選取，包括同時選取的多個圖層，但不會還原縮放。

## 開發

```sh
pnpm build             # pnpm -r build
pnpm typecheck         # pnpm -r typecheck
pnpm test              # pnpm -r test，執行每個套件的 vitest
pnpm test:integration  # 真實的 Chromium、MCP 程序與 Figma 分頁，見下方說明
pnpm package           # 建置後把 release 檔案寫到 release/
pnpm test:release      # 以 release/ 中的檔案執行狀態整合測試
pnpm --filter @figloo/mcp docs:tools   # 修改工具後重新產生 docs/mcp-tools.md
```

`docs/mcp-tools.md` 與伺服器註冊的工具不一致時，`pnpm test` 會失敗。

整合測試 `tests/integration/get-status.e2e.mjs` 會以建置好的擴充功能啟動 Playwright 的 Chromium，透過選項頁面配對，以訪客身分開啟 Figma 檔案，並在 MCP 程序重新啟動前後檢查 `get_status`。它需要網路連線、已建置的 workspace、先下載瀏覽器，以及一個知道連結就能檢視的 Figma 設計檔。連結不進版控：把範例檔複製成 git 會忽略的 `tests/integration/.env.local` 並填入連結，或改設定 `FIGLOO_E2E_FIGMA_URL`：

```sh
pnpm exec playwright install chromium
cp tests/integration/.env.example tests/integration/.env.local
```

Google Chrome 正式版從 137 起會忽略 `--load-extension`，所以測試不使用本機安裝的 Chrome。第二個腳本 `tests/integration/explore.e2e.mjs` 會把圖層導覽程式注入可見的訪客 Figma 分頁，檢查展開、列舉、分段取回、越過同名圖層往上找，以及還原面板，所以檔案裡需要有兩個同名、且各自有子圖層的相鄰圖層。設定 `FIGLOO_E2E_HEADED=1` 可以看著它執行。

核心情境驗收需要已登入的瀏覽器，所以不包含在 `pnpm test` 中。在擴充功能已配對、Figma 分頁留在畫面上、沒有其他 Figloo 伺服器在執行，並且選取了卡片中的一個圖層時，它會把完整流程執行十次，檢查每次的結果都相同：

```sh
node tests/acceptance/core-scenario.mjs
```

`FIGLOO_ACCEPT_RUNS` 可以改變執行次數，`FIGLOO_ACCEPT_MCP_ENTRY=release/figloo-mcp-<version>.mjs` 則改用 release 檔案執行。

## 目錄結構

```text
apps/extension/      Chrome 擴充功能（Manifest V3）：@figloo/extension
apps/mcp/            透過 stdio 溝通的本機 MCP 伺服器與 WebSocket bridge：@figloo/mcp
packages/protocol/   共用的 zod schema、型別與常數：@figloo/protocol
docs/plans/          規劃文件
docs/compatibility/  在真實 Figma 頁面上驗證過的項目與已知限制
scripts/             release 打包與 release 檢查
tests/fixtures/      回歸測試用的 Figma markup 擷取與匯出檔案
tests/integration/   對真實 Chromium 與 Figma 執行的端對端測試
tests/acceptance/    在已登入瀏覽器上執行的核心情境驗收
release/             pnpm package 的輸出（不提交）
```

## 疑難排解

先從這些地方查看：

- **`get_status`**：請 agent 呼叫它。它會回報 bridge、擴充功能的連線，以及每個 Figma 分頁的就緒狀態與原因，並附上說明下一步的 `hint`。
- **工具列圖示與 popup 視窗**：提示文字與 popup 視窗會顯示目前分頁的就緒狀態與 agent 連線，兩者內容相同。
- **選項頁面**：顯示連線狀態與最後一次的連線錯誤。
- **Service worker 主控台**：在 `chrome://extensions`（或 `arc://extensions`）的 Figloo 卡片上點「service worker」。
- **伺服器日誌**：伺服器每次被呼叫時，會在 stderr 寫一行，包含數量、UI 操作次數與耗時，但不含圖層名稱。要查看時，請在沒有 agent 工作階段執行伺服器的情況下，在終端機手動執行，例如 `node apps/mcp/dist/index.js`。

常見問題：

- `get_status` 顯示 `DISCONNECTED`：確認擴充功能已載入並完成配對，再查看選項頁面。它會顯示最後一次的連線錯誤，例如 token 被拒絕或連接埠無法連線。
- 選項頁面顯示 `unpaired`：token 欄位是空的。請再執行一次 `pair` 指令，貼上印出的值。
- 分頁顯示 `DEGRADED`，並提到「guest session」：這個瀏覽器設定檔沒有登入 Figma，所以無法選取圖層。
- 分頁顯示 `DEGRADED`，並提到「Figma UI is minimized」：介面隱藏時不會渲染圖層面板。請按 Cmd+\，或點檔名旁的展開按鈕。
- 剛安裝擴充功能後，分頁一直是 `LOADING` 或變成 `INCOMPATIBLE`：請重新載入 Figma 分頁，讓 content script 注入頁面。
- `export_asset` 回報 `EXPORT_BLOCKED`：Figma 沒有交出任何檔案，瀏覽器也沒有開始下載。如果瀏覽器擋下了 figma.com 的連續下載，請在網站設定中允許，再試一次。
- `export_asset` 回報 `EXPORT_PENDING`：瀏覽器正在等待儲存備援的下載，通常是停在另存新檔的對話框。請確認儲存，或關閉「每次下載前詢問儲存位置」。
- `get_status` 回報連接埠 47129 已被占用：另一個 agent 工作階段已經在執行 Figloo，而同一時間只能有一個伺服器服務擴充功能。請關閉另一個工作階段，再重新啟動 agent。
