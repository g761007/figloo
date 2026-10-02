# `list_pages` 的頁面列表讀取

狀態：已修正，以單元測試驗證；回報的少列情況在 Arc 上未能重現  
日期：2026-10-02

## 問題

使用者提供的私人測試檔有 20 個頁面。在 Arc 中，已登入、檢視權限的分頁第一次呼叫 `list_pages` 只回傳 8 頁，之後同一分頁的每次呼叫都回傳 20 頁，期間只執行過其他 Figloo 工具。原本的實作只讀當下 DOM 裡的頁面列，沒有任何完整性檢查。

## 頁面列表的 DOM

- 左側欄的 Pages 區塊有收合按鈕（`aria-expanded`、`aria-controls`）。區塊內的 `legacy_pages_panel--pagesList` 是固定高度的容器，預設 `height: 200px`，下方有 `role="slider"` 的「Resize handle」可以調整高度。
- 容器內的捲動容器（`overflow-y: scroll`，以 class 設定）包著 `role="grid"`。每個頁面占 grid 的一個直接子元素 `.cachedSubtree`，裡面依序是 `role="row"`、`role="gridcell"`、`[data-testid="PagesRowWrapper"]` 與頁面按鈕。目前頁面的按鈕帶 `aria-current="page"`。
- 列採一般文件流排列，每列 32 px。列上沒有 `aria-rowcount`、`aria-rowindex` 或 `aria-setsize`，DOM 裡沒有任何能看出總頁數的資訊。
- 去識別化的擷取檔：`tests/fixtures/figma-pages-list.html`。

## 重現嘗試

| 情境 | 結果 |
|---|---|
| 分頁在前景時重新載入，載入後 55 秒讀取 | 20 列全部在 DOM 中，捲動位置為 0，捲動內容高度 640 px，正好等於 20 列 |
| 重新載入後立刻切到其他分頁，在背景載入 | 整個左側欄都沒有渲染，所以只會得到 `UI_NOT_READY`，不會是少列 |
| 承上，切回分頁並以 MutationObserver 記錄 | 回到前景 270 ms 後，左側欄與 20 列在同一批 DOM 變更中一起出現 |
| 分頁在前景時重新載入，從載入後 5.8 秒開始記錄 | 第一次記錄時 20 列已經全部到齊 |

結論：在可測的條件下，頁面列表既沒有依捲動位置虛擬化，也沒有分批渲染。8 頁的成因未查明，可能是在檔案載入途中讀到了一部分。

## 修正

- `list_pages` 會等到頁面列表連續 200 ms 沒有變化才回傳，最多等 2 秒。分頁在背景時以 message task 等待，避免計時器被節流。
- 結果新增 `complete`。列表在等待時限內仍在變動，或從 DOM 看得出有缺列時為 `false`。缺列的判斷依據有兩種：grid 有某一列沒有頁面，或捲動內容比已畫出的列高出半列以上。工具說明請 agent 稍後再呼叫一次，若一直是 `false`，就把結果當成部分列表。
- 橋接協定的 `complete` 是選填欄位，0.3.0 以前的 extension 不會帶，所以 `PROTOCOL_VERSION` 不變。

## 驗證

| 項目 | 環境 | 結果 |
|---|---|---|
| 單元測試 | happy-dom，擷取的頁面列表 | 讀到全部 20 頁與目前頁面；後 12 列在第一次讀取 60 ms 後才出現時，仍回傳 20 頁（舊實作只回傳 8 頁）；捲動內容比畫出的列高、grid 某一列沒有頁面，以及列表一直變動時，都回報 `complete: false`；沒有頁面列表時回報 `UI_NOT_READY`。在舊實作上，這些測試都會失敗 |
| Arc 實測 | | 未做。修正後的 extension 尚未在 Arc 上實測 |

## 已知限制

1. 如果 Figma 在 2 秒等待結束後才補上頁面，而 DOM 又看不出缺列，`list_pages` 仍會回傳不完整的列表，且 `complete` 為 `true`。
2. 每次呼叫 `list_pages` 至少多花 200 ms，popup 開啟時也一樣。
3. `explore_page` 切換頁面、以及目前頁面的判斷，同樣只看已畫出的頁面列，這次沒有修改。
