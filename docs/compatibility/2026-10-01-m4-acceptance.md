# M4 交付與驗收

日期：2026-10-01  
範圍依據：[MVP 計畫](../plans/2026-09-30-figloo-mvp-plan.md)第 10 到 12 節，以及[範圍修訂](../plans/2026-09-30-figloo-scope-revision.md)

通過條件：新環境依文件完成安裝，至少一種 MCP client 跑通完整流程；核心情境在已宣告支援的環境重複執行 10 次，均不得定位錯誤或混用元件資料。

## 交付項目

| 計畫的交付項目 | 產物 | 驗證 |
|---|---|---|
| Chrome extension 可載入產物 | `pnpm package` 產生的 `release/figloo-extension-<版本>.zip`，解壓後以「載入未封裝項目」載入 | 解壓後的資料夾通過整合測試 |
| 本機 MCP 可執行套件 | `release/figloo-mcp-<版本>.mjs`，含全部相依套件的單一檔案，只需要 Node.js 24 | 以同一份整合測試驗證；新環境與原環境產生的檔案 SHA-256 相同 |
| 安裝、配對、agent 設定與診斷文件 | [README](../../README.md) 的 Install、Set up、Troubleshooting | 新環境依 README 的步驟從安裝做到測試 |
| MCP 工具契約與錯誤碼 | [docs/mcp-tools.md](../mcp-tools.md)，由伺服器註冊的工具產生 | `pnpm test` 會比對文件與實際工具，不一致就失敗 |
| 相容性矩陣及已知限制 | [docs/compatibility/README.md](README.md) | 整合各階段的驗證紀錄 |
| 真實 Figma 驗收紀錄與回歸 fixtures | 本文件、各階段紀錄、`tests/fixtures/` | 見下文 |

## 新環境安裝

只複製 git 追蹤的檔案到新資料夾，沒有 `node_modules`、建置結果與 `release/`，再依 README 執行：

| 步驟 | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | 完成；pnpm 提示略過 esbuild 的安裝腳本，建置不受影響 |
| `pnpm package` | 三個套件建置完成，產生 extension zip 與 MCP 單一檔案 |
| `pnpm test:release` | 以解壓後的 extension 與 MCP 單一檔案執行整合測試，通過：配對、分頁狀態、工具列、頁面列舉、子樹、截圖、popup 與重新連線 |

MCP client 的完整流程：使用者在 Claude Code 中貼上 popup 複製的提示後，依序以 `get_anchor`、`capture`、`get_neighbors`、`inspect_nodes` 與 `export_asset` 完成工作，見 [popup 紀錄](2026-09-30-popup.md)。

## 核心情境重複 10 次

環境：Arc 1.166.0、macOS 27.0，已登入、檢視權限、英文 UI，使用者提供的私人測試檔中的「測試頁」。MCP 伺服器使用打包後的 `release/figloo-mcp-0.0.1.mjs`，以 `tests/acceptance/core-scenario.mjs` 執行。

情境：選取資訊卡片元件裡的動作按鈕，再依序執行：

1. `get_anchor` 取得選取的按鈕。
2. `get_neighbors` 列出祖先；最近的 component 或 instance 就是卡片。
3. `get_neighbors` 以深度 3 列出卡片內的圖層。
4. `inspect_nodes` 讀取卡片、頭像圖片、兩段文字與按鈕。
5. `capture` 截取卡片。
6. `export_asset` 把按鈕匯出成 SVG。
7. 再以 `get_anchor` 確認選取回到按鈕。

| 項目 | 10 次的結果 |
|---|---|
| 錨點 | 每次都是動作按鈕 `863:36082` |
| 卡片 | 每次都是 `422:8219` |
| 卡片內的圖層 | 每次都是同樣的 7 個，而且完整列出 |
| 屬性 | 5 個圖層的讀取結果每次都相同 |
| 截圖 | 每次都是 1107×302 |
| 匯出 | 每次都在頁面內直接交付，得到內容相同的 2,823 bytes SVG |
| 選取 | 每次結束都回到按鈕，每個工具也都回報已還原 |
| 範圍 | 每次 2 次列舉、讀取 11 個圖層、6 次 UI 操作，約 4.9 秒 |

結果：10 次都與第一次相同，通過。

結束後把選取還原成原本的 frame，並收回展開的圖層；frame 上設計師的 PNG 2x 設定不變。截圖造成的縮放沒有還原，這是已知限制。

## 必要案例對照

計畫第 11 節的必要案例，以及對應的證據：

| 案例 | 證據 |
|---|---|
| 1. 選取卡片內按鈕，找到正確父卡片與相關元件 | 上方 10 次核心情境；單元測試「finds the card around the selected button without mixing up cards with the same layer names」 |
| 2. 多個同名按鈕不會交叉定位 | 同一個單元測試涵蓋五張同名卡片；`explore.e2e.mjs` 在真實 Figma 從第二個同名「Mask group」內往上找，最近的祖先是第二個而不是第一個 |
| 3. 折疊與虛擬化清單可續查；未完整讀取時正確標示 | 單元測試涵蓋長清單分頁續查、掃描與時間預算不宣稱完整、子樹截斷；`explore.e2e.mjs` 每頁 5 個取回 33 個子層，與一次列完一致 |
| 4. 多個 Figma 分頁並存，操作不跨分頁 | context 綁定分頁與頁面載入，每個請求都帶預期的頁面身分，content script 不符就拒絕，見單元測試「creates a context pinned to the tab and page load」「rejects a context from an earlier page load before touching the panel」；service worker 每個分頁各有一條操作佇列；Arc 上兩個設計稿分頁各有自己的 `tabId` |
| 5. 自動讀取切換選取，不污染使用者錨點 | `inspect_nodes`、`capture` 與 `export_asset` 結束後都還原選取，並回報 `userSelectionRestored`；10 次核心情境每次結束都重新以 `get_anchor` 確認 |
| 6. 使用者中途點選、切檔或關閉分頁，操作立即失效或中止 | 單元測試「stops as soon as the user interacts」回報 `USER_INTERRUPTED`；頁面重新載入後 context 失效，見「drops the context once the tab reports that the page was reloaded」；關閉分頁後整合測試回報 `NO_DESIGN_TAB` |
| 7. 混合文字樣式、無法取得的欄位與唯讀限制不產生假值 | 單元測試「returns the text content and one typography block per style run」；面板沒有顯示的欄位列在 `notShown`；訪客分頁的屬性讀取與匯出回報無法選取，不回傳數值 |
| 8. 超過節點、時間或輸出預算時停止，提供續查資訊 | 單元測試涵蓋掃描預算、時間預算與輸出預算，截斷時附上從第一個被捨棄圖層續查的 cursor |
| 9. Extension 或 MCP 重啟、瀏覽器恢復後，不沿用失效 reference | context 只存在 MCP 程序的記憶體中，重啟後舊的 `contextId` 回報 `CONTEXT_NOT_FOUND`；整合測試涵蓋 MCP 重啟與瀏覽器重啟後重新連線；頁面重新載入後回報 `CONTEXT_EXPIRED` |
| 10. 未配對來源、錯誤 schema 與重複 request 不造成未授權操作 | bridge 單元測試涵蓋錯誤 token、錯誤來源、握手前的訊息與不相容的協定版本；bridge 只接受等待中的 request id，逾時後晚到的回應與重複回應都被忽略，見「ignores a late answer to a timed-out request and a repeated answer to a newer one」；service worker 以 schema 檢查每個操作的參數 |

## 未驗證

見 [相容性與已知限制](README.md)。
