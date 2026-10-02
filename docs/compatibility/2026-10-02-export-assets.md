# 批次匯出與重新載入後的快照 ref（export_assets）

狀態：實作完成，在使用者的 Arc 上跑通。重新載入分頁前後，以快取的快照匯出深層圖層都成功；實測中找到並修正了隱藏 instance 的判斷  
日期：2026-10-02  
範圍依據：[Roadmap 第一批](../plans/2026-10-02-roadmap-batch-1.md)的 M3

## 內容

| 項目 | 內容 |
|---|---|
| `export_assets` | 依序匯出多個圖層，存進專案中的同一個資料夾。可以指定 refs，或傳入快照 id，匯出其中所有有匯出設定的圖層（可加 `under`）；隱藏圖層跳過。每次最多 50 個、約 150 秒，其餘放在 `remaining` |
| 重新載入後的快照 ref | 快照檔記下 root 的祖先（`rootPath`）。所有需要 ref 的操作都帶上從頂層到目標的 parent 鏈（`known`），extension 據此展開祖先找到圖層。`snapshot_layer` 也接受新 context 傳入舊快照的 root |
| 隱藏判斷 | 圖層面板以灰色（`--color-text-disabled`）標示隱藏圖層，instance 與其中的圖層則改用最暗的紫色（`--color-text-component-tertiary`）。兩者都算隱藏；快照中位於隱藏圖層裡的圖層一律算隱藏 |
| `LAYER_HIDDEN` | 匯出隱藏圖層時立刻回報，不再按 Export 等 12 秒後回報 `EXPORT_BLOCKED` |
| 匯出失敗的說明 | 頁面中的攔截程式記錄 Figma 交出檔案的方式（Blob、下載連結、`window.open`、存檔選擇器），`EXPORT_BLOCKED` 的訊息會附上這些紀錄 |
| Protocol | 0.2.0 升到 0.3.0，extension 與 MCP 伺服器必須一起更新 |

## 做法

- 環境：Arc，已登入、檢視權限，英文 UI，使用者提供的私人測試檔。新版 MCP 伺服器以 stdio 腳本在 47130 port 啟動，extension 暫時改連 47130，不影響使用者其他工作階段的伺服器。
- 測試對象是 frame 999:61586（203 個圖層）。它的快照是當天早上由 0.3.2 讀取的，之後分頁重新載入過，所以快照中的深層圖層都不在這次頁面載入的索引裡。
- 臨時匯出設定是否移除，以 `snapshot_layer` 的 `refresh: true` 重新讀取，逐層比對 203 個圖層的匯出設定。

## 驗證

| 項目 | 結果 |
|---|---|
| 以舊頁面載入的快照匯出深層圖層 | 成功。深度 2 的 rectangle、深度 4 的 image、深度 1 的 instance 與 root 都能以 SVG 或 PNG 4x 匯出，深層圖層經由快照的 parent 鏈找到 |
| 一次匯出 12 個可見圖層（refs、PNG 臨時設定） | 12 個全部直接交付，10.9 秒；3 個重複的檔名加上了 ref 後綴；之後比對 203 個圖層，匯出設定沒有變化 |
| 從快照匯出有匯出設定的圖層 | root（PNG 2x）成功；3 個隱藏的 instance 與 1 個隱藏的 auto layout 被跳過，整批 1.8 秒 |
| 重新載入分頁後 | 快照從快取回傳；從快照匯出成功 1 個、跳過 4 個；12 個圖層的批次全部成功，10.7 秒 |
| 隱藏的 instance | 修正前，快照把 44 個位於隱藏群組中的 instance 記為可見，匯出時每個等 12 秒後回報 `EXPORT_BLOCKED`。使用者親手按 Export 也沒有反應，匯出預覽是透明的。修正後快照有 131 個隱藏圖層，沒有位於隱藏圖層中卻記為可見的圖層；匯出隱藏的 instance 在 263 ms 內回報 `LAYER_HIDDEN` |
| 選取與顏色的關係 | 可見的 instance 不論是否選取都是 `--color-text-component`；隱藏的 instance 未選取時也是 `--color-text-component-tertiary`，所以最暗的紫色代表隱藏，與選取無關 |
| `EXPORT_BLOCKED` 的紀錄 | 隱藏 instance 的匯出，紀錄為「Figma 沒有建立 Blob，也沒有點擊下載連結」；下載資料夾也沒有新檔案 |
| 下載提示 | 所有成功的匯出都是直接交付，沒有經過瀏覽器下載 |
| 選取還原 | 所有批次的 `userSelectionRestored` 都是 true |

## 未驗證與待查

- 調查過程中，隱藏的 auto layout 999:61682 一度多了一個「PNG 1x」匯出設定，這是 Figma 新增設定時的預設值。期間 Figloo 只對另一個圖層加過臨時設定且已移除，探查腳本沒有按過「Add export settings」，使用者也沒有。重新載入分頁後這個設定消失了，所以只存在當時的分頁裡，沒有寫進設計檔。來源未查明。
- 在測試檔的 20 個頁面中逐頁 `explore_page` 時，第 7 到 13 頁回報 `UI_NOT_READY`，原因未查。
- 早上快照中的另一個 frame 570:14192 已不在任何頁面的頂層，所以沒有拿它來測。
- 備援的下載路徑沒有測：所有匯出都是直接交付。
- 50 個圖層與 150 秒的上限只由單元測試涵蓋。
