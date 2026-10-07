# 圖層面板的「Fixed」與「Scrolls」分組標題

狀態：修正完成；在 GitHub runner、本機 headless 與使用者的 Arc 上驗證讀取圖層面板的部分
日期：2026-10-07
起因：每日 canary 第一次跑通時，`get_neighbors` 讀某個 frame 的子層得到 0 個圖層，測試卻仍然通過

## 發生了什麼

canary 用的是使用者帳號下的公開範例檔。`get-status.e2e.mjs` 對頁面上第一個有子層的 frame 讀兩層子樹，結果是 `0 layers, hasMore=true`，伺服器記錄 `stop=ui_timeout uiOps=3 ms=1597`。測試只檢查「每個回傳的圖層都掛在指定圖層下」，空結果也成立，所以照樣通過。

同一個檔案裡，有三個頂層 frame 每次都失敗，等 5 秒後重試也一樣；另一個 frame 一次就成功。以 Figloo 的方式送出點擊，frame 約 100 ms 就展開了，所以問題不在點擊。

## 新發現的結構

環境：Chrome for Testing（Playwright，headless），訪客，英文 UI。frame 裡有捲動時固定不動的圖層時，Figma 展開它之後，會在子層之間插入分組標題：

| 項目 | 圖層列 | 分組標題列 |
|---|---|---|
| 元素 | `div[role="row"]` | `div[role="row"]` |
| 圖層 ID | `[data-testid="<id>-layers-panel-row"]` | 沒有 |
| 內容 | 圖層名稱與類型圖示 | `span[data-testid="section-header-label"]`，文字是 `Fixed` 或 `Scrolls` |
| `aria-level` | 有 | 有，與子層相同 |
| `aria-rowindex` | 有 | 有，算在連續的列號裡 |
| `aria-posinset`、`aria-setsize`、`aria-expanded` | 有 | 沒有 |
| 高度 | 32 px | 24 px |

子層的 `aria-posinset` 與 `aria-setsize` 不把標題算進去：例子中 18 個子層編號 1 到 18，`aria-setsize` 都是 18。展開後的順序是 frame、`Fixed`、固定的圖層、`Scrolls`、其他圖層。

## 原因

- Figloo 只把有圖層 ID 的列當成列，所以讀到標題所在的列號時，一直等不到那一列，1.5 秒後判定 `ui_timeout`。子層、同層與往上找父層都會經過這一列，所以 `children`、`siblings`、`ancestors` 都停在第一個標題。`snapshot_layer` 的走訪同樣依列號往下讀。
- Figloo 以第一列的高度推算總列數與捲動位置。標題比圖層列矮，所以展開的標題一多，推算的總列數會偏少，清單最後幾層會被當成已經結束；捲動目標也會越來越偏。

## 修正

- 標題列解析成「不是圖層」的列：沒有 ID，沒有同層位置與數量。
- 走訪子層、同層、往上找父層，以及 `snapshot_layer` 的整棵子樹走訪，都跳過標題列。
- 列高取自圖層列。總列數從最後一列已渲染的列底部往下推算；捲動目標從最接近的已渲染列推算，不再用 `(列號 − 1) × 列高`。
- 切換頁面時判斷圖層面板是否換頁，改看第一個圖層列，不看第一列。
- 兩支整合測試改為：讀取中途停下（`stopReason` 不是 `complete` 或 `limit`），或讀兩層子樹得到 0 個圖層，就失敗。

## 驗證

| 項目 | 結果 |
|---|---|
| 單元測試 | 新增從真實分頁擷取、展開了有標題的 frame 的 markup，圖層名稱改成「Layer N」，共 37 列，含兩個標題。測試標題的解析、18 個子層的完整列表與分頁、從標題下方的圖層往上找父層、第一列是標題時的總列數，以及捲動到第 37 列的位置（1136 px，不是 1152 px）。另以模擬的圖層面板測試子層列表、同層與整棵子樹走訪。舊程式上 8 項全部失敗；改動後 extension 的 188 項全部通過 |
| 本機整合測試，canary 檔 | 原本 0 層的子樹讀到 30 層（測試的上限），其中 18 個直接子層；explore 測試在收緊後仍然通過 |
| 本機整合測試，使用者提供的私人測試檔 | 兩支測試都通過，結果與修正前相同 |
| Arc，已登入，canary 檔，repo 建置的伺服器（47130 port） | 三個 frame 的 `get_neighbors` children 分別完整讀到 18、18、13 層，每次約 0.1 秒；標題下方圖層的 `ancestors` 正確找到 frame；`snapshot_layer` 讀完 0:78 的 59 層，18 個直接子層都在大綱中，走訪 0.8 秒，截圖位置 `confirmed`，畫面有還原 |

## Arc 實測時的另一個發現：編輯權限下屬性讀不到

canary 檔是使用者自己的檔案，所以 Arc 上是編輯權限，`get_status` 的 `access` 是 `unknown`。這種情況下：

- 0:78 的快照雖然完成，但 59 層的 `sections` 全部是 `[]`、`exports` 全部是 `null`，整份快照只有 14.9 KB。每一層都等屬性面板等到逾時，所以 59 層花了 100 秒。
- 接著對 0:627 拍快照時，回報 `UI_NOT_READY: the screenshot does not show the whole root, so the view moved while it was taken`。

Figloo 是照檢視權限的屬性面板設計的，編輯權限本來就列為不在目標範圍、未驗證，這次修正也沒有改變這一點。不過屬性讀不到時安靜地存成空值，正是「解析守門」要處理的情況，所以列入 0.4.3 的範圍。0:627 的截圖錯誤沒有再查。

## 未驗證

- 檢視權限下對有標題的 frame 拍快照，也就是目標情境的完整快照。使用者的私人測試檔第一頁的 17 個頂層 frame 都沒有標題列，canary 檔又只有編輯權限。
- 標題出現在更深的層級，例如 frame 裡的 frame 也有固定圖層時。依結構推斷，標題的 `aria-level` 與該層子層相同，處理方式一樣，但沒有實測。
- 展開很多有標題的 frame 之後，長清單的捲動與總列數。單元測試涵蓋推算方式，真實頁面只測過兩個標題。
