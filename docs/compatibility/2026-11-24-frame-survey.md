# 盤點多個 frame：`survey_frames`

狀態：完成，預定隨 v0.8.0 發布
日期：2026-11-24
依據：[盤點多個 frame 的計畫](../plans/2026-11-24-frame-survey.md)的 M2

## 做了什麼

- 新的 bridge 操作 `survey_frames`，`PROTOCOL_VERSION` 從 0.3.0 升到 0.4.0：extension 與 MCP 伺服器要一起更新，版本不合時回報 `PROTOCOL_MISMATCH`。
- Extension（`apps/extension/src/adapter/survey-ops.ts`）：
  - 範圍：沒有 refs 時是頁面上所有的頂層圖層；有 refs 時是那些圖層。section 換成它裡面的圖層，section 裡的 section 也一樣。
  - 每個圖層沿用快照的 `walkSubtree` 走訪，不展開 instance，走完就收回自己展開的部分。為此 `LayerTree.restore` 多了 `since`，只收回某個時間點之後展開的圖層；之前列 section 時展開的部分留到最後一起收回。
  - Frame、Auto layout、Component 與 Component set 各選取一次，從屬性面板讀寬高。沒有屬性面板（訪客或編輯權限）時照常盤點，只是沒有尺寸。
  - 一次最多 3 分鐘，時間不夠時在兩個圖層之間停下，下一次呼叫跳過 `done` 中的圖層。沿用快照的遮罩、Stop、背景暫停、還原選取與收回。
- MCP 伺服器：
  - `SurveyStore`（`surveys.ts`）：存在 `~/.figloo/surveys/<檔案 key>/<page 或 refs>-<雜湊>.json`，資料夾 700、檔案 600。檔名是 page 名稱與 refs 的雜湊，不含名稱。有效期限沿用 `snapshotTtlHours`。
  - `survey_frames` 工具（`survey-tools.ts`）：分次續做、快取、`refresh`，盤點到的 ref 都加入 context。
  - 概覽（`survey-summary.ts`）分成畫面清單、依名稱分組、section、畫布註解、元件、需要人判斷的地方與其他圖層。超過一次結果的 32 KiB 時，從優先順序最低的部分逐行截掉，並註明截掉幾行。
  - 測試用環境變數 `FIGLOO_SURVEY_TIME_BUDGET_MS` 縮短每次呼叫的時間，與快照的 `FIGLOO_SNAPSHOT_TIME_BUDGET_MS` 相同。

## 實測

使用者提供的私人測試檔，有 160 個頂層圖層、沒有 section 的 page。Arc（Chromium 158），檢視權限，英文 UI。

| 項目 | 結果 |
|---|---|
| 範圍 | 160 個頂層圖層：70 個 frame、40 則註解、50 個其他圖層；frame 裡共 7,596 個圖層 |
| 一次呼叫 | 31.1 秒：列出範圍 0.15 秒、走訪 19.1 秒（每層約 2.5 ms）、收回 6.8 秒、70 個 frame 的尺寸 4.9 秒（每個約 70 ms）、還原選取 0.08 秒；591 次 UI 操作 |
| 分次續做 | 每次限 12 秒：5 次呼叫，共 36.3 秒；概覽與一次呼叫的結果逐字相同 |
| 結果大小 | 第一版 32.6 KB，剛好在 32 KiB 內；調整規則後 27.9 KB，沒有截斷 |
| 結束後 | 選取還原；圖層面板顯示的列數與盤點前相同，沒有展開的列；遮罩移除 |
| 快取 | 第二次呼叫從檔案回傳，48 ms，不讀 Figma |

讀尺寸每個 frame 約 70 ms，遠低於計畫中「超過 0.3 秒就拿掉」的門檻，所以保留。

## 依實際結果調整的規則

第一版的概覽在這個 page 上有三處雜訊，已調整並補上單元測試：

1. 「可能是 detach 的元件」原本標出名稱含 `/` 的 group 與 frame。新畫面普遍用 `card/…`、`section/…` 這類路徑替結構命名，一行就占了數 KB。改為只標出名稱以 `Component /` 開頭，或與別處的 instance 或主元件名稱完全相同（大小寫也相同）、且不是單一個字的 group 與 frame。單一個字的名稱如 `Card` 太常見，不列入。調整後只剩一項：五個畫面中有一個 group，與另外三個畫面的頁首 instance 同名。
2. 只用在一個 frame 的元件，改為依 frame 合成一行，放在元件部分的最後，最先被截掉。
3. 「可能是同一個東西的不同名稱」不再把只差數字的名稱放在一起，例如 `slot-1` 與 `slot-2`；只差大小寫或標點的名稱照樣列出，例如 `Status bar` 與 `status-bar`。
4. 畫面的文字樣本略過時間與純數字，例如狀態列的 `15:03`。

這個 page 的概覽列出：兩種名稱的狀態列（17 與 12 個畫面）、兩種名稱的導覽列（15 與 3 個畫面）、兩種頁首、5 張貼上的參考截圖，以及 11 個自動命名過半的畫面。依名稱分組得到 14 組，例如一組 9 個畫面、一組 6 個畫面。40 則註解完整列出，包括主色、按壓色、淺色背景與狀態色的色碼與用途，以及彈窗與底部面板的使用規則。

## 單元測試

- Extension，6 項：範圍與巢狀 section、依 refs 的範圍與所屬 section、只收回自己展開的部分、保留先前步驟展開的 section、不走進 instance、隱藏圖層的標示。
- MCP，21 項：流程名稱的分隔符號與平台後綴、計數與畫面行、註解換行、同名元件、detach 與截圖等標示、只用在一個 frame 的元件、快照時間的估算、截斷的優先順序；工具的分次續做與快取、移除的 frame、refresh 與過期、未知的 ref、檔案權限與不含名稱的檔名、大型 page 的截斷。

## 沒有驗證

- 有 section 的 page：這個 page 沒有 section，section 只由單元測試涵蓋。
- 以 refs 指定範圍、在盤點中按 Stop 或 Esc、盤點中分頁進入背景：只有單元測試，或沿用快照已驗證的機制。
- 訪客與編輯權限下沒有尺寸的盤點。
- 超過 2,000 層的 frame。
- 圖層面板的完整狀態：只比對了畫面上顯示的列。
