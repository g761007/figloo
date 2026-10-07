# 疑難排解

[English](troubleshooting.md) | 繁體中文

> 本文件譯自英文版 [troubleshooting.md](troubleshooting.md)，兩者不一致時以英文版為準。

先從這些地方查看：

- **`get_status`**：請 agent 呼叫它。它會回報 bridge、擴充功能的連線，以及每個 Figma 分頁的就緒狀態與原因，並附上說明下一步的 `hint`。
- **工具列圖示與 popup 視窗**：提示文字與 popup 視窗會顯示目前分頁的就緒狀態與 agent 連線，兩者內容相同。Popup 視窗中的「Diagnostics」提供可以貼到 bug report 的報告，不含檔案、頁面或圖層的名稱。
- **選項頁面**：顯示連線狀態、Figloo 正在服務的 agent 工作階段、最近一次在工作階段之間交接的時間，以及最後一次的連線錯誤。
- **Service worker 主控台**：在 `chrome://extensions`（或 `arc://extensions`）的 Figloo 卡片上點「service worker」。
- **伺服器日誌**：伺服器每次被呼叫時，會在 stderr 寫一行，包含數量、UI 操作次數與耗時，但不含圖層名稱。要查看時，請在沒有 agent 工作階段執行伺服器的情況下，在終端機手動執行，例如 `node apps/mcp/dist/index.js`。

常見問題：

- `get_status` 顯示 `DISCONNECTED`：確認擴充功能已載入並完成配對，再查看選項頁面。它會顯示最後一次的連線錯誤，例如 token 被拒絕或連接埠無法連線。
- 選項頁面顯示 `unpaired`：token 欄位是空的。請再執行一次 `pair` 指令，貼上印出的值。
- 分頁顯示 `DEGRADED`，並提到「guest session」：這個瀏覽器設定檔沒有登入 Figma，所以無法選取圖層。
- 分頁顯示 `DEGRADED`，並提到「Figma UI is minimized」：介面隱藏時不會渲染圖層面板。請按 Cmd+\，或點檔名旁的展開按鈕。
- 剛安裝擴充功能後，分頁一直是 `LOADING` 或變成 `INCOMPATIBLE`：請重新載入 Figma 分頁，讓 content script 注入頁面。
- `export_asset` 回報 `EXPORT_BLOCKED`：Figma 沒有交出任何檔案，瀏覽器也沒有開始下載。如果瀏覽器擋下了 figma.com 的連續下載，請在網站設定中允許，再試一次。
- `export_asset` 回報 `LAYER_HIDDEN`：這個圖層或它所在的上層在 Figma 中是隱藏的，Figma 不會匯出它，在 Figma 裡直接按 Export 也一樣。
- `export_asset` 回報 `EXPORT_PENDING`：瀏覽器正在等待儲存備援的下載，通常是停在另存新檔的對話框。請確認儲存，或關閉「每次下載前詢問儲存位置」。
- `snapshot_layer` 回傳 `complete: false`：這個圖層超過一次呼叫在三分鐘內讀得完的量。請用同一個 root 再呼叫，直到 `complete` 為 true；在那之前，`query_snapshot` 會回報 `SNAPSHOT_INCOMPLETE`。
- `snapshot_layer` 回報 `SUBTREE_TOO_LARGE`：這個圖層中有超過 2,000 個圖層。請改為對訊息中列出的某個子層建立快照。
- 在 Codex 中，`snapshot_layer` 在 60 秒後失敗：請調高 `tool_timeout_sec`，見[在 agent 中註冊 MCP 伺服器](installation.zh-TW.md#2-在-agent-中註冊-mcp-伺服器)。
- 工具回報 `BUSY` 並寫出另一個工作階段：Figloo 正在服務那個工作階段，它正在工作，或在 10 秒內用過 Figloo。稍後再試，或先在那個工作階段完成工作。
- `get_status` 或工具說連接埠由執行舊版 Figloo 的工作階段持有：那個工作階段啟動的是 Figloo 0.1.0，無法交接。請重新啟動或關閉那個工作階段。
- 工具說持有 Figloo 的工作階段沒有回應：那個工作階段的伺服器卡住了。請關閉那個工作階段。
- 安裝 plugin 後看不到 Figloo 的工具：plugin 無法下載對應版本的伺服器 bundle。`/plugin` 會列出錯誤；請確認那個版本的 GitHub release 有 `.mcpb` 檔案，而且你的電腦可以存取。
- Agent 看到兩組 Figloo 工具：手動註冊的 Figloo 伺服器和 plugin 的同時在執行。請用 `claude mcp remove figloo -s user` 移除手動的註冊。
