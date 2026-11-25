# 操作期間鎖定 Figma 畫面

日期：2026-11-25  
狀態：實作中  
依據：使用者的需求：任何 MCP 呼叫 extension 操作 Figma 時，畫面都要鎖定，避免使用者不小心移動而打斷操作。延伸自[讀取時的遮罩與暫停](2026-10-02-reading-overlay.md)。

## 情境

目前只有 `snapshot_layer` 的讀取階段與 `survey_frames` 顯示遮罩。其他會操作 Figma 的工具都沒有鎖定：

| MCP 工具 | 對 Figma 的操作 | 使用者中途操作的後果 |
|---|---|---|
| `get_anchor`、`get_neighbors` | 捲動、展開圖層面板 | `USER_INTERRUPTED`，agent 需重試 |
| `explore_page` | 可能切換頁面，再捲動圖層面板 | 同上 |
| `inspect_nodes`、`get_visual_neighbors` | 逐一選取圖層，最後還原選取 | 同上 |
| `capture` | 選取、Shift+2 縮放、Esc、截圖、還原選取與視角 | 選取與視角不還原 |
| `export_asset`、`export_assets` | 選取、可能加暫時匯出設定、按 Export、等檔案、移除設定、還原選取 | 暫時匯出設定不移除，選取不還原 |
| `survey_thumbnails` | 連續縮放到多個 frame 截圖，數分鐘 | 停在中途，視角不還原 |

`snapshot_layer` 的截圖階段、讀取前點 Properties 分頁、讀完後還原視角也不在遮罩內。此外，遮罩只在「Stop」按鈕有焦點時擋得住按鍵；Figloo 送按鍵時會把焦點移給 Figma，最多 250 ms 後才搶回。

## 目標與非目標

目標：

- 每個會操作 Figma 的工具，從開始到還原完成都鎖定畫面；多步驟的工具（截圖、匯出、快照、縮圖）步驟之間也鎖定。
- 短操作不閃遮罩：先以透明圖層擋下輸入，0.5 秒後或使用者碰到時才顯示卡片。
- 截圖時遮罩不可見，但仍擋下輸入。
- 「Stop」與 Esc 對所有工具有效，中止後還原 Figloo 改動的東西。
- 鎖定中的真實按鍵不論焦點在哪都不會傳到 Figma。

非目標：

- 不操作 Figma 的工具：`list_pages`、`get_status`，以及只在 MCP 端處理資料的工具。
- 阻止切換分頁或視窗；沿用現有的暫停與 `TAB_IN_BACKGROUND`。

這份企劃推翻 2026-10-02 企劃的一個非目標：當時認為短操作的遮罩「一閃而過反而干擾」。改用延遲顯示卡片解決閃爍。

## 設計

### 一個分頁一把鎖

- `ReadingOverlay` 改為整個分頁共用的鎖，由 `ExplorerCore` 持有，以計數控制：`hold()` 取得、回傳的函式釋放；全部釋放才移除遮罩，並重設「Stop」狀態與進度。
- 兩層持有：
  - Content script 中每個操作的入口持有鎖（`list_pages` 除外）。
  - Service worker 在多步驟工具的整個流程持有鎖，蓋住步驟之間的空檔：`capture` 從準備到收尾；`export_asset` 從準備到收尾，之後等瀏覽器下載不鎖；`snapshot_layer` 涵蓋截圖與讀取；`survey_thumbnails` 涵蓋整個迴圈與還原視角。
- Service worker 的持有帶租約，到期自動釋放，避免 service worker 中斷時畫面鎖住。Content script 停用時（重新載入擴充功能、重新注入）強制釋放。
- 新的分頁內部訊息 `lock`、`unlock`、`lock_progress` 只在 service worker 與 content script 之間，不動 bridge protocol，`PROTOCOL_VERSION` 不變。

### 顯示

- 取得鎖時先加入透明圖層，擋下點擊、滾輪與觸控；0.5 秒後才顯示半透明背景與卡片。使用者在那之前碰到圖層或按鍵，卡片立刻出現。
- 卡片沿用標題與說明。沒有進度的操作顯示 "Working, this takes a few seconds"；縮圖顯示已截幾張 frame；快照與總覽沿用現有進度。
- 卡片出現時焦點才移到「Stop」，透明階段不搶焦點。

### 截圖

- 截圖準備好時，遮罩改為 `opacity: 0`，等兩個 animation frame 讓畫面重繪再交給 service worker 截圖；收尾時恢復。透明的遮罩仍會擋下輸入。

### 按鍵

- 在 window 的 capture 階段攔下真實按鍵（`isTrusted`），焦點在 Figma 時也一樣；只有 Esc 等於「Stop」。Figloo 自己派發的合成按鍵不受影響。
- 監聽在 content script 建立 `Explorer` 時就註冊，比每次操作的使用者偵測先執行，所以被攔下的按鍵不算使用者介入。

### 「Stop」與 Esc

- 正在進行的步驟：照現有方式中止，完整還原，回報 `USER_INTERRUPTED`。
- 之後的步驟：一開始就回報 `USER_INTERRUPTED`，不碰 Figma；收尾步驟（`finish_capture`、`finish_export`、`put_view_back`）照常還原。
- `capture` 準備途中停止：還原選取與視角。
- `export_asset` 等檔案時停止：立刻結束等待，移除暫時匯出設定，還原選取；沒有收到檔案就回報 `USER_INTERRUPTED`。
- `survey_thumbnails` 因停止而結束：仍還原視角；只有使用者真的操作 Figma 才不還原。
- `snapshot_layer` 在截圖與讀取之間停止：還原視角。

## 階段與驗證

| 階段 | 內容 | 驗證 |
|---|---|---|
| 1 | 鎖定元件：計數、透明階段與延遲卡片、`conceal`／`reveal`、租約、window 層級按鍵攔截、新的進度文字 | 單元測試：延遲顯示、碰到即顯示、隱形仍攔截、租約到期、真實按鍵被攔而合成按鍵通過、Esc 停止、全部釋放後重設 |
| 2 | Content script 接線：`ExplorerCore` 持有鎖、`core.run` 改用它、快照與總覽共用、操作入口持有與 Stop 檢查、截圖隱形、匯出等待可停止、延後還原也持有、停用時釋放 | `dom-fixture` 測試：Stop 完整還原、Stop 後下一步不碰 Figma、鎖上的點擊不算介入、匯出等待時 Stop 移除暫時設定 |
| 3 | Service worker 跨步驟鎖定、縮圖進度、縮圖停止後還原視角、`ExportFinishSchema` 的 `stopped` | 以替身 `chrome` 測試四種流程的鎖定與解鎖順序、失敗也解鎖、縮圖停止後送出 `put_view_back` |
| 4 | Arc 實測（需要使用者的真實輸入） | 短操作不閃卡片；鎖定中點擊、滾輪、Shift+1、方向鍵無效；截圖中沒有遮罩；各工具中途 Stop 完整還原；操作中重新載入擴充功能遮罩消失。另跑 `pnpm test:integration`，並詢問是否跑 signed-in canary。紀錄寫在 `docs/compatibility/2026-11-25-operation-lock.md` |
| 5 | 工具說明、`USER_INTERRUPTED` 提示、troubleshooting、SKILL.md、README、CHANGELOG | `docs:tools` 重新產生；grep 確認舊說法已改 |

階段 1 到 3 完成後回報；階段 4 通過後經使用者同意 commit 程式與紀錄；階段 5 另一個 commit。發版另外詢問。

## 風險

| 風險 | 緩解 |
|---|---|
| Figma 在 window capture 階段更早註冊的按鍵監聽仍先收到按鍵 | 階段 4 驗證；不行就用 `document_start` 的小 content script 搶先註冊 |
| 隱形後尚未重繪就截圖 | 等兩個 animation frame；階段 4 檢查截圖 |
| 縮圖每次截圖時卡片短暫消失；`export_assets` 或連續 `inspect_nodes` 之間卡片時有時無 | 階段 4 評估；太干擾就讓截圖類操作把卡片放在左側面板上、不加暗色背景，因為截圖只裁畫布 |
| 畫面鎖住出不來 | 計數、租約、content script 停用時強制釋放 |
| 行為改變：以前在 Figma 點一下即可中止並保留新選取，之後只能用 Stop 或 Esc | 工具說明與文件寫清楚 |
