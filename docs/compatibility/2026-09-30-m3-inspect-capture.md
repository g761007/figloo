# M3 屬性讀取、截圖與頁面入口

狀態：實作完成並在使用者 Arc 上跑通完整鏈路，包含修正後的圖層截圖；等待提示框消失的修正已在 Arc 頁面內驗證  
日期：2026-09-30  
範圍依據：[範圍修訂](../plans/2026-09-30-figloo-scope-revision.md)

## 新增工具

| 工具 | 用途 | Figma 分頁需在前景 |
|---|---|---|
| `list_pages(tabId)` | 列出檔案的頁面與目前頁面 | 否 |
| `explore_page(tabId, page?, limit?)` | 必要時切換頁面，列出頁面上的頂層圖層並建立 context | 切換頁面時需要 |
| `get_neighbors(..., depth?)` | `children` 可加 `depth`，最多 3 層，廣度優先，總數仍受每次 50 個上限 | 展開收合的圖層時需要 |
| `inspect_nodes(contextId, refs, groups?)` | 讀取檢視權限下的屬性面板，每次最多 5 個圖層 | 需要 |
| `capture(contextId, ref?)` | 截取圖層或整頁，回傳 JPEG 圖片 | 需要 |

## 檢視權限下屬性面板的實測內容

環境：Arc 1.166.0，已登入、檢視權限，英文 UI，檔案 Sample App，共調查 14 個圖層。

| 區塊 | 內容 | 例子 |
|---|---|---|
| Layout | 寬高與尺寸模式、相對父層位置、Auto layout 方向、padding、gap、四角圓角、邊框粗細 | `Width: Hug (393px)`、`Top: 336px`、`Padding—Top: 24px`、`Radius—Top-left: 16px`、`Gap: 10px` |
| Colors | 填色 hex 與透明度，或色彩樣式名稱 | `#FFFFFF`、`#00000040%` |
| Borders | 邊框顏色與透明度 | `#FFFFFF 50%` |
| Shadows and blurs | 陰影參數與顏色 | `Drop shadow—Y: -4`、`Blur: 8`、`#08458A 12%` |
| Content | 文字內容 | |
| Typography | 每一段樣式各一個區塊：字型、字重、樣式、字級、行高、字距 | `Font: Roboto`、`Size: 24px`、`Line height: 150%` |
| Component properties | Instance 的元件屬性 | `Property: birthday` |
| Parent component | 所在的父元件名稱 | |
| Images | 圖片填色的檔名 | `photo.png` |
| Export | 匯出設定與預覽；只有設計師設定過匯出的圖層才有預覽 | |

每一列都是一個帶 `aria-label` 的複製按鈕，格式為 `Copy 群組—名稱: 值` 或 `Copy 名稱: 值`，所以 padding 的 `Top` 與位置的 `Top` 可以明確區分。解析器以 `data-testid` 找區塊、以 `aria-label` 讀值，不依賴畫面文字的排版。

## 截圖

- 流程：選取目標、以 Shift+2 縮放到選取範圍（整頁則用 Shift+1 縮放到全覽）、按 Escape 取消選取以免選取框入鏡、service worker 以 `captureVisibleTab` 擷取、依圖層在畫面上的位置裁切、縮到長邊 1568 px 以內並轉成 JPEG，最後選回使用者原本的選取。
- 裁切依據：開啟「Adapt content for screen readers」時，mirror DOM 提供被選取圖層在畫面上的位置，縮放後實測為 364×789，對應 393×852 乘以 93%。
- Figma 縮放時會播放動畫，mirror DOM 的位置跟著動畫更新。第一次在 Arc 實測時，從 8% 縮放到 93% 途中就讀了位置，裁到 54×88 的一小塊背景。修正後會連續取樣，直到位置穩定、且大小與屬性面板的寬高乘以縮放比例相差不到 10% 才裁切；沒有 mirror DOM 或位置一直不符時，改以畫布中心推算，邊距放寬到 48 px。
- 縮放會在 `[data-testid="visual-bell-message"]` 顯示「Zoom to selection」之類的提示框，約 0.1 秒後出現並停留約 3 秒。截圖前最多等 4 秒讓它消失，所以一次截圖約需 3 到 5 秒。
- 需要 `<all_urls>` 權限；只有 figma.com 權限時 Chrome 拒絕截圖。
- 縮放後不還原視角，因為 Figma 沒有「回到上一個視角」的操作。切換頁面時 Figma 會記住每頁各自的選取與視角。
- 替代方案「Export 預覽」可以不縮放就取得單一圖層的精確渲染，但只有設定過匯出的圖層才有，解析度也受面板寬度限制，所以目前未採用。
- 直接讀取畫布像素只得到單一顏色，不可行。

## 背景分頁

選取、展開與切換頁面在背景分頁都不會立即生效，切換頁面的請求還可能延後到分頁回到前景才執行。所以 `inspect_nodes`、`capture`、需要切頁的 `explore_page`，以及需要展開圖層的 `get_neighbors`，在背景分頁一律回報 `TAB_IN_BACKGROUND`，不送出任何操作。

## 驗證

| 項目 | 結果 |
|---|---|
| 單元測試 | 97 個全部通過，含四份真實擷取的屬性面板素材 |
| 訪客分頁整合測試 | `list_pages`、`explore_page`、兩層子樹、整頁截圖都走完整鏈路；訪客讀屬性會回報沒有屬性面板 |
| Arc 完整鏈路（MCP、bridge、service worker、content script） | 列出 8 個頁面；進入頁面列出 42 個頂層圖層；整頁截圖 1423×1568；兩層子樹 40 個圖層，約 0.7 秒；5 個圖層的屬性約 1.2 秒；結束後選取還原成原本的 frame |
| Arc 圖層截圖修正 | 重新載入 extension 後走完整鏈路，frame 截圖為 748×1568，內容清楚；裁切為 387.9×813，等於 frame 的 364×789 加上四周 12 px |
| Arc 提示框修正 | 以注入 adapter 在頁面內驗證：準備截圖的步驟回傳時提示框已消失 |
| Arc 選取還原 | 被選取的圖層不在圖層面板可見範圍時，仍能找回並重新選取 |

## 未驗證

1. 等待提示框消失的修正，尚未經過重新載入的 extension 走完整鏈路。
2. Arc 上有兩次截圖後選取沒有還原，刻意重現「圖層不在可見範圍」的條件時卻正常。最可能的原因是過程中分頁短暫進入背景，此時 Figma 不接受選取，工具會回報 `userSelectionRestored: false`。
3. 色彩樣式名稱、漸層、多重填色、模糊效果、旋轉、透明度與混合模式在面板中的呈現。
4. 沒有開啟「Adapt content for screen readers」時的裁切效果。
5. 非英文 UI 的欄位名稱。
