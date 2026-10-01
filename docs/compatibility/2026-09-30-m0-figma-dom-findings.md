# M0 可行性實測紀錄：Figma 圖層與屬性 UI 的 DOM 結構

狀態：訪客唯讀模式與登入檢視模式已完成，登入編輯模式未測  
日期：2026-09-30  
測試檔案：使用者提供的私人檔案，不公開名稱與連結；頁面「測試頁」  
結論：M0 通過。核心情境所需的三個能力（從節點找父層與同層、讀取基本屬性、不使用禁止來源）都在真實 Figma 頁面驗證成功，細節與限制如下。

## 測試環境

| 環境 | 瀏覽器 | 登入 | 檔案權限 | 操作方式 |
|---|---|---|---|---|
| A | Claude Code 內建瀏覽器，UA Chrome/152 | 未登入（訪客） | 檢視 | 瀏覽器工具的真實點擊，加上頁面內 JS 派發合成事件 |
| B | Arc 1.166.0，UA Chrome/154 | 已登入 | 檢視（工具列顯示 Ask to edit／Request sent） | AppleScript `execute javascript`，只能派發未信任事件，等同 content script |

共同條件：Figma UI 語言 `en`，`data-product-locale` 屬性存在。未測組合：登入編輯模式、Google Chrome 本機版本（本日自動更新為 154，M1 只在 Playwright Chromium 153 驗證）、非英文 UI。正式 extension 的 content script 已在 M1 驗證，見 2026-09-30-m1-connection.md。

## 1. 圖層面板

- 根節點 `[role="treegrid"][data-testid="objects-panel"]`，每列 `[role="row"]`，`data-testid` 為 `layer-row` 或 `layer-row-with-children`。
- 列上的 ARIA：`aria-level`（0 起算）、`aria-posinset`、`aria-setsize`、`aria-rowindex`、`aria-expanded`、`aria-selected`。
- 節點 ID：列內 `[data-testid="<nodeId>-layers-panel-row"]`，格式 `123:456`，與網址 `node-id=123-456` 對應。
- 名稱：該列非 `aria-hidden` 的 `[role="gridcell"]` 文字。
- 類型：圖示 wrapper `span[role="img"][aria-label]`，觀察到 Frame、Auto layout、Group、Instance、Component、Text、Image、Rectangle。
- 展開按鈕 `button[data-testid="layers-panel-expand-caret"]`。
- 其他屬性：`data-fpl-tree-row-index`、`data-fpl-tree-row-expanded`、`data-fpl-tree-active`（鍵盤焦點列，不是選取）。
- 列高 32px，`transform: translateY()` 定位。

### 覆蓋率與虛擬化

- `aria-setsize` 即同層總數，`aria-posinset` 是同層序號，可直接算 coverage。
- 樹展開到 85 列時，DOM 只渲染 40 列（`aria-rowindex` 46 到 85）；42 列時全部渲染。捲動容器是 `objects-panel` 往上第一個 `overflow-y` 為 auto 或 scroll 的祖先，`scrollHeight` 可估算總列數。
- 選取改變時 Figma 會收合先前為了顯示選取而展開的分支，列會從 DOM 消失，必須以 nodeId 重新定位，不能保存 element handle。

### 選取的判定

- `aria-selected="true"` 除了被選取的節點，也會標在其已展開的子孫列上。判定實際選取要取「祖先沒有被標記」的最上層列。
- 畫布鍵盤接收元素 `input.focus-target[aria-label]` 的標籤為 `Figma Design, N item(s) selected`，可作為選取數量的交叉檢查。
- 多選時同一規則適用，例如 Enter 選取全部子層後為 3 items selected。

## 2. 合成事件（未信任輸入）

| 操作 | 方式 | 環境 A | 環境 B |
|---|---|---|---|
| 展開／收合 | 對 caret 派發 pointerdown、mousedown、pointerup、mouseup、click | 成功 | 未重測 |
| 選取圖層 | 對名稱 gridcell 派發同上事件 | 訪客無法選取 | 成功，`aria-selected` 與網址同步 |
| 開啟 Main menu 與子選單 | 對按鈕與 menuitem 派發同上事件 | 失敗 | 成功，可進入 Preferences 與 Accessibility settings 對話框 |
| 勾選對話框 checkbox | `input.click()` | 未測 | 成功 |

Figloo 需要的 UI 操作都不需要 trusted input，不需要 `chrome.debugger`。

## 3. 鍵盤導覽

合成 `KeyboardEvent` 派發到 `input.focus-target`（先 `focus()`），需帶 `key`、`code`、`keyCode`，`keydown` 都被 Figma 處理（`defaultPrevented` 為 true）。

| 按鍵 | 結果 |
|---|---|
| Tab | 選取下一個同層 |
| Shift+Tab | 選取上一個同層 |
| Enter | 選取全部直接子層，變成多選 |
| Shift+Enter | 選取父層 |
| Escape | 清除選取 |

Enter 產生多選且會改變網址，讀取子層請改用展開 caret 再讀列，不要用 Enter。

## 4. 網址同步

- 單一選取時 `location.href` 的 `node-id` 立即更新，例如 `node-id=570-14192`；分享連結的 `t=` 參數保留，`p=f` 消失。
- 多選時網址退回沒有單一節點的形式，觀察到回到原始網址 `node-id=338-4231&p=f`。網址只能作為單一選取的輔助驗證，主要來源仍是圖層面板。
- 初始載入時網址帶的 `node-id` 不會產生選取。

## 5. 右側面板（檢視權限，Properties 分頁）

- 容器 `[role="region"][aria-label="Right sidebar"]` 內 `[data-testid="properties-panel"]`，有 Comments 與 Properties 兩個 `role="tab"`。
- 區塊 testid：`properties-inspection-panel`（Layout）、`content-inspection-panel`（文字內容）、`typography-inspection-panel` 與 `typography1-inspection-panel`（每個文字 span 一段）、`colors-inspection-panel`、`export-inspection-panel`；instance 另有 `navigate-to-primary-component-button`。
- 每個屬性列是 `button[data-testid="inspectionPropertyRow"]`，`aria-label` 如 `Copy Width: 393px`，內含 `inspectionPropertyName` 與 `inspectionPropertyValue`。
- 觀察到的欄位：Width、Height、Top（相對父層位置）、Font、Weight、Style、Size、Line height、Letter spacing。顏色列 `inspectColorRow` 顯示 hex，或色彩樣式名稱如 `Brand Primary`。
- 混合字級的文字圖層會分成多個 typography 區塊，標題含 span 文字，正好對應 `mixed` 狀態的保留需求。
- 限制：檢視權限下沒有 Auto Layout 的 padding、gap、對齊，也沒有圓角、邊框、效果。這些欄位在此模式應回報 `not_exposed`。編輯模式的面板結構完全不同，尚未驗證。
- 欄位名稱是英文 UI 字串，依 UI 語言而變，adapter 需以 testid 與結構定位，再用語言表對照名稱。

## 6. Mirror DOM（Adapt content for screen readers）

設定路徑：Main menu、Preferences、Accessibility settings…、第一個 checkbox「Adapt content for screen readers」。全程可用合成事件完成。

- 容器：`div#hidden-input-activedescendant[role="main"][aria-label="Board, View only"]`。
- 節點：`div[role="group"][id="<nodeId>"][data-nodeid][data-parentid][aria-label="<名稱>, <類型>"][tabindex]`。類型字串觀察到 Design frame、Component instance、Component definition、Rectangle。instance 有 `aria-describedby` 指向「Component defined by <主元件名>」。
- 幾何：inline style 的 top、left、width、height 是相對父層的百分比；內含 `<dl><dt>Dimensions</dt><dd>393 852</dd></dl>` 提供 px 尺寸，Hug 尺寸會標示 `Hug`。
- 範圍：只鏡射選取節點的父層、前一個與後一個同層、第一個子層，不是完整子樹；多選時鏡射父層與被選取的同層。
- 同步方向：只有畫布到 mirror。對 mirror 元素 `focus()`、合成 click、Enter、Space 都不會改變選取，Enter 會落到畫布的「選取子層」。
- 定位：這個設定不是核心情境的必要條件，圖層面板加 inspection 面板已足夠。它的價值在於免額外選取就取得父層 ID、類型字串與相對幾何，可作為視覺相鄰的資料來源之一。

## 7. 其他觀察

- 頁面列表 `[data-testid="PagesRowWrapper"]`，目前頁面按鈕帶 `aria-current="page"`，沒有頁面 ID。
- Figma 版本無法從 DOM 取得。
- 「Request sent」是這個帳號先前對檔案送出的編輯權限請求狀態，兩個環境都在任何操作前就顯示，不是本次測試造成。
- 選取會即時顯示在使用者的畫面與網址上，符合計畫第 6 節「讀取游標在物理上就是 Figma 選取」的前提。

## 8. 對計畫的影響

- Reference 直接採用 nodeId，來源是圖層列的 `data-testid`，與網址一致且跨列重建穩定。
- `get_neighbors` 的 parent、ancestors、siblings 可從已渲染列的 ARIA 推導；children 需先以合成點擊展開 caret，再讀取 `aria-level` 加一的列，並用 `aria-setsize` 回報 coverage。
- `inspect_nodes` 需逐一選取節點後讀 inspection 面板，結束後用 Escape 或重新點擊使用者錨點還原。每次選取都會改變畫面與網址。
- 使用者錨點追蹤：對圖層面板監看 `aria-selected` 的 MutationObserver，配合 `location.href` 與 `focus-target` 的 `aria-label` 輪詢。
- 狀態機的 `DEGRADED` 需涵蓋檢視權限：layout 群組只有尺寸與位置，appearance 只有顏色。

## 9. 未驗證項目

1. 登入編輯模式的右側面板 DOM，需要一份使用者具編輯權限的檔案。
2. Google Chrome 與正式 extension content script 的 isolated world，留待 M1。
3. 非英文 UI 的欄位名稱。
4. 使用者在畫布上點選時，圖層面板的自動展開與捲動行為，需真人操作驗證。
5. 超過 200 列的大型子樹續查。
6. Branch 與版本歷史網址的 `node-id` 行為。
