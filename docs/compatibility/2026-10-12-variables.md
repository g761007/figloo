# 綁定 Figma 變數的值

狀態：完成，v0.7.0
日期：2026-10-12
依據：[v0.7.0 計畫](../plans/2026-10-12-v0.7.0-performance.md)的「變數」里程碑；M4 準備時發現

## 發現

使用者在 canary 檔的測試 frame `Figloo test` 中，把矩形的填色綁到變數 `Icon/Positive/Default`，再新增 Number 變數 `spacing/md`（16）與 `radius/sm`（8），分別綁到 auto layout 的 gap 與一個矩形的圓角。屬性面板（檢視權限、英文介面，2026-10-12）：

- 綁了變數的顏色改用兩行的 `inspectMultilineColorRow`：第一行是變數名稱的標籤（`variable-pill-root`），第二行才是 hex。Figloo 只認 `inspectColorRow`，所以整個 Colors 區段標成 `unreadable`。
- 綁了變數的數字，值欄位是變數名稱的標籤；複製按鈕的 `aria-label` 是 `Copy Radius: radius/sm`，實際的值只在標籤的 `data-tooltip`（`8px`）。Figloo 原本讀到的值是 `radius/sm`。

## 改動

- 屬性與顏色多一個選填的 `variable`，是變數名稱；屬性的 `value` 改為變數代表的值（取自 `data-tooltip`），顏色讀出 hex 與透明度。舊版的 extension 不會送這個欄位，bridge 協定仍是 0.3.0。
- `summarize_snapshot` 把綁了變數的值與沒綁的同一個值分開列出，並附上變數名稱。
- `map_tokens` 帶出變數名稱，名稱像變數的 token 排第一：值相同時是 exact，值不同時是 near，並註明「named like the variable; the value differs」。名稱比對用字詞重疊（至少 0.75），或 token 名稱的最後幾個字與變數名稱相同，例如 `theme.extend.colors.brand.primary` 對 `Brand/Primary`。
- figloo-implement 與屬性欄位的參考說明：綁了變數的值對到同名的 token。

## 驗證

| 項目 | 結果 |
|---|---|
| fixture | `tests/fixtures/inspection/variable-rectangle.html` 與 `variable-auto-layout.html`，取自 canary 檔。顏色讀成 `#02542D` 加上 `Icon/Positive/Default`，圓角讀成 `8px` 加上 `radius/sm`，gap 讀成 `16px` 加上 `spacing/md`，沒綁變數的值不變 |
| 摘要與對應 | 單元測試：同一個值綁與不綁變數分開列出；Tailwind 的路徑結尾對上變數名稱時排第一，專案的同名 token 值不同時是 near |
| 真實的 Figma | canary 拍 `Figloo test`：讀不懂的圖層 4 → 0；摘要列出 `#02542D`（`Icon/Positive/Default`）、`16px`（`spacing/md`）、`8px`（`radius/sm`）與另一個沒綁變數的 `8px`；對一個有 `--icon-positive-default`、`--spacing-md`、`--radius-sm` 的專案，`map_tokens` 都把同名的 token 排第一 |

## 沒有驗證

- 字級、行高等文字樣式綁變數；使用者沒有設定這一項。解析器對所有屬性列一視同仁，應該也適用，但沒有實測。
- 綁了變數、透明度又不是 100% 的顏色；目前依同一列中的百分比讀透明度。
- 變數有多個 mode 時屬性面板顯示哪一個值。
- 字串與布林變數。
