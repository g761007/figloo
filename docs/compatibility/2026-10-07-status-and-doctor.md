# 分頁限制、錯誤分類、介面依賴清單與 doctor

狀態：完成，0.5.0
日期：2026-10-07
依據：[v0.5.0 計畫](../plans/2026-10-07-v0.5.0-reliability-dx.md)的 M1 到 M5

## 內容

| 項目 | 做法 |
|---|---|
| 錯誤分類 | `apps/mcp/src/errors.ts` 一份表涵蓋每個錯誤碼：類別、`retry`（`yes`、`after_user`、`no`）與 hint。原本三份 hint 表的文字不變 |
| 分頁限制 | `get_status` 的每個分頁有 `limitations`：`UI_MINIMIZED`、`GUEST`、`EDIT_ACCESS`、`UI_CHANGED`、`NO_KEYBOARD_TARGET`、`NO_SCREEN_READER_MIRROR`、`NOT_ENGLISH`，各附受影響的工具與處理方式。介面縮到最小時只列這一項，因為其他部分都看不到。分頁在載入中或無法讀取時不列限制，由 `readiness` 說明 |
| 介面依賴清單 | `apps/extension/src/adapter/anchors.ts` 列出 probe 檢查的頁面元素，各標可靠度（stable、semantic、fragile），probe 與右側欄的判斷都從這裡取 selector。找不到的元素以 `missingAnchors` 回報；只有已登入卻找不到右側欄或屬性面板時，列為 `UI_CHANGED` |
| 版本不符 | bridge 拒絕 hello 時記下 extension 的版本與 protocol 版本；`get_status` 的 hint 寫出該更新哪一邊，token 不符時提示重新配對。伺服器的錯誤說明也寫出兩邊的版本，extension 的選項頁不再把它覆蓋成關閉代碼 |
| doctor | `figloo-mcp doctor` 檢查 Node.js、設定檔、token、檔案權限，以及連接埠由誰持有；`GET /holder` 多回報已連線的 extension 版本 |

## 驗證

| 項目 | 結果 |
|---|---|
| 單元測試 | extension 203 項、MCP 141 項、protocol 18 項全過。新增的斷言在對應的改動拿掉後都會失敗，例如工具錯誤的 `category` 與 `retry` |
| 訪客整合測試 | 兩個測試檔都通過，並確認訪客分頁回報 `GUEST` 限制、`inspect_nodes` 在受影響的工具中 |
| 登入版 canary | 通過，21 秒；新增的檢查確認登入的檢視權限分頁沒有找不到的元素，也沒有任何限制，所以清單與限制在真實的登入狀態下不會誤報 |
| doctor，使用者的電腦 | 第一次執行時，把 0.4.0 伺服器沒有回報 extension 狀態，誤判成「沒有 extension 連著」。改為區分「沒有回報」與「回報沒有」之後，對 0.4.0 的持有者列為注意事項，並建議改用 `get_status` 確認；這種情況也加了測試 |

## 未驗證

- `UI_CHANGED` 只以單元測試與 fixture 驗證，真實的 Figma 改版還沒遇過。
- `NOT_ENGLISH` 只以單元測試驗證，沒有在非英文介面實測。
- 在全新的環境照 README 的 Quickstart 安裝，並用 doctor 與 `get_status` 引導，是 M7，還沒做。
