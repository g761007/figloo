# 匯出 icon 與圖片（export_asset）

狀態：實作完成，並在使用者的 Arc 上跑通完整鏈路。四次匯出都在頁面內直接交付給 agent，下載資料夾沒有新增檔案  
日期：2026-09-30  
範圍依據：[範圍修訂](../plans/2026-09-30-figloo-scope-revision.md)

## 新增工具

| 工具 | 用途 | Figma 分頁需在前景 |
|---|---|---|
| `export_asset(contextId, ref, format?, scale?, saveTo?, overwrite?)` | 用 Figma 的 Export 按鈕匯出圖層。SVG 以文字回傳；長邊 1568 px 以內的 PNG 與 JPG 以圖片回傳。加上 `saveTo` 時另存到專案內 | 需要 |

## 檢視權限下 Export 區塊的實測

環境：Arc，已登入、檢視權限，英文 UI，檔案 Sample App。測試對象是 16×16 的 instance `tag_icon`，以及設計師設了 PNG 2x 的 frame「測試畫面」。

### 結構

- 區塊是 `[data-testid="export-inspection-panel"]`。沒有匯出設定的圖層只有「Add export settings」與「Export <圖層名稱>」兩個按鈕。
- 每列設定有倍率輸入框 `input[aria-label^="Export constraints"]`，以及倍率選單「Select an option」，選項為 0.5x、0.75x、1x、1.5x、2x、3x、4x、512w、512h。
- 每列設定還有格式選單 `[role="listbox"][aria-label="Export file type"]`、「Advanced export settings」與「Remove」按鈕。
- 格式選單用點擊打不開，要讓 listbox 取得焦點後按空白鍵，選項為 PNG、JPG、SVG、PDF。空白鍵與方向鍵事件由選單自行處理，不會傳到 document。
- 「Advanced export settings」對話框只有後綴、色彩設定檔、影像重新取樣與兩個勾選項，沒有格式。
- 「Export <圖層名稱>」一次匯出所有設定列。
- Figma 給的檔名就是圖層名稱，例如 `tag_icon.svg`。2x 的 PNG 也叫 `tag_icon.png`，沒有倍率後綴。
- 同時匯出多組設定時，Figma 打包成一個以設計稿檔名命名的 ZIP，例如 `Sample App.zip`，裡面的檔名同樣沒有倍率後綴。
- 先前在下載資料夾看到的檔名是「Sample App Identity Tag.svg」，與 Figma 給的名稱不同，可能是瀏覽器存檔時改了名稱，原因未確認。

### 行為

- 沒有匯出設定的圖層，按鈕會沿用前一個有設定的圖層名稱；加上一列設定後，才改成「Export <圖層名稱>」。實測 Text、Frame、Group、Section 共 6 個頂層圖層都是如此。
- 切換選取的瞬間，區塊會短暫保留前一個圖層的設定列，約 90 ms 後才更新。
- 新增的設定放在最上面，倍率是其他設定沒用到的最小倍率。例如已有 1x 時新設定是 2x，已有 2x 時新設定是 1x。
- 每次變動後，所有設定列都會重建成新的 DOM 元素。
- 已有其他設定時，新設定的格式選單若在選過倍率之前打開，或在倍率選單還沒關閉時打開，會停在「已展開但沒有選項」的狀態，直到這列設定被移除。先選倍率，即使選的是原本的值，並等選單關閉，格式選單就正常。
- 格式切換成 SVG 時，倍率會重設為 1x。
- 在頁面上按 Escape 會取消選取。
- 以程式點擊連續觸發第二次下載時，下載資料夾沒有出現檔案，推測是被瀏覽器的「多次自動下載」保護擋下。

## 做法：優先把檔案直接交給 agent

1. 每次匯出時，service worker 以 `chrome.scripting.executeScript` 在頁面的主環境注入一個短暫的 hook。它包住 `URL.createObjectURL`、`HTMLAnchorElement.prototype.click` 與 `EventTarget.prototype.dispatchEvent`。
2. Figma 點擊 blob 或 data 下載連結時，hook 取得檔案內容，以 `postMessage` 交給 content script，並取消這次下載，所以瀏覽器不會存檔。
3. 匯出結束，或注入 28 秒後，hook 會放回原本的函式。只有目前啟用的 hook 能還原，所以前一次匯出的計時器不會拆掉下一次的 hook。
4. 沒收到檔案時改走備援路徑。extension 以 `chrome.downloads` 等候瀏覽器自己的下載完成，再由 MCP 伺服器從下載位置讀檔。
5. 實測同時匯出 SVG 與 PNG 兩組設定時，Figma 送出單一 ZIP：SVG 以 deflate 壓縮，PNG 以 stored 方式儲存，檔名帶 UTF-8 旗標。社群另回報圖層名稱含 `/` 時也會打包，這點未驗證。MCP 伺服器會解開 ZIP；content script 收到 ZIP 後就不再等其他檔案。
6. 指定了 `format` 而圖層原本就有設計師的設定時，Figma 會連同那些設定一起匯出。MCP 伺服器只保留要求的格式。

## 臨時設定

- 沒有指定 `format` 時，使用設計師的匯出設定；圖層沒有設定時，以 SVG 匯出。
- 指定了 `format` 時，加一列該格式與倍率的臨時設定，倍率預設 1x，所有格式都適用。圖層已有完全相同的設定時直接沿用，不另外新增。
- 只有在按鈕指向目標圖層時，區塊裡的設定列才算是該圖層的設定。按下 Export 前會再確認按鈕名稱就是目標圖層，否則不點擊並回報 `UI_NOT_READY`。
- 新增後以內容比對找出新的那一列，之後鎖定它的位置操作。每一步都確認其他列仍與原本完全一致，不一致就停止，所以不會改到設計師的設定。
- 設定順序是先選倍率並等選單關閉，再切換格式，最後再確認一次倍率。
- 匯出後以內容比對移除多出的那一列，並選回使用者原本的選取。
- 使用者在匯出途中操作 Figma 時，不移除臨時設定，也不還原選取，以免動到別的圖層；結果會回報 `userSelectionRestored: false`。

## 存檔位置

- `saveTo` 只能寫在專案目錄內，既有檔案必須加上 `overwrite: true` 才會取代。
- 專案目錄取自 Claude Code 為 MCP 伺服器設定的 `CLAUDE_PROJECT_DIR`，沒有時才用伺服器的工作目錄。官方文件說明伺服器的工作目錄不一定是專案目錄。
- 路徑結尾是 `/`，或匯出多個檔案時，`saveTo` 視為資料夾，檔名沿用 Figma 的檔名。ZIP 內的資料夾結構不保留，只取檔名。

## 驗證

| 項目 | 結果 |
|---|---|
| MCP 單元測試 | 11 項通過。涵蓋 SVG 直接回傳、PNG 以圖片回傳、依 `CLAUDE_PROJECT_DIR` 存檔、`saveTo` 限制在專案內且不覆寫既有檔、下載備援、錯誤提示 |
| MCP 單元測試：ZIP | 測資由 Python `zipfile` 產生，含資料夾項目、deflate 與 stored 壓縮、data descriptor、UTF-8 中文檔名；另測格式篩選與圖片尺寸上限 |
| Extension 單元測試：hook | 以序列化後的形式執行。它能取得已撤銷網址的 blob，不影響一般連結，移除後放回原函式，前一次的計時器也不會拆掉新的 hook |
| Extension 單元測試：臨時設定 | 模擬器依上述實測行為重現 Figma，驗證只新增並移除臨時設定，設計師的設定從未被修改或刪除。拿掉「等選單關閉」時，其中兩項會失敗 |
| 訪客分頁整合測試 | `export_asset` 回報訪客無法選取圖層；失敗後 hook 已從頁面移除 |
| Arc 按鈕名稱實測 | 依序選取 6 個頂層圖層，屬性面板標題都換成新圖層，但沒有設定的圖層，按鈕都保留舊名稱 |
| Arc 注入程式，攔下 Export 點擊 | 六種情境全部通過：icon 的 SVG、PNG 2x 與不指定格式，frame 使用設計師的 PNG 2x、沿用相同的 PNG 2x，以及在 PNG 2x 旁加 SVG 臨時設定。每次結束都選回原本的 frame，設計師的 PNG 2x 不變，沒有留下展開的圖層，icon 也沒有殘留設定 |
| Arc 完整鏈路（MCP、bridge、service worker、content script） | 重新載入 extension 後，四次匯出都是 `source: "direct"`：icon 的 SVG 5,606 B 以文字回傳，約 1.2 秒；icon 的 PNG 2x 為 32×32，以圖片回傳並存檔，約 1.2 秒；frame 依設計師的 PNG 2x 匯出 786×1704、1.9 MB，超過內嵌上限所以只存檔，約 3.2 秒；frame 在 PNG 2x 旁加 SVG 臨時設定，從 ZIP 取出 18 MB 的 SVG，約 4.2 秒。每次都選回原本的 frame，設計師的 PNG 2x 不變，下載資料夾沒有新增檔案 |
| Arc 原始 ZIP | 只經 bridge 要求同樣的匯出，取得 15 MB 的 `Sample App.zip`；Figloo 解出的項目名稱與大小，和 Python `zipfile` 讀到的一致 |

## 測試中發生的問題

- 舊的邏輯假設新設定加在最後。在 Arc 測試時，它把 frame 上設計師的 PNG 2x 當成臨時設定刪除，只留下臨時的 PNG 1x。檢視者無法寫回檔案，所以推測只影響當時的畫面。之後在同一個工作階段把 frame 還原成單一的 PNG 2x。
- 診斷時送出的 Escape 讓 Figma 取消了選取。之後已選回 frame，並移除多出的設定。

## 未驗證

1. 備援的下載路徑。直接交付在所有實測中都成功，所以沒有走到備援。
2. 圖層名稱含 `/` 時是否也會打包成 ZIP。
3. 設計師設了同格式的多組倍率，例如 PNG 1x、2x、3x 時，ZIP 內的檔名是否會重複。
4. PDF 與 JPG 匯出。
5. 臨時設定是否只存在目前的工作階段。重新整理分頁後設計師的設定仍是 PNG 2x，但重新整理前畫面上也是 PNG 2x，所以無法據此確認。
