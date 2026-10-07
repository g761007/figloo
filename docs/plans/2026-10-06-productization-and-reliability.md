# Figloo 工具產品化與可靠性改善計畫（修訂版）

日期：2026-10-06
狀態：使用者已於 2026-10-07 回覆第 9 節的待決事項，待開始實作
目前版本：v0.4.1（2026-10-06 發佈）
依據：使用者提供的「Figloo 完整工具產品化改善計畫」（以 v0.4.0 為基準），對照 repo 現況與 v0.4.1 的修正後調整

## 1. 方向不變的部分

原計畫的大方向全部沿用：

- **退出 MVP 敘事。** 對外文件直接描述 Figloo 現在能做什麼，不再以「M0 到 M4 完成」說明成熟度。`0.x` 只代表 API 與工作流程還可能有 breaking change，不等於 MVP。
- **定位。** A local Figma bridge and design context layer for coding agents. 中文：Figloo 是 Coding Agent 的本機 Figma Bridge 與 Design Context Layer。
- **ROADMAP.md 是未來方向的 SSOT。** `docs/plans/` 只放單一功能或單一批次的實作計畫。Roadmap 以產品能力分類（Reliability、Compatibility、Developer Experience、Design Intelligence、Distribution、Agent Workflow、Performance），不再用 M0 到 M4 當主架構。
- **Live Exploration 與 Snapshot Exploration 兩種模式。** 快照建立後，大部分工作不再碰 Figma UI。
- **MCP Tool 數量暫停成長。** 只有代表新操作能力的才新增工具；既有資料的另一種篩選放進 `query_snapshot` 或既有參數。目前 15 個工具。
- **Skill 定義工作流程，MCP Tool 提供能力。** 使用者只需說「Implement this Figma screen」。
- **Token 與 Component Mapping。** 優先使用專案既有 token、元件與資產慣例，不把 Figma 原始值直接寫死。
- **暫不做：** 大量增加 MCP Tool、完整逆向 Figma object model、掃描整份大型檔案、支援所有語系、cloud backend、帳號系統、遠端快照儲存、團隊協作平台。
- **1.0 不因移除 MVP 而提前。** 1.0 條件見第 8 節。

## 2. v0.4.1 帶來的調整

### 發生了什麼

2026-10-03 到 10-06 之間，Figma 把匯出設定的格式控制項換成新的 select（`2026-10-06-export-format-select.md`）：

- `export_asset` 與 `export_assets` 每次失敗，每次失敗還在分頁留下一列 PNG 設定。
- `snapshot_layer` 讀到的 `exports` 一律是 `[]`，**沒有任何錯誤或警告**。這段期間拍的快照都要重拍。
- 問題由另一個工作階段回報才發現，不是自動化抓到的。

### 兩個教訓

1. **Canary 必須涵蓋選取圖層後才出現的 UI。** 這次壞的是屬性面板裡的匯出區塊，只有選取圖層後才渲染。訪客分頁無法選取圖層，所以只跑訪客模式的 canary 抓不到這次的問題。見第 4.1 節。
2. **比 selector 壞掉更危險的是安靜地回空值。** 原計畫的 capability degradation 處理「某個面板找不到」，但這次面板找得到、內容讀不懂，結果是看起來正常的空陣列。新增「解析守門」，見第 4.2 節。

### 版本號重新對應

依版本規則：大改版升 major，新增功能升 minor，修錯誤與小調整升 patch。原計畫把文件、重構、canary 與 capability degradation 都放在「v0.4.x」，對照規則後重新分配：

| 工作 | 原計畫 | 調整後 | 原因 |
|---|---|---|---|
| 文件整理、ROADMAP、SECURITY、guest canary | v0.4.x | 不發版 | 不改變發佈的程式；README 與文件推上 main 就生效 |
| 解析守門 | 無 | v0.4.3（原排 v0.4.2，見第 5 節） | 修正安靜失敗，屬於修錯誤 |
| 拆 `ops.ts`、`background.ts`、`protocol/index.ts` | v0.4.x | 等登入版 canary 之後；只剩重構則不單獨發版 | 行為不變 |
| Capability-based degradation | v0.4.x | v0.5.0 | `get_status` 多了能力與受影響工具的回報，屬於新增功能 |
| `figloo doctor`、recovery hint、升級提示 | v0.5.0 | v0.5.0 | 不變 |
| Design Intelligence、Performance、Compatibility Expansion | v0.6.0、v0.7.0、v0.8+ | 不變 | v0.4.1 是 patch，不推遲後面的 minor |

## 3. 原計畫與 repo 現況的校正

| 項目 | 原計畫的寫法 | repo 現況 | 調整 |
|---|---|---|---|
| 相容性矩陣 | 新增 `docs/compatibility/README.md` | 已存在，含瀏覽器、Figma 條件、各工具狀態與 12 項已知限制，最後更新 2026-10-06 | 不新增，補上缺的欄位 |
| 矩陣內容 | Chrome「Verified」、Edge「Expected / Verified」、Edit access「Supported」 | Chrome 正式版未驗證，只有 Chrome for Testing 的自動化；Edge 未驗證；編輯權限不在目標範圍、未驗證 | 以現有 README 為準，不照原計畫的表格 |
| 相容性文件分兩層 | 日期文件移到 `docs/compatibility/history/` | README 已經是「現在支援什麼」，日期文件已經是驗證紀錄，README 以連結列出 21 份 | 不搬移，避免連結失效 |
| `docs/mcp-tools.md` | 列為待建 | 已存在，由 `tool-docs.test.ts` 核對與程式一致 | 保留現狀 |
| Agent installer | 列為待改善 | `docs/agent-install.md` 已存在，README Quickstart 從 main 的 raw URL 讀它 | 改良即可；**不能改名或搬移**，否則 Quickstart 失效 |
| READY / DEGRADED / INCOMPATIBLE | 「應繼續強化」 | 已有；probe 回報 `layersPanel`、`focusTarget`、`propertiesPanel`、`mirrorDom`、`uiCollapsed`，`get_status` 與 Diagnostics 都會顯示 | 缺的是「能力 → 受影響工具」的對照；`mirrorDom` 缺少時仍是 `READY`，也沒有提示 |
| Product-level Diagnostics | 列為下一階段 | popup Diagnostics 已含版本、protocol、連線、UI 部件與最近錯誤碼，不含設計內容 | 只差錯誤次數的彙總與能力對照 |
| Canary | 從零建立 | `tests/integration/*.e2e.mjs` 已用 Chrome for Testing headless、真實 MCP 伺服器與真實 Figma 分頁跑訪客模式 | Canary 主要是排程與公開測試檔，見第 4.1 節 |
| Error recovery | 列為待建 | 工具錯誤已回傳 `{ code, message, hint }`，`exploration.ts`、`snapshot-tools.ts`、`export-asset.ts` 依錯誤碼給下一步，例如 `TAB_IN_BACKGROUND` 請使用者把分頁放到畫面上；`get_status` 也有 `hint` | 缺的只是機器可讀的 `retryable` 與錯誤分類，完全在 MCP 端，不動 extension 與 `PROTOCOL_VERSION` |
| 升級提示 | 列為待建 | hello 訊息已帶 `extensionVersion`；`PROTOCOL_MISMATCH` 訊息只寫 protocol 版本 | 補上兩邊的套件版本與該更新哪一邊，不需改協定 |
| Doctor 範例輸出 | `Protocol 0.4`、`✓ MCP client` | `PROTOCOL_VERSION` 是 0.3.0；CLI 無法得知是哪個 agent 在用 | 範例改正，CLI 不檢查 agent |
| Selector 位置 | 「盡量不要再散落」 | 依關注點分在 `probe.ts`、`adapter/export.ts`、`inspect.ts`、`dom-source.ts`、`row.ts`、`pages.ts`、`ops.ts` | 不全部搬進單一檔案，見第 4.4 節 |
| 大檔 | `ops.ts` 57 KB、`background.ts`、`protocol/index.ts` 44 KB | 分別是 1,118、747、1,019 行；MCP 端 `snapshot-tools.ts`、`exploration.ts`、`export-asset.ts`、`bridge.ts` 也在 23 到 27 KB | 本批只處理原計畫的三個，MCP 端列入觀察 |
| MVP 字樣 | 列出 README 兩份與兩份 docs | 再加上 `2026-09-30-figloo-mvp-plan.md` 本身，此外沒有遺漏 | 只改 README 兩份；MVP 計畫與引用它的歷史文件保留原樣，見第 4.10 節 |
| `2026-10-02-roadmap-batch-1.md` | 未提及 | 狀態行仍寫「實作中」，實際已完成並發佈 0.4.0 | 文件整理時一併更新 |

## 4. 需要修改的判斷

### 4.1 Canary 分兩層

| | Guest canary | 登入版 canary |
|---|---|---|
| 在哪跑 | GitHub Actions 排程，每天一次 | 使用者的 Mac，本機排程 |
| 帳號 | 不登入 | 專用的 Figma 測試帳號，登入狀態留在本機的瀏覽器 profile |
| 測試檔 | 新建一個不含產品內容的公開檔 | 同一個公開檔，或專用帳號自己的檔案 |
| 檢查 | 圖層面板、頁面列表、圖層列、子樹、整頁截圖、probe 的各項能力 | 加上選取、屬性面板、匯出區塊與格式選單、screen reader mirror、`snapshot_layer` 的匯出設定 |
| 抓得到 v0.4.1 的問題 | 否 | 是 |

規則：

- 不使用私人測試檔，也不把它的連結放進 workflow 或 secret。
- 不在 GitHub Actions 存放 Figma 的登入 cookie 或密碼。
- Repo 已經公開，workflow 的 log 任何人都看得到。既有的整合測試會印出測試檔的圖層名稱，所以 canary 只能用不含任何產品內容的專用檔；登入版 canary 的輸出則只留計數、能力與錯誤碼。
- Guest canary 直接沿用 `tests/integration/` 的腳本，連結放在 repository secret `FIGLOO_CANARY_FIGMA_URL`。`explore.e2e.mjs` 需要檔案裡有兩個同名、且各自有子圖層的相鄰圖層。

未驗證，實作前需確認：

- Figma 的服務條款對自動化存取的規定。
- GitHub runner 的 IP 開啟 Figma 時，是否遇到登入牆、驗證或流量限制。遇到驗證就停在 guest canary 的範圍，不嘗試繞過。
- 公開 repo 的排程 workflow 在 60 天沒有活動後會被 GitHub 停用；需確認目前規則與失敗通知會寄給誰。

### 4.2 新增：解析守門

讀取 Figma UI 時分三種結果，第三種不可以變成空值：

1. 區塊不存在，例如圖層沒有匯出設定：回傳空值，正常。
2. 區塊存在，內容讀得懂：回傳內容。
3. **區塊存在，但內容讀不懂**：回報錯誤或警告，寫明哪個區塊，Diagnostics 記下錯誤碼。

先套用在匯出區塊與屬性面板各段落。`snapshot_layer` 遇到第 3 種時，快照標記警告，不把讀不懂的欄位存成 `[]`。單元測試以「區塊在、列的結構不認得」的 fixture 驗證。

### 4.3 Capability-based degradation 移到 v0.5.0 並具體化

- `get_status` 的每個分頁回報能力，以及每項能力缺少時受影響的工具，例如缺 `mirrorDom` 時 `get_visual_neighbors` 不可用、`capture` 與 `snapshot_layer` 不還原畫面。
- 缺 `mirrorDom` 時分頁仍是 `READY`，但 `hint` 說明受影響的功能與開啟方式。
- 能力只在需要選取時才出現的部分，例如匯出區塊，由第 4.2 節的解析守門在使用時回報，不在 probe 檢查。

### 4.4 UI contract 改為「清單」而不是「搬家」

原計畫建議把 selector 集中到 `figma-ui-contract.ts`。調整為：

- 只把判斷 UI 是否可用的錨點 selector 列成清單，例如 `objects-panel`、`properties-panel`、`export-inspection-panel`、mirror、圖層列，每項標上可靠度：Stable（`data-testid`）、Semantic（role、aria）、Structural（父子關係）、Fragile（文字、class、位置）。
- probe、canary 與 Diagnostics 都讀這份清單，Diagnostics 顯示哪些錨點找不到。
- 解析細節，例如匯出列的格式按鈕，留在各自的模組，和解析程式放在一起。全部搬進一個檔案會把 selector 和依賴它的解析拆開，改版時反而要改兩個地方。
- 依英文 aria label 的 selector 標為 Fragile，這也是 v0.8+ 支援其他語系時要先處理的清單。

### 4.5 重構的順序與範圍

- **先有 canary，再重構。** Guest canary 與本機的 `tests/acceptance/core-scenario.mjs` 是重構前後的真實 Figma 對照。
- **`adapter/ops.ts` 先做。** 最大、變動最頻繁。`Explorer` 留下 context、index、操作生命週期、還原與分派；selection、navigation、neighbors、inspection、capture、export、snapshot 各自成為模組。
- **`background.ts` 拆成 3 到 4 個模組，不是 8 個。** 747 行拆成 8 個檔案，多數只有一個呼叫點，違反「單一呼叫點不抽象」。建議：連線與配對、分頁登記與 probe、操作路由與佇列、capture 與 export 的交付。
- **`protocol/index.ts` 最後做，可延後。** 內容是 zod schema，拆分風險低、效益也低；以 `export *` 維持既有 import。
- 每拆一個檔案就跑 `pnpm build && pnpm typecheck && pnpm test` 與 guest canary，行為不變，各自一個 commit。

### 4.6 `figloo doctor` 拆成兩半

- **`figloo-mcp doctor` CLI**：只檢查 extension 連上之前的事：Node.js 版本、`~/.figloo/config.json` 是否存在與權限、token、port 是否被占用，以及占用的是哪個版本的 Figloo。不啟動會搶 47129 port 的 bridge，以免干擾正在服務的工作階段。
- **Extension 與 Figma 的檢查**：由 `get_status` 回傳逐項結果，例如已連線、protocol 相容、設計分頁、已登入、英文 UI、圖層面板、屬性面板、mirror。Skill 與 agent 依此顯示和引導，使用者不需要開終端機。
- 常見問題的修正步驟（mirror 的開啟路徑、版本不符時更新哪一邊）寫在檢查結果裡，和 README 的 Troubleshooting 一致。

### 4.7 Error taxonomy 與 recovery hint

- 錯誤碼依類別整理：Connection、Compatibility、Context、User Action、Figma UI、Export、Snapshot、Filesystem。
- 既有的 `hint` 已經寫出給 agent 的下一步，保留；另外依錯誤碼加上 `retryable`，例如 `TAB_IN_BACKGROUND` 可重試、`USER_INTERRUPTED` 要先問使用者。
- 三份 hint 對照表合併成一份，順便補齊沒有 hint 的錯誤碼。
- 只改 MCP 端與 `docs/mcp-tools.md`，不動 extension，`PROTOCOL_VERSION` 不變。

### 4.8 SECURITY.md 的兩處補充

原計畫的內容（本機架構、只聽 127.0.0.1、token 加 pinned extension ID 加 Origin 驗證、本機檔案位置、`<all_urls>` 的用途）都與程式一致。另外補上：

- **資料流向說清楚。** Figloo 沒有自己的伺服器，不上傳設計內容；但 agent 讀到的設計內容會送到使用者所用的模型服務，這由 agent 決定，不由 Figloo 控制。
- **漏洞回報管道。** GitHub 會在 Security 頁籤顯示 SECURITY.md，慣例上要寫怎麼私下回報漏洞。若採用 GitHub 的 private vulnerability reporting，需要使用者在 repo 設定中開啟。

### 4.9 Incremental snapshot 的可行性風險

原計畫的「lightweight tree fingerprint → 只重讀變更的子樹」有一個前提風險：圖層面板只看得到名稱、類型、隱藏與結構。只改顏色、文字樣式或間距時，圖層面板沒有變化，不逐層選取就看不出來，而逐層選取正是快照最花時間的部分。

所以 v0.7.0 的研究先回答：有沒有不必逐層選取就能得知屬性變更的訊號。沒有的話，增量快照只能涵蓋結構變更，目標數字（修改 3 層、第二次 3 到 5 秒）不成立，需要重新設定。

### 4.10 其他小調整

- **MVP 計畫保留原樣（使用者決定）。** `docs/plans/2026-09-30-figloo-mvp-plan.md` 不改名、不搬移、不改內容。引用它的歷史文件，也就是 `2026-10-01-m4-acceptance.md` 與 `2026-10-01-visual-neighbors-and-multi-select.md`，一併保留：它們以那份計畫的實際名稱引用它，只改說法反而和檔名不一致。退出 MVP 敘事只針對對外的產品文件：README 兩份、ROADMAP.md、SECURITY.md 與之後拆出的文件。
- **README 拆分，中英各一份（使用者決定）。** 第一屏回答是什麼、為什麼、和 Figma REST API 與 Figma MCP 的差別、三分鐘開始。Install、Set up、Troubleshooting 移到 `docs/installation.md`、`docs/installation.zh-TW.md`、`docs/troubleshooting.md`、`docs/troubleshooting.zh-TW.md`，命名比照 `README.zh-TW.md`，每份開頭互相連結。README 保留 `Install`、`Set up`、`Troubleshooting` 這幾個標題，各放一段摘要與連結，讓既有的錨點不失效：`docs/agent-install.md` 連到 `#troubleshooting`，已發佈的 release 說明連到 README。兩份 README 內部的錨點連結與 `scripts/release-notes.mjs` 的說明同步更新。
- **ROADMAP.md 與 SECURITY.md 用英文**，和 README、`docs/mcp-tools.md` 一致；計畫與相容性紀錄維持中文。
- **Workflow eval。** 需確認 `claude plugin eval` 的 grader 能否檢查工具呼叫的順序，以及沒有 Figma 時如何提供假的 Figloo MCP 伺服器。確認前不排進版本。
- **Performance 基準。** `snapshot_layer` 已有實測（278 層約 35 秒），先把現有數字記進 ROADMAP，不設 CI 門檻。本機效能紀錄只記層數與各階段時間，不含圖層名稱。

## 5. 調整後的版本規劃

### 不發版：產品定位與 guest canary（v0.4.1 之後立即）

**文件**

- 移除 README 兩份的 MVP 字樣，改寫 Status。MVP 計畫與引用它的歷史文件保留原樣。
- README 依第 4.10 節重整第一屏，Install、Set up、Troubleshooting 拆成中英各一份的文件，內容先原樣搬移。
- `2026-10-02-roadmap-batch-1.md` 狀態改為已完成。
- 新增 `ROADMAP.md`（英文，依能力分類，連結既有計畫）。
- 新增 `SECURITY.md`（英文，含第 4.8 節的兩處補充）。

**Canary**

- 新增 `.github/workflows/figma-canary.yml`，每天跑 guest 模式的整合測試。
- 公開測試檔：做到這一步時通知使用者建立，拿到連結前先完成 workflow 與文件。

驗證：`git grep -i mvp` 只剩 `docs/plans/` 與 `docs/compatibility/` 的歷史文件；README 兩份與拆出的四份文件中，所有相對連結與錨點都能開，`#install`、`#set-up`、`#troubleshooting` 仍然存在；`docs/agent-install.md` 的路徑不變；canary 手動觸發一次跑通；commit 前檢查沒有私人測試檔的名稱與連結。

### v0.4.2 — canary 抓到的分組標題（patch，2026-10-07 改排）

canary 第一次跑通就發現：frame 裡有捲動時固定的圖層時，Figma 會在子層之間插入「Fixed」與「Scrolls」分組標題列，Figloo 讀到第一個標題就停下，`get_neighbors` 回傳 0 個子層卻只標 `hasMore`，整合測試的斷言對空結果也成立。依下方的發版條件，這個修正提前成為 v0.4.2，原本的內容順延到 v0.4.3。細節見 [分組標題的驗證紀錄](../compatibility/2026-10-07-section-header-rows.md)。

- 讀取圖層面板時認得分組標題，走訪時跳過；總列數與捲動目標改依實際位置推算，因為標題列比圖層列矮。
- 兩支整合測試改為讀取中途停下或讀到 0 層就失敗。
- Arc 實測時另外發現：在編輯權限下，快照的屬性與匯出設定全部安靜地存成空值，每層都等到逾時。這屬於解析守門的範圍，列入 v0.4.3。

### v0.4.3 — 解析守門（patch）

- 解析守門（第 4.2 節）：編輯權限、讀不懂的匯出設定列與屬性區段，都明確回報，不再存成空值。2026-10-07 完成，細節見 [解析守門的驗證紀錄](../compatibility/2026-10-07-parse-guard.md)。

驗證：以改過的 fixture 單元測試，並在 Arc 上確認編輯權限會直接回報、檢視權限下正常檔案沒有誤報。

### v0.4.3 之後：登入版 canary 與重構（不單獨發版）

2026-10-07 調整順序：要拆的 `ops.ts` 正是選取圖層後的檢查、匯出與快照，訪客 canary 測不到，核心情境驗收也不含快照。所以先做登入版 canary，再重構。

- 登入版 canary 的本機腳本（第 4.1 節），不進發佈檔。2026-10-07 完成並可手動執行，細節見 [登入版 canary 的紀錄](../compatibility/2026-10-07-signed-in-canary.md)。使用者決定不排程，需要時手動執行。
- 拆 `adapter/ops.ts`、`background.ts`，`protocol/index.ts` 視時間（第 4.5 節）。2026-10-07 完成前兩項：
  - `ops.ts` 1,138 行拆成 `operation.ts`（錯誤、預算與共用工具）、`explorer-core.ts`（context、index、執行生命週期與還原）、`navigation-ops.ts`、`inspect-ops.ts`、`capture-ops.ts`、`export-ops.ts`、`snapshot-ops.ts`，面板尺寸的讀取移到 `inspect.ts`；`ops.ts` 只留下轉呼叫的 `Explorer`。
  - `background.ts` 747 行拆成 `background/connection.ts`、`tabs.ts`、`operations.ts`、`delivery.ts`，`background.ts` 只留下事件監聽、診斷與 popup。
  - 兩者都由腳本依行號原樣搬移，逐行比對後只有函式簽名、`this` 改為 `core` 與 import 不同。
  - `protocol/index.ts` 暫不拆：schema 彼此引用，拆開容易形成循環，效益低。

驗證：重構前後全部測試、guest canary、登入版 canary 與 `core-scenario.mjs` 結果相同。

發版條件（2026-10-07 由 Claude 依使用者授權決定）：

- 重構隨時可以 commit 進 main，但只有重構時不發版。發版會讓使用者更新 extension 並重開工作階段，沒有使用者看得到的改變就不值得。
- 解析守門完成時發 v0.4.3，已完成的重構一起帶上；沒完成的不擋發版。
- Canary 若先抓到 Figma 改版或 Figloo 的缺陷而需要修正，修正立刻以下一個 patch 發佈，不等其他工作。v0.4.2 就是這樣產生的。

### v0.5.0 — 可靠性與安裝體驗（minor）

- Capability map 與 `mirrorDom` 提示（第 4.3 節）。
- UI contract 清單與可靠度分級，Diagnostics 顯示找不到的錨點（第 4.4 節）。
- Error taxonomy 與 recovery hint（第 4.7 節）。
- `figloo-mcp doctor` 與 `get_status` 的逐項檢查（第 4.6 節）。
- `PROTOCOL_MISMATCH` 寫出兩邊的套件版本與該更新哪一邊。
- 改良 `docs/agent-install.md`、troubleshooting 改版、相容性 README 補欄位。

成功條件：把 README 的 Quickstart 貼給全新的 agent 工作階段，真的完成安裝並做完一次 Design-to-Code，過程中使用者不需要理解 Figloo 的架構。這一項目前還沒做過真實驗證。

### v0.6.0 — Design Intelligence（minor）

內容與原計畫相同：改良快照摘要、語意分組、token 與 component mapping 提示、專案慣例偵測、`figloo-implement` 的工作流程。Workflow eval 在第 4.10 節的確認完成後加入。

### v0.7.0 — Performance（minor）

先建立快照的效能基準，再做增量快照研究，並以第 4.9 節的問題作為是否繼續的關卡。其他項目：減少 UI 操作、快取、大型畫面。

### v0.8+ — Compatibility Expansion 與 Distribution

- 其他 UI 語系：從第 4.4 節標為 Fragile 的英文 aria label 開始。
- 更多 Chromium 瀏覽器、Figma UI 世代偵測。
- Chrome Web Store：上架會改變 extension ID，`EXTENSION_ID` 寫死在 protocol 與 bridge 的允許清單中，需要遷移計畫；`<all_urls>` 是否符合上架政策需確認。不合適就維持 GitHub 發佈，但讓更新流程更簡單。
- Release channel（stable、preview）等成熟後再考慮。

## 6. 優先順序

| 優先 | 項目 | 版本 |
|---|---|---|
| P0 | README 移除 MVP 定位與重整（拆出的文件中英各一份）、ROADMAP.md、SECURITY.md、guest canary | 不發版 |
| P1 | 分組標題的修正（canary 發現） | v0.4.2 |
| P1 | 解析守門 | v0.4.3 |
| P1 | 登入版 canary，再拆 `ops.ts` 與 `background.ts`、`protocol/index.ts`（可延後） | 不單獨發版 |
| P2 | Capability map、UI contract 清單、recovery hint、doctor、升級提示、Quickstart 實測 | v0.5.0 |
| P3 | `figloo-implement` 強化、token 與 component mapping、語意摘要、workflow eval | v0.6.0 |
| P4 | 效能基準、增量快照研究、減少 UI 操作 | v0.7.0 |

## 7. 產品原則

沿用原計畫的八條，加上第九條：

1. User Intent First：使用者目前的選取就是主要 context。
2. Snapshot First for Large Work：完整頁面實作先建立快照。
3. Bounded Live Exploration：不無限制掃描 Figma。
4. Local by Default：不需要 Figloo cloud。
5. Read-only by Design：不修改設計稿。
6. Compatibility is a Product Feature：Figma UI 相容性是核心產品品質。
7. Skills Define Workflow：MCP Tool 提供能力，Skill 定義流程。
8. Reuse Project Conventions：優先使用專案既有的 token、元件與資產慣例。
9. **Fail Loudly：讀不懂就明說，不回傳看起來正常的空值。**（來自 v0.4.1）

## 8. 1.0 條件

沿用原計畫：核心工作流程穩定、real Figma canary、graceful degradation、清楚的相容性報告、穩定的快照格式、容易安裝、doctor、清楚的更新與錯誤復原、SECURITY.md、CI 與自動發版、整合與驗收測試、相容性紀錄、穩定的 skill 與工具契約。

另外加上：

- 登入版 canary 涵蓋選取後才出現的 UI，並連續數週保持綠燈。
- 所有讀取區塊都有解析守門。
- README Quickstart 在全新環境實測通過。

## 9. 使用者的決定，2026-10-07

1. **Canary 的公開測試檔：** 用到時通知使用者協助建立。2026-10-07 使用者提供自己帳號下的公開範例檔，連結只放在 repository secret；檔案需要再加一頁，才符合 `get-status.e2e.mjs` 至少兩頁的條件。
2. **登入版 canary 的專用測試帳號：** 用到時通知使用者協助。
3. **MVP 計畫：** 不改，保留原樣。
4. **README 拆出的文件：** 中英各一份。
5. **v0.4.2 的發版條件：** 交由 Claude 決定，結果寫在第 5 節。2026-10-07 canary 發現分組標題的問題後，原本的穩定化內容順延為 v0.4.3，條件跟著移過去。
