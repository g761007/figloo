# 匯出區塊的新版格式選單

狀態：修正完成，並在使用者的 Arc 上跑通完整鏈路  
日期：2026-10-06  
起因：另一個工作階段回報 `export_asset` 每次都失敗，訊息是 `UI_NOT_READY: Figma did not add an export setting`

## 發生了什麼

2026-10-03 到 2026-10-06 之間，Figma 把匯出設定列的格式控制項換成新的 select。Figloo 原本以 `[data-testid="legacy-export-file-type-input"]` 辨認設定列，所以改版後一列也認不出來：

- `export_asset` 與 `export_assets` 每次都把 `original` 當成空的，所以不帶 `format` 時也會改走 SVG 臨時設定，不再採用設計師的設定。
- 按下「Add export settings」後，Figma 確實加了一列，但 Figloo 認不出來，2 秒後回報上述錯誤。清除時又以為沒有多出的列，所以每次失敗都留下一列 PNG 設定。實測時一個沒有設定的圖層累積了三列。檢視權限寫不回設計檔，重新載入分頁後這些設定就消失了。
- `snapshot_layer` 讀到的 `exports` 一律是 `[]`。2026-10-02 與 10-03 拍的快照都有匯出設定，10-06 拍的快照全部沒有。

「Add export settings」按鈕沒有被停用，檢視者仍然可以新增設定，所以原因不是匯出權限。

## 新版結構

環境：Arc，已登入、檢視權限，英文 UI。

| 項目 | 舊版 | 新版 |
|---|---|---|
| 格式顯示 | `div[data-testid="legacy-export-file-type-input"]` | `button[role="combobox"][aria-haspopup="listbox"]`，`data-tooltip="Export file type"`，文字是目前的格式 |
| 標籤 | listbox 的 `aria-label="Export file type"` | `<label for>` 指向上述按鈕 |
| 選項 | 按下空白鍵後才出現 | `aria-controls` 指向 `ul[role="listbox"]`。關閉時只渲染已選的 `li[role="option"]`，放在 `display:none` 裡；選項帶有 `data-fpl-select-value` |
| 打開方式 | listbox 取得焦點後按空白鍵，點擊無效 | 送出 pointer 與 mouse 事件的點擊就能打開 |
| 選項名稱 | PNG、JPG、SVG、PDF | PNG、**JPEG**、SVG、PDF |
| 其他 | | 每列多了 `data-testid="row-grabber"`，是拖曳把手 |

沒有改變的部分：區塊的 `[data-testid="export-inspection-panel"]`、「Add export settings」、倍率輸入框 `input[aria-label^="Export constraints"]`、倍率選單「Select an option」（選項的角色是 `menuitemradio`）、「Advanced export settings」、「Remove」，以及「Export <圖層名稱>」按鈕。

行為：

- 新設定仍然加在最上面，倍率是其他設定沒用到的最小值。新增時，既有列沿用原本的元素。
- 已有其他設定時，在選倍率之前打開新設定的格式選單也能正常選擇，舊版「打開後沒有選項」的問題沒有再出現。
- 格式切換成 SVG 時，倍率仍會重設為 1x。

## 修正

- 改用新舊版都有的倍率輸入框辨認設定列。格式先讀新版的 select 按鈕，讀不到再讀舊版的控制項。
- 新版用點擊打開格式選單，舊版仍按空白鍵。
- Figma 的 `JPEG` 一律讀成 `JPG`，和工具的 `format` 參數同名，所以 `exports`、`settings` 與「沿用相同設定」的比對都用 `JPG`。
- 按下新增後，如果 Figma 加了一列但 Figloo 認不出來，改為回報「Figma 加了設定但 Figloo 讀不懂匯出區塊」，請使用者自行移除，不再誤報成「Figma 沒有加」。
- 舊版的控制項仍然支援，因為 Figma 可能是分批改版的。

## 驗證

| 項目 | 結果 |
|---|---|
| 單元測試 | 新增從實際分頁擷取的新版 fixture。讀取與臨時設定的測試對新舊兩種 markup 都會跑，另外測 JPEG 讀成 JPG，以及「加了列卻讀不懂」時的訊息。在舊程式上，新版 markup 的 6 項測試全部失敗，舊版的全部通過；修改後 14 項全部通過 |
| Arc：沒有設定的 Image 圖層 | 不帶 `format` 時以 SVG 匯出（816 KB，超過內嵌上限）；PNG 3x 為 654×216；JPG 2x 為 436×144，換算回 1x 都是 218×72。每次結束後都沒有殘留列，也選回原本的圖層 |
| Arc：有設計師 PNG 2x 的 frame（999:61586，203 層） | `snapshot_layer` 讀到 4 個圖層的匯出設定，與 2026-10-02 的快照相同，比對結果是 0 個變更。不帶 `format` 時採用設計師的 PNG 2x（1.8 MB，`usedExistingSettings: true`）。在旁邊加 JPG 1x 臨時設定時，Figma 打包成 ZIP，只交回 393×852 的 JPG。之後重拍快照，比對結果仍是 0 個變更，設計師的設定沒有改變 |

## 未驗證

- 舊版的格式控制項只由單元測試涵蓋，因為測試帳號已經看不到舊版。
- PDF 匯出。
- 這段期間拍的快照，`exports` 都是空的。重拍後，有匯出設定的圖層會被標記為 `[changed: exports]`。
