# Popup 的診斷資訊與 bug report 表單

狀態：實作完成，在使用者的 Arc 上確認複製出的內容不含設計資訊  
日期：2026-10-02  
範圍依據：[Roadmap 第一批](../plans/2026-10-02-roadmap-batch-1.md)的 M4

## 內容

| 項目 | 內容 |
|---|---|
| 「Diagnostics」 | Popup 頁尾的按鈕。展開後先顯示報告，再用「Copy diagnostics」複製；service worker 沒有回應時，仍會給出 popup 自己知道的版本與瀏覽器 |
| 報告內容 | 擴充功能與 protocol 的版本、固定的 extension ID 是否相符、瀏覽器、與 MCP 伺服器的連線（port、伺服器版本與 protocol、agent 名稱、最後一次錯誤的錯誤碼）、最近一次交接、Figma 設計分頁數、目前分頁的就緒狀態與找到的 Figma 介面元素，以及最近 10 次操作錯誤的錯誤碼與時間 |
| 不含 | 網址、分頁標題、file key、檔名、頁面與圖層名稱、session 的專案資料夾名稱、錯誤訊息全文、配對 token |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 要求貼上診斷資訊，並提醒不要貼 Figma 連結、不能公開的設計截圖與 token |

## 做法

- Service worker 以 `buildDiagnostics` 依白名單挑出欄位，交給 popup 的就只有這個物件；popup 以 `formatDiagnostics` 排成文字。兩者都是純函式。
- 連線的最後一次錯誤只保留錯誤碼，例如 `UNAUTHORIZED`、`4001 PROTOCOL_MISMATCH`、`cannot reach the MCP server`。
- 操作錯誤只記 op、錯誤碼與時間。

## 驗證

| 項目 | 結果 |
|---|---|
| 單元測試 | 把哨兵字串放進網址、標題、file key、檔名、專案名稱、錯誤訊息與 token 的位置，物件與文字中都找不到；錯誤碼的萃取、各種連線狀態的文字、最多 10 筆錯誤 |
| Arc 實測 | 使用者從 popup 複製的報告共 8 行：版本、瀏覽器、已連線的 47130 port 與伺服器版本、分頁狀態、介面元素與一筆最近錯誤，沒有任何檔案、頁面或圖層名稱與連結 |
| 最近錯誤 | 測試伺服器在擴充功能剛重新連線時匯出一次，當時 Figma 分頁不在畫面上，報告正確記為 `export_asset TAB_IN_BACKGROUND` |
| Popup 大小 | `popup.js` 約 10 KB，沒有帶入 zod |

## 未驗證

- Service worker 沒有回應時的報告，只由單元測試涵蓋。
- GitHub 上的 issue 表單要 push 後才看得到。
