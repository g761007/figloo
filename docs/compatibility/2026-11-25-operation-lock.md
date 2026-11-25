# 操作期間鎖定 Figma 畫面

狀態：完成，尚未發布
日期：2026-11-25
依據：[操作期間鎖定 Figma 畫面](../plans/2026-11-25-operation-lock.md)

## 改動

- 每個 Figma 分頁一把鎖，由 content script 的 `ExplorerCore` 持有並計數。除了 `list_pages`，每個會操作 Figma 的操作執行期間都持有它；service worker 在 `capture`、`export_asset`、`snapshot_layer`、`survey_thumbnails` 的整個流程中也持有，並帶租約。
- 取得鎖時先以透明圖層擋下輸入，0.5 秒後或使用者碰到時才顯示卡片。截圖前遮罩改為 `opacity: 0` 並等兩個 animation frame，截完再恢復。
- 真實按鍵在 window 的 capture 階段攔下，包括送往「Stop」按鈕的按鍵；只有 Esc 等於「Stop」。
- 「Stop」或 Esc 之後，同一次工具呼叫的後續步驟不再操作 Figma，還原的步驟照常執行。

## 驗證

| 項目 | 環境 | 結果 |
|---|---|---|
| 單元測試 | happy-dom，擷取的 Figma 圖層面板，替身 `chrome` | extension 249 項全部通過。新增：鎖定元件 7 項、content script 3 項、service worker 6 項。每個新行為都以變異測試確認拿掉後測試會失敗 |
| Integration | `pnpm test:integration`，訪客模式 | `get-status` 與 `explore` 都 PASS |
| Signed-in canary | `pnpm test:canary`，canary 帳號，公開測試檔 | PASS，17 秒：anchor、子圖層、快照（視角還原）、檢視、匯出、相鄰圖層 |
| `capture` | Arc（Chromium 158），macOS 27.0，私人測試檔，檢視權限，英文 UI | 2.4 秒，卡片出現後在截圖前隱藏；截圖中沒有遮罩，畫布底色沒有被壓暗；選取與視角還原 |
| `inspect_nodes` 3 個 frame | 同上 | 394 ms，在 0.5 秒內結束，卡片沒有出現 |
| `snapshot_layer` 83 個圖層 | 同上 | 8.9 秒完成，截圖中沒有遮罩 |
| `survey_frames` 中按 Esc，第一輪 | 同上 | 回報 `USER_INTERRUPTED` 與停止訊息，但選取消失。原因見下方「發現」第 1 點，已修正 |
| `survey_frames` 中按 Esc，修正後 | 同上 | 13.6 秒時中止，選取仍在 |
| `survey_frames` 整頁 | 同上，147 個頂層圖層 | 31.8 秒完成，中途沒有中斷 |
| `survey_thumbnails` 5 張，記錄遮罩狀態 | 同上，每 20 ms 從頁面讀取遮罩元素 | 遮罩從開始到結束都在，每次截圖時 opacity 變為 0 約 0.15 到 0.4 秒；縮圖總表中沒有遮罩。使用者表示卡片這樣閃動不干擾 |
| `survey_thumbnails` 20 張中用滑鼠按「Stop」 | 同上，另記錄 pointer 事件 | 點擊落在遮罩上，拍完第 8 張後停止，剩下 9 到 20 張；選取與視角還原。之後再點一次，按鈕已停用，沒有產生 click |
| `export_asset` SVG | 同上 | 1.13 秒，直接取得檔案，加了暫時匯出設定，選取還原；遮罩持有約 1.1 秒 |

## 發現

1. 卡片出現後焦點在「Stop」按鈕上。原本 window 層級的按鍵攔截放過送往遮罩的按鍵，交給遮罩自己攔下；但按鍵在到達按鈕之前會先經過 Figma 掛在 capture 階段的監聽，Figma 收到 Esc 就清除選取。改為在 window 層級攔下所有真實按鍵後，Esc 不再清除選取。按鈕上的其他按鍵原本就一律忽略，所以沒有失去任何功能。
2. Figma 在 document 的 capture 階段看得到落在遮罩上的 `pointerup`，並對它呼叫 `preventDefault`。實測中沒有看到 Figma 因此有任何反應。
3. 使用者的滑鼠停在畫布上時，Figma 會在每次縮放後重新標示游標下的圖層，藍色的 hover 外框會被拍進截圖。這在鎖定之前就存在；使用者移動滑鼠去按「Stop」時更容易出現。這次沒有處理。
4. 第一次 `survey_thumbnails` 的「Stop」測試中，使用者按了但沒有生效。當時沒有記錄事件，無法確定原因；之後記錄事件的那一輪正常生效。

## 未驗證

- 操作途中重新載入擴充功能：舊的 content script 會釋放 service worker 的持有，並讓遮罩重新顯示，進行中的操作則持有到結束。只做了推理與型別檢查，沒有在 Arc 實測。
- 鎖定中按 Shift+1 或方向鍵時 Figma 是否有反應：使用者沒有回報。目前的證據只有 Esc 不再清除選取。
- `export_asset` 途中按「Stop」：匯出只需約 1 秒，來不及按，只有單元測試。
