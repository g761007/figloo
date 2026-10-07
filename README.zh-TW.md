# Figloo

[English](README.md) | 繁體中文

Figloo 是 coding agent 的本機 Figma bridge 與 design context layer。它讓 agent 從你的選取出發，探索瀏覽器中開著的設計稿：瀏覽附近的圖層、讀取與 Figma 屬性面板顯示完全相同的版面與視覺屬性、截圖、匯出 icon 與圖片，並把整個畫面存成快照，作為實作的依據。它由 Chrome 擴充功能與本機 MCP 伺服器組成，只讀取 Figma 網頁介面呈現的內容，不使用 Figma REST API、官方 Figma MCP、Figma plugin 或私有的內部狀態。它可能會改變檢視範圍與選取，但絕不編輯設計稿。

> 本文件譯自英文版 [README.md](README.md)，兩者不一致時以英文版為準。

## 為什麼用 Figloo

- **有檢視權限就夠了。** Figma 的 REST API 與官方 MCP 伺服器依席位設定額度：View 或 Collab 席位每月最多 6 次呼叫（見 [REST API](https://developers.figma.com/docs/rest-api/rate-limits) 與 [MCP 伺服器](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/) 的說明，以 2026 年 10 月為準）。Figloo 讀取你已經開著的 Figma 分頁，不需要 token 或付費席位，也沒有每月額度。
- **從你指的地方開始。** Agent 從你選取的圖層出發，每次呼叫只讀取檔案中有上限的一部分，不掃描整份檔案。
- **讀一次，依快照實作。** `snapshot_layer` 讀取整個畫面，最多 2,000 個圖層，並存成快照。之後 agent 查詢數值、摘要畫面用到的顏色、文字樣式與間距、和上一份快照比對，都不必再操作 Figma。
- **在本機執行。** 沒有 Figloo 伺服器或帳號，bridge 只監聽 `127.0.0.1`。見[隱私與安全](#隱私與安全)。

如果團隊有 Dev 或 Full 席位，Figma 官方的 MCP 伺服器直接讀取檔案，是更直接的做法。Figloo 適合只有檢視權限、想讓 coding agent 依眼前設計稿工作的工程師。

## 運作方式

```text
Coding agent ──stdio (MCP)──▶ Figloo MCP 伺服器 ──ws://127.0.0.1:47129──▶ Figloo 擴充功能 ──DOM──▶ Figma 分頁
```

Agent 透過 MCP 呼叫 Figloo 的工具。由 agent 啟動的伺服器，經本機的 WebSocket 把每次呼叫交給擴充功能。擴充功能的 content script 讀取 Figma 分頁的圖層面板與屬性面板，像你一樣選取與展開圖層，結束後還原你的選取。快照由伺服器存在 `~/.figloo/snapshots/`。

## 狀態

Figloo 涵蓋 Design-to-Code 的探索流程：列出檔案的頁面、從使用者的選取出發、每次在有上限的範圍內逐層瀏覽圖層、讀取屬性面板、截圖、逐一或批次匯出資產，以及為整個畫面建立、查詢、摘要與比對快照。目標使用者是對檔案有檢視權限的工程師。

Figloo 以真實的 Figma 頁面持續開發與測試。版本仍是 0.x，工具與回傳結果在 minor 版本之間可能改變：各版本的變更見 [CHANGELOG.md](CHANGELOG.md)，接下來的方向見 [ROADMAP.md](ROADMAP.md)。

- [docs/mcp-tools.md](docs/mcp-tools.md)：每個工具的參數、回傳結果與錯誤碼。
- [docs/compatibility/](docs/compatibility/README.md)：支援的瀏覽器與 Figma 設定、已知限制，以及在真實 Figma 頁面上驗證過的項目。

## 快速開始

把這句話貼給你的 coding agent，Claude Code 或 Codex 都可以：

```text
Install Figloo for me by following https://raw.githubusercontent.com/g761007/figloo/main/docs/agent-install.md
```

Agent 會檢查 Node.js、下載最新版本並核對檢查碼、註冊 MCP 伺服器（Claude Code 會安裝 plugin），再給你配對 token。接著它會引導你完成三件只能由你做的事：

1. 載入擴充功能：在 `chrome://extensions`（或 `arc://extensions`）開啟開發人員模式，按「載入未封裝項目」，選擇 agent 告訴你的資料夾。
2. 在擴充功能的選項頁面貼上 token 與連接埠。
3. 在 Figma 中使用英文介面，並開啟「Adapt content for screen readers」。

最後開一個新的 agent 工作階段，打開 Figma 設計檔，請 agent 呼叫 `get_status`。[docs/installation.zh-TW.md](docs/installation.zh-TW.md) 是同樣步驟的手動版本。

## 需求

- Node.js 24，用來執行 MCP 伺服器（見 `.node-version`）
- pnpm 10，用來從原始碼建置（見 `package.json` 的 `packageManager`）
- 能載入未封裝擴充功能的 Chromium 系瀏覽器：Arc 已驗證，Chrome 116 以上預期可用
- 對檔案至少有檢視權限的 Figma 帳號，並使用 Figma 的英文介面

## 安裝

[快速開始](#快速開始)會請 agent 安裝最新版本。要手動安裝，無論使用 release 檔案或從原始碼，見 [docs/installation.zh-TW.md](docs/installation.zh-TW.md#安裝)。

## 設定

設定分四個步驟：載入擴充功能、在 agent 中註冊 MCP 伺服器（Claude Code 的 plugin 會一併安裝 [figloo-implement skill](#figloo-implement-skill)）、配對一次，以及準備 Figma。[docs/installation.zh-TW.md](docs/installation.zh-TW.md#設定) 逐步說明，也解釋擴充功能要求的權限。

## 工具列圖示

圖示會顯示 Figloo 能否使用你目前正在看的分頁。把游標移到圖示上，可以看到原因，以及 Figloo 正在服務哪個 coding agent 工作階段。

| 圖示 | 意思 |
|---|---|
| 靛藍色 | Figloo 可以讀取的 Figma 設計稿。 |
| 靛藍色加上琥珀色 `!` | Figloo 可以讀取但有限制的設計稿，例如訪客模式或介面縮到最小。 |
| 灰色 | 不是 Figma 設計稿，或檔案仍在載入中。 |
| 灰色加上紅色 `!` | Figloo 無法讀取的 Figma 設計稿頁面。 |

點擊圖示會開啟 popup 視窗。它會顯示檔案、頁面、Figloo 是否就緒，以及正在服務的 coding agent 工作階段。在 Figma 中選取一個圖層時，它還會顯示這個圖層從頁面開始的路徑，以及它的直接子層。讀取子層時，圖層面板中的這個圖層可能會短暫展開，Figloo 會再把它收合。

「Copy prompt for the agent」會複製一段文字，讓你在描述任務之前貼到 coding agent 中。這段文字寫出檔案、分頁與選取的圖層，並告訴 agent 先使用哪些 Figloo 工具。選取的圖層是畫布上或 section 中的 frame，例如一個畫面時，提示會說明你要實作這一頁，並請 agent 先為它建立快照。沒有選取時，這段提示會請 agent 自行探索檔案。複製之前，popup 視窗會先顯示提示內容。

Popup 視窗底部的「Diagnostics」會顯示一段簡短的報告，可以貼到 [bug report](https://github.com/g761007/figloo/issues/new?template=bug_report.yml) 中：擴充功能、protocol 與伺服器的版本、瀏覽器、連線狀態、分頁的就緒狀態與 Figloo 找到的 Figma 介面元素，以及最近幾次錯誤的錯誤碼。報告中沒有檔案、頁面或圖層的名稱，也沒有連結；複製之前，popup 視窗會先顯示內容。

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
| `export_asset` | 以 Figma 的 Export 按鈕的方式匯出圖層，格式可以是 SVG、PNG、JPG 或 PDF，讓 agent 依專案需要選擇格式與倍率，例如網頁用 SVG，iOS 用 PDF 或 1x、2x、3x 的 PNG。SVG 以文字回傳，長邊最多 1568 px 的 PNG 或 JPG 以圖片回傳。加上 `saveTo` 時，也會把檔案寫到專案目錄中的該路徑；專案目錄是 Claude Code 設定的 `CLAUDE_PROJECT_DIR`，沒有時則是伺服器的工作目錄。既有檔案只在加上 `overwrite: true` 時取代。Figma 的檔名是圖層名稱，不含倍率後綴，所以每種倍率請存成不同的檔名。沒有 `format` 時，圖層有自己的匯出設定就沿用，沒有設定的圖層則匯出成 SVG。有 `format` 時，會加上一組該格式與 `scale`（預設 1x）的臨時設定，匯出後再移除；圖層已有完全相同的設定時則直接沿用。圖層本身的設定絕不會被改動。Figma 把多個檔案打包成的 ZIP 會自動解開。隱藏圖層或位在隱藏群組中的圖層會立刻回報 `LAYER_HIDDEN`，因為 Figma 不匯出它們。 |
| `export_assets` | 以 `export_asset` 的方式依序匯出多個圖層，存進專案中的同一個資料夾：可以指定 ref，或匯出快照中所有有匯出設定的圖層，也可以只匯出其中一個圖層裡面的部分。檔名沿用 Figma 的命名，名稱重複時加上圖層的 ref。每次呼叫最多 50 個圖層，約 150 秒後不再開始新的匯出，其餘的放在 `remaining` 回傳。Figma 分頁進入背景或使用者介入時會提早停下；其他失敗會列出來，其餘圖層照常匯出。 |
| `snapshot_layer` | 讀取一個圖層與其中的所有圖層，最多 2,000 個，300 個圖層約 40 秒。每次呼叫最多讀三分鐘；還有圖層沒讀時，會回傳 `complete: false` 與進度，用同一個 root 再呼叫一次，就會從停下的地方接著讀。內容包括截圖，以及每個圖層相對這個圖層的位置與大小、是否隱藏、匯出設定，與 `inspect_nodes` 讀得到的全部內容。Instance 視為一個圖層。回傳截圖與每個圖層一行的大綱，並把快照存在 `~/.figloo/snapshots/`。24 小時內再次呼叫會直接回傳存好的快照，不再讀取 Figma，時間可用設定檔的 `snapshotTtlHours` 調整；加上 `refresh: true` 則重新讀取。讀取期間 Figma 上會顯示有進度與「Stop」按鈕的遮罩，其他視窗可以照常使用。按「Stop」或 Esc 會中止讀取並收回圖層面板；在 Figma 其他地方點一下也會中止。分頁進入背景時，讀取會暫停，回到畫面後繼續。頁面重新整理後，可以用新的 context 再次傳入已存快照的 root，快照中的每個 ref 在這個 context 都能使用。 這個 root 先前建立過快照時，結果會列出之後新增、變更與刪除的圖層數量，寫出被刪除的圖層，並在大綱中標記其他變動；過期的快照會保留 30 天供這項比對。 |
| `query_snapshot` | 不需要 Figma 分頁，就能在存好的快照中查詢圖層，頁面重新整理後也可以。可以依 ref 取得完整內容，或依文字、類型、所在的圖層，以及是否在上一份快照之後新增或變更來篩選，結果以大綱或完整內容分頁回傳。 |
| `summarize_snapshot` | 不需要 Figma 分頁，就能摘要存好的快照或其中一個區塊：每個顏色與它的用途、文字樣式、間距、padding、圓角、線寬與陰影，各自有多少圖層使用，以及依名稱分組的 instance 與它們的元件屬性。用來把設計對應到專案的 token 與元件。 |
| `map_tokens` | 不需要 Figma 分頁，就能把存好的快照中的顏色、文字樣式、間距與圓角，對照專案中已定義的 token：完全相同的、相近的（附上差在哪裡），以及沒有對到的。它讀取 CSS 與 SCSS 變數、design token JSON、Tailwind 等主題物件、iOS 的 asset catalog 與 Swift、Android 的資源與 Compose，以及 Flutter，並列出名稱與 instance 字詞相同的專案元件。 |
| `release_context` | 捨棄一個 context 與其中的圖層 ref。 |

完整的契約，包括每個參數、回傳欄位與錯誤碼，見 [docs/mcp-tools.md](docs/mcp-tools.md)。

典型的流程是：先呼叫 `get_status`，接著用 `list_pages` 與 `explore_page`，使用者有選取時改用 `get_anchor`。然後用 `capture` 看頁面或 frame，用 `get_neighbors` 找出重要的部分，用 `inspect_nodes` 取得精確數值，再用 `export_asset` 取得 icon 與圖片。每次呼叫都有上限，並回報用了多少次 UI 操作。要實作整個頁面時，改為對頁面的 frame 呼叫 `snapshot_layer`，用 `summarize_snapshot` 看它用了哪些數值與元件，再用 `query_snapshot` 查詢細節。

開著多個 Figma 分頁時，從分頁開始的工具要指定分頁的 `tabId`。從 popup 視窗複製的提示會寫出分頁；沒有提示時，`get_status` 會請 agent 向使用者確認要用哪個檔案。

Figma 只在分頁可見時套用選取、展開、縮放與切換頁面。讀取頁面、選取與已展開的圖層，在背景分頁也能運作；`get_visual_neighbors`、`inspect_nodes`、`capture`、`export_asset`、切換頁面與展開收合的圖層，則會回報 `TAB_IN_BACKGROUND`，直到 Figma 分頁回到畫面上。`snapshot_layer` 開始時需要分頁在畫面上，之後分頁進入背景時會暫停。把 Figma 放在 agent 視窗旁邊就夠了。這些工具會依序選取圖層，`capture` 與 `snapshot_layer` 還會縮放畫面；之後會還原使用者的選取，包括同時選取的多個圖層。開啟「Adapt content for screen readers」時，縮放比例與畫面位置也會還原（`viewRestored`）。

## figloo-implement skill

[`plugins/figloo/skills/figloo-implement/`](plugins/figloo/skills/figloo-implement/SKILL.md) 引導 agent 用 Figloo 實作 Figma 的頁面或元件：確認連線、確認要實作的範圍、建立快照、把設計稿對應到專案既有的 token 與元件、依區塊讀取細節、實作、與截圖比對，最後回報。它也涵蓋查看設計稿與匯出圖檔。貼上 popup 複製的提示，或要求依照開著的設計稿實作或切圖時，agent 會自動使用它。

Claude Code plugin 已經包含這個 skill。不使用 plugin 時，複製或連結這個資料夾：

| Agent | 資料夾放在 | 以名稱呼叫 |
|---|---|---|
| Claude Code | `~/.claude/skills/figloo-implement` | `/figloo-implement` |
| Codex | `~/.agents/skills/figloo-implement` | `$figloo-implement` |

Codex 另外需要在 `~/.codex/config.toml` 註冊 MCP 伺服器，見[在 agent 中註冊 MCP 伺服器](docs/installation.zh-TW.md#2-在-agent-中註冊-mcp-伺服器)。

## 疑難排解

先從 `get_status` 開始：請 agent 呼叫它，它的 `hint` 會說明要修正什麼，每個分頁也會列出它的限制與處理方式。不在 agent 工作階段中時，`figloo-mcp doctor` 會檢查 Node.js、設定檔，以及連接埠由誰持有。其他可以查看的地方，以及從 `DISCONNECTED` 到 `BUSY` 的常見問題，見 [docs/troubleshooting.zh-TW.md](docs/troubleshooting.zh-TW.md)。

## 隱私與安全

Figloo 在你的電腦上執行。MCP 伺服器只監聽 `127.0.0.1`，而且只接受 Figloo 擴充功能的連線，以固定的擴充功能 ID 與配對 token 識別。Figloo 沒有自己的伺服器或帳號，設計內容只交給呼叫工具的 agent；agent 如何處理這些內容，例如送到它使用的模型服務，由 agent 決定。快照存在 `~/.figloo/snapshots/`。細節與回報漏洞的方式見 [SECURITY.md](SECURITY.md)（英文）。

## Roadmap

[ROADMAP.md](ROADMAP.md)（英文）依領域列出接下來的方向：可靠性、開發者體驗、設計理解、效能、相容性與發佈。

## 開發

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

`pnpm package` 也會檢查擴充功能的 manifest 與三個 `package.json` 的版本是否相同、`plugins/figloo/.claude-plugin/plugin.json` 的版本與 bundle 網址是否和這個版本一致，以及 [CHANGELOG.md](CHANGELOG.md) 有沒有這個版本的段落，所以升版時要一起改。Plugin 的評估要加 `--mocks off`，因為 `claude plugin eval` 無法替以 bundle 宣告的伺服器提供替身；評估案例沒有開放任何 Figloo 工具，所以不會動到 Figma。因此工作流程的評估改對 `tests/skill-eval/` 執行：這是不發佈的測試外殼，連結同一份 skill，並在 `.mcp.json` 中宣告伺服器，讓案例能以假回應檔取代 Figloo 的工具。它的工具清單 `tests/skill-eval/evals/mocks/figloo/_tools.json` 與 `docs/mcp-tools.md` 一樣由伺服器產生，也以同樣的方式檢查。

`docs/mcp-tools.md` 與伺服器註冊的工具不一致時，`pnpm test` 會失敗。

每次 push 到 `main` 與每個 pull request，GitHub Actions 都會執行 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：建置、型別檢查、一次一個套件執行單元測試，以及打包。下方的整合測試需要瀏覽器與 Figma 連結，所以在本機執行，另外每天由 [`.github/workflows/figma-canary.yml`](.github/workflows/figma-canary.yml) 對公開的測試檔執行一次，及早發現 Figma 網頁介面的改版。

發佈一個版本：

1. 更新 `apps/extension/static/manifest.json`、三個 `package.json` 與 `plugins/figloo/.claude-plugin/plugin.json`（版本與 bundle 網址）中的版本，並在 CHANGELOG.md 加上這個版本的段落。段落中第一個 `###` 標題之前的文字，會成為 release 說明的開頭。
2. 執行 `pnpm package` 與 `pnpm test:release`。
3. Commit，在這個 commit 打上 `vX.Y.Z` tag，兩者一起 push：`git push origin main vX.Y.Z`。[`.github/workflows/release.yml`](.github/workflows/release.yml) 會測試並打包這個 commit、核對 tag 與版本、以它上傳的檔案計算 SHA-256 並寫進說明，然後發佈 release。Release 發佈之前，新安裝的 plugin 下載不到 bundle，所以 tag 要和 commit 一起 push。

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
docs/                安裝、疑難排解、工具契約與 agent 安裝步驟
docs/plans/          規劃文件
docs/compatibility/  在真實 Figma 頁面上驗證過的項目與已知限制
plugins/figloo/      Claude Code plugin：figloo-implement skill、它的評估案例，以及它下載的伺服器 bundle 的設定
.claude-plugin/      Marketplace 的 manifest，讓這個 repo 可以用 /plugin marketplace add 加入
scripts/             release 打包、release 檢查與 release 說明
.github/workflows/   CI、版本 tag 觸發的 release workflow，以及每天執行的 Figma canary
tests/fixtures/      回歸測試用的 Figma markup 擷取與匯出檔案
tests/integration/   對真實 Chromium 與 Figma 執行的端對端測試
tests/canary/        以專用測試帳號在本機執行的登入版 canary
tests/skill-eval/    不發佈的測試外殼，以假的 Figloo 工具執行 skill 的工作流程評估
tests/acceptance/    在已登入瀏覽器上執行的核心情境驗收
release/             pnpm package 的輸出（不提交）
```

## 授權

Figloo 以 [MIT 授權](LICENSE)釋出。
