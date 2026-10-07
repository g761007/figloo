# 疑難排解

[English](troubleshooting.md) | 繁體中文

> 本文件譯自英文版 [troubleshooting.md](troubleshooting.md)，兩者不一致時以英文版為準。

先從這些地方查看：

- **`figloo-mcp doctor`**：在終端機執行（`node apps/mcp/dist/index.js doctor`，使用 release 檔案時是 `node figloo-mcp-<version>.mjs doctor`）。不需要任何 agent 工作階段，它會檢查 Node.js、設定檔與配對 token，以及連接埠由誰持有：沒有人、某個 Figloo 工作階段（附上版本，以及是否有擴充功能連著），無法交接的舊版 Figloo，或其他程式。它不啟動伺服器，也不搶任何人的連接埠。
- **`get_status`**：請 agent 呼叫它。它會回報 bridge、擴充功能的連線，以及每個 Figma 分頁的就緒狀態與原因，並附上說明下一步的 `hint`。每個分頁會列出 `limitations`：Figloo 在這個分頁不能做什麼、受影響的工具，以及使用者能怎麼處理，對照見下表。伺服器拒絕擴充功能的連線時，它會說明原因：該更新哪一邊，或配對 token 不符。
- **工具列圖示與 popup 視窗**：提示文字與 popup 視窗會顯示目前分頁的就緒狀態與 agent 連線，兩者內容相同。Popup 視窗中的「Diagnostics」提供可以貼到 bug report 的報告，不含檔案、頁面或圖層的名稱。
- **選項頁面**：顯示連線狀態、Figloo 正在服務的 agent 工作階段、最近一次在工作階段之間交接的時間，以及最後一次的連線錯誤。
- **Service worker 主控台**：在 `chrome://extensions`（或 `arc://extensions`）的 Figloo 卡片上點「service worker」。
- **伺服器日誌**：伺服器每次被呼叫時，會在 stderr 寫一行，包含數量、UI 操作次數與耗時，但不含圖層名稱。要查看時，請在沒有 agent 工作階段執行伺服器的情況下，在終端機手動執行，例如 `node apps/mcp/dist/index.js`。

`get_status` 的分頁限制：

| 代碼 | 意思 | 處理方式 |
|---|---|---|
| `UI_MINIMIZED` | Figma 介面縮到最小，圖層面板沒有渲染，所有工具都受影響。 | 按 Cmd+\，或點檔名旁的展開按鈕。 |
| `GUEST` | 沒有登入 Figma，無法選取圖層：讀不到選取、屬性、匯出與快照，截圖只能截整個頁面。 | 在裝了擴充功能的瀏覽器中登入 Figma。 |
| `EDIT_ACCESS` | 編輯權限下 Figma 顯示 Design 面板，Figloo 不讀這個面板：沒有屬性、快照與匯出；圖層與截圖可用。 | Figloo 以檢視權限為目標，這個檔案中沒有辦法處理。 |
| `UI_CHANGED` | 已登入，卻找不到右側欄或屬性面板，可能是 Figma 改了介面。 | 重新載入 Figma 分頁；仍然不行時，附上 popup 的 Diagnostics 回報。 |
| `NO_KEYBOARD_TARGET` | 找不到 Figma 畫布的鍵盤目標，截圖與快照無法縮放。 | 重新載入 Figma 分頁。 |
| `NO_SCREEN_READER_MIRROR` | 沒有開啟「Adapt content for screen readers」：`get_visual_neighbors` 會失敗，截圖以推估裁切，快照量不到大部分圖層的位置，畫面也不會還原。 | 在 Main menu、Preferences、Accessibility settings 中開啟。 |
| `NOT_ENGLISH` | Figma 介面是其他語言，而 Figloo 依英文標籤讀取面板。 | 把 Figma 切換成英文。 |

工具錯誤附有 `retry`：`yes` 表示原樣再呼叫可能成功，或許要等一下；`after_user` 表示使用者照 hint 處理後再試；`no` 表示 agent 要先做別的事，例如重新取得 context。

常見問題：

- `get_status` 顯示 `DISCONNECTED`：確認擴充功能已載入並完成配對，再查看選項頁面。它會顯示最後一次的連線錯誤，例如 token 被拒絕、連接埠無法連線，或 protocol 版本不符與兩邊的版本。`figloo-mcp doctor` 會說明是否有工作階段持有連接埠，以及是否有擴充功能連著。
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
