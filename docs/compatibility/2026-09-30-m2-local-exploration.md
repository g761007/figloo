# M2 局部探索驗證紀錄

狀態：自動化驗證通過；使用者 Arc 上由真人選取的完整鏈路，待重新載入 extension 後驗證  
日期：2026-09-30

## 工具契約

| 工具 | 參數 | 回傳 |
|---|---|---|
| `get_anchor` | `tabId` | `contextId`、`anchor`（使用者選取的圖層）、`fileKey`、`page`、`selectionCount` |
| `get_neighbors` | `contextId`、`ref`、`relation`、`cursor?`、`limit?` | `nodes`、`coverage`、`hasMore`、`nextCursor`、`stopReason`、`uiOps`、`elapsedMs` |
| `release_context` | `contextId` | `released` |

`relation` 為 `parent`、`ancestors`、`siblings`、`children`。圖層摘要欄位見 `packages/protocol` 的 `LayerNodeSchema`：`ref`、`name`、`type`、`depth`、`position`、`siblingCount`、`parentRef`、`hasChildren`、`childCount`、`insideInstance`、`link`。

錯誤以 `isError` 結果回傳，內容為 `{ error: { code, message, hint } }`，`hint` 是給 agent 的下一步。

### 與計畫的差異

- `get_anchor` 以 `tabId` 取代計畫中未定義的 `sessionId`，分頁由 `get_status` 取得。
- `siblings` 回傳父層的全部子層，依圖層順序並包含 `ref` 本身，方便 agent 看出位置。
- `coverage` 為 `{ fromPosition, toPosition, total }`；`ancestors` 的位置是與 `ref` 的距離，1 為父層。
- 列舉子層需要展開時，每次呼叫結束就收合並還原捲動位置，不等到 `release_context`。
- 只接受同一個 context 回傳過的 `ref`（錨點、錨點的父層、各次列舉的結果），避免 agent 以猜測的 ID 觸發大範圍搜尋。
- context 閒置 30 分鐘或數量超過 32 個時淘汰。

## Figma 實測發現

環境：Arc 1.166.0（Chrome 154 核心），已登入、檢視權限，英文 UI；以及 Playwright Chromium 153 訪客分頁。

- **Instance 子層的 ID 只在單次頁面載入有效**。同一個子層在兩次載入間從 `1304:5270` 變成 `1335:5270`；instance 外的圖層 ID 則跨載入不變。因此 context 綁定該次載入的 `pageId`，重新整理後回報 `CONTEXT_EXPIRED`，`link` 也只提供給 instance 外的圖層。
- **網址不能當作錨點**。選取 instance 子層時，網址的 `node-id` 指向外層 instance；沒有選取時，網址會退回原始分享連結的 `node-id`。錨點改以圖層面板的選取列判定，數量由畫布鍵盤目標的「N items selected」確認。
- **被選取圖層若已展開，Figma 也把它渲染出來的子孫列標成選取**。錨點取最上層的選取列。
- **背景分頁**（`document.hidden`）：
  - 只改 `scrollTop` 不會重新渲染虛擬清單；補派 `scroll` 事件後會非同步渲染。adapter 每次捲動都派發 `scroll` 事件，等待時改用不受計時器節流影響的 message task。
  - 點擊展開按鈕沒有效果，數分鐘後仍未展開，無法確認是丟棄還是延後執行。adapter 在背景分頁不送出點擊，回傳 `TAB_IN_BACKGROUND`；`get_status` 的每個分頁多了 `visible` 欄位。
  - 讀取選取、祖先、同層與已展開圖層的子層都不需要點擊，背景分頁可正常使用。
- **使用者介入**：操作期間只要出現真實的 `pointerdown`、`keydown` 或 `wheel`（`isTrusted`），就中止並回報 `USER_INTERRUPTED`，也不再還原面板。

## 預算

| 項目 | 值 |
|---|---|
| 每次列舉 | 預設 20，上限 50 |
| UI 操作時間 | 每次 15 秒 |
| UI 操作次數 | 每次 300 次捲動或展開 |
| 工具結果 | 32 KiB，超過時從尾端截斷，`stopReason` 為 `output_budget` 並附續查 cursor |

預算用完時回傳已取得的部分，`hasMore` 一律為 `true`，不宣稱已完整。MCP 在 stderr 記錄關係、筆數、UI 操作數、耗時與輸出位元組，不記錄圖層名稱。

## 驗證

- **單元測試**：以模擬虛擬化清單的假資料測試導覽邏輯，涵蓋五張同名卡片不互相混淆、只標出最上層選取列、祖先分頁、instance 內外判定、跳過已展開同層的子孫、長清單分頁續查只讀新列、掃描與時間預算、使用者介入、上方列位移後重新定位。另以真實擷取的去識別化圖層面板測試解析、instance 子層錨點、連結、錯誤碼與背景分頁行為。
- **整合測試 `explore.e2e.mjs`**：在真實 Figma 訪客分頁注入同一份 adapter。

| 項目 | 結果 |
|---|---|
| 頂層列舉 | 42 個全部列出，1 次 UI 操作 |
| 同名同層 | 兩個 `Mask group`，從第二個內部往上找，最近祖先是第二個而非第一個 |
| 分頁 | 33 個子層每頁 5 個逐頁取回，與一次列完一致 |
| 還原 | 全部操作後，展開狀態與開始前相同 |

- **整合測試 `get-status.e2e.mjs`**：`get_anchor` 與 `get_neighbors` 的沒有選取、非設計稿分頁、context 不存在等錯誤，經過 MCP、bridge、service worker 與 content script 每一段。

## 未驗證

1. 登入狀態下使用者親自選取的錨點走完整鏈路；需要在 Arc 重新載入 extension，並讓 Figma 分頁留在前景。
2. 背景分頁裡的展開點擊究竟是被丟棄還是延後執行。
3. 計畫第 11 節要求的核心卡片情境重複 10 次。
4. 非英文 UI 的圖層類型標籤。
5. 數百列以上的長清單在時間預算內的表現。
