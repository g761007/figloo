# M1 連線閉環驗證紀錄

狀態：自動化驗證通過；使用者瀏覽器（Arc）的手動安裝待確認  
日期：2026-09-30

## 實作摘要

- MCP 程序以 stdio 服務 agent，同一程序在 `ws://127.0.0.1:47129` 監聽 extension，port 可用 `FIGLOO_PORT` 或設定檔覆寫。port 被占用時不會當掉，`get_status` 的 `bridge.error` 會說明。
- 配對：第一次執行時在 `~/.figloo/config.json` 產生 token（mode 0600）。`figloo-mcp pair` 印出 token 與 port，使用者貼進 extension 的 options 頁一次即可。
- 握手：extension 送 `hello`（協定版本、token、extension 版本、UA），伺服器檢查 `Origin` 是否為固定的 extension ID、協定版本是否相容、token 是否相符，通過才回 `welcome`。失敗回 `error` 並以 4001（版本）或 4003（未授權）關閉。
- 心跳：extension 每 20 秒送 `ping`，伺服器 45 秒沒收到任何訊息就斷線。WebSocket 流量同時延長 MV3 service worker 的存活時間。
- 重連：連線中斷後依 1、2、5、10、30 秒退避重試；被拒絕（token 或版本錯誤）改為每 60 秒重試；另有每分鐘一次的 `chrome.alarms` 在 service worker 被喚醒時補連。
- 分頁狀態：service worker 追蹤 `https://www.figma.com/design/*` 與 `/file/*` 分頁，透過 content script 做小型讀取探測後推送 `tabs`；`get_status` 會先要求一次 `refresh_tabs`（3 秒逾時，逾時則回上次推送並標 `tabsFresh: false`）。

## 自動化驗證（`pnpm test:integration`）

環境：Playwright Chromium 153.0.8010.12（headless，改用一般 Chrome UA）、真實 `figloo-mcp` 程序、真實 Figma 分享連結（訪客）。

| 步驟 | 結果 |
|---|---|
| MCP 啟動、extension 未連線 | `DISCONNECTED`，`hint` 指向配對步驟 |
| 以固定 key 載入未打包 extension | ID 為 `offikfnknfkgijgianpfcghbccmkcjnb`，與 protocol 常數一致 |
| 在 options 頁貼上 token 與 port 並儲存 | options 頁顯示 connected，`get_status` 回 `NO_DESIGN_TAB` |
| 開啟 Figma 分享連結 | 分頁被辨識，`access: guest`，`uiCollapsed: true`，readiness `DEGRADED` 並說明 UI 已最小化 |
| 以使用者操作展開 UI | `layersPanel: true`，讀到 34 列圖層，仍為 `DEGRADED`（訪客無法選取） |
| 關閉並重新啟動 MCP | extension 自動重連，狀態恢復 |
| 關閉 Figma 分頁 | `NO_DESIGN_TAB` |
| 關閉並重新啟動瀏覽器（同一 profile） | 以既有配對自動重連，不需操作 UI |

## 新發現

- 訪客開啟分享連結時 Figma 預設為 Minimize UI 模式，左側面板完全不在 DOM，`[data-testid="objects-panel"]` 不存在。畫面上只有 `button[aria-label^="Expand UI"]`，對它派發合成點擊就會掛載面板並變成 `Minimize UI`。M2 的 adapter 可在需要時自動展開，屬於計畫允許的檢視變更。
- 導向非 Figma 頁面（例如 CDN 回傳的錯誤頁）時，分頁被正確判為 `INCOMPATIBLE`。
- Google Chrome 137 之後的正式版不再接受 `--load-extension`，自動化測試因此改用 Playwright 的 Chromium；使用者以 chrome://extensions 手動載入不受影響。
- Figma 的 CDN 會拒絕 `HeadlessChrome` UA，headless 測試需指定一般 UA。
- `access` 只用正向標記：`[data-testid="google-btn"]` 代表訪客，View only／Ask to edit／Request sent 按鈕代表檢視權限；兩者都沒有時回 `unknown`，不猜 `edit`。訪客橫幅比編輯器晚出現，同一分頁的第一次探測可能是 `unknown`，之後才變 `guest`。

## 工具列圖示

- 逐分頁設定：設計稿可讀時為彩色，受限時彩色加琥珀色 `!`，載入中或非設計稿為灰階，無法辨識的 Figma 頁面為灰階加紅色 `!`。滑鼠提示寫出檔名、限制原因與 agent 連線狀態。
- 狀態來源：service worker 每次探測分頁後套用；content script 每秒在頁面內計算一次 readiness，只有變化時才通知 service worker，所以展開或最小化 UI 這類沒有分頁事件的變化也會即時反映。
- Chromium 153 實測：`chrome.action` 的逐分頁圖示、標題與徽章在 `history.replaceState`、hash 變化與整頁重新整理後都保留，只有關閉分頁才清除。因此分頁離開設計稿時由 extension 主動還原；service worker 重啟後不在記憶體中的分頁，以 Chrome 回傳的逐分頁標題判斷是否需要還原。
- 整合測試涵蓋：非 Figma 分頁維持預設、訪客分頁顯示受限、展開 UI 後只靠 content script 通知更新、重新整理後自動恢復、MCP 停止與重啟時 agent 狀態更新、離開設計稿後還原、殘留圖示的未追蹤分頁被還原，並確認 Chrome 能載入兩組圖示檔。

## 未驗證

1. Arc 的配對與分頁回報已驗證（兩個分頁皆 `READY`、權限 `view`）；工具列圖示在 Arc 的實際顯示尚未驗證，需重新載入 extension 後目視確認。Google Chrome 手動安裝未測。
2. Service worker 閒置被 Chrome 終止後，由 alarm 喚醒重連的路徑；設計上存在，測試中未觸發。
3. 多個 Figma 分頁同時開啟時的列舉（E2E 只開一個）。
4. 登入編輯模式的 `access` 判定與面板能力。
