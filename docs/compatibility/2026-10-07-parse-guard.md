# 解析守門：讀不懂時明說

狀態：完成，並在使用者的 Arc 上驗證編輯權限的回報與檢視權限下沒有誤報
日期：2026-10-07
起因：0.4.1 時匯出區塊改版後，快照三天內都把匯出設定存成空的；0.4.2 的 Arc 實測又發現，編輯權限下快照的屬性全部是空的，59 層花了 100 秒

## 三種情況

| 情況 | 以前 | 現在 |
|---|---|---|
| 編輯權限：右側欄是 Design 面板，沒有檢視權限的屬性面板 | 每層等屬性面板 1.5 秒後放棄，快照照樣存檔，屬性與匯出設定全部是空的 | `get_status` 回報 `access: "edit"`、`DEGRADED`；`inspect_nodes`、`snapshot_layer`、`export_asset` 與 `export_assets` 在選取圖層之前就回報 `UI_NOT_READY` 並說明原因 |
| 匯出區塊有設定列，但 Figloo 解析不出來 | 當成沒有設定：匯出改走臨時設定，失敗後留下設定列；快照存成 `exports: []` | `export_asset` 在改動任何設定之前就回報；快照把那一層存成 `exports: null`、`exportsUnreadable: true` |
| 屬性區段有內容，但 Figloo 什麼都沒解析出來 | 區段的屬性、顏色與文字都是空的，看起來像沒有值 | 區段帶 `unreadable: true`；快照大綱標 `[unreadable: …]`，`snapshot_layer` 與 `summarize_snapshot` 回報 `unreadableLayers` |

另外，快照的根圖層一個區段都讀不到時，直接回報錯誤，不再存出沒有屬性的快照。

## 判斷方式

- **編輯權限**：右側欄的分頁有以 `Design` 開頭的一個（實際文字是 `DesignDesign`），而且沒有包含 `Properties` 的分頁。編輯權限下右側欄同樣有 `[data-testid="properties-panel"]`，所以 probe 原本的 `propertiesPanel` 分不出兩者。檢視權限的工具列標示（View only、Ask to edit、Request sent）仍然優先。
- **匯出設定列**：`[role="row"]` 中有輸入欄位或檔案類型控制項，卻找不到倍率欄位的值或檔案類型，就算讀不懂。兩份既有的匯出 fixture 都是一列、而且都讀得懂。
- **屬性區段**：只檢查 Figloo 會讀值的區段，也就是 properties、colors、borders、shadows、content、componentProps、selection_hierarchy 與 typography*。區段除了標題還有文字，屬性、顏色與文字卻都沒讀到，就算讀不懂。images 與不認得的區段不檢查。

## 驗證

| 項目 | 結果 |
|---|---|
| 單元測試 | 新增 16 項，改動前全部失敗：編輯權限的 probe 與 readiness；`inspect_nodes` 與 `prepareExport` 在 Design 面板下 500 ms 內回報；兩種檔案類型控制項下，倍率欄位改名或檔案類型讀不到時都算讀不懂，而既有 markup 一列都不算；改掉複製標籤的 properties 區段標成讀不懂，四份既有的屬性 fixture 沒有任何區段被標記；大綱的標記、`unreadableLayers` 的計數，以及摘要略過隱藏圖層的計數。extension 200 項與 MCP 128 項全部通過 |
| Arc，canary 檔，編輯權限 | `get_status`：`access=edit`、`DEGRADED`，說明寫出編輯權限。`get_neighbors` 照常讀到 18 個子層。`inspect_nodes` 4 ms、`export_asset` 8 ms 回報 `UI_NOT_READY` 與編輯權限的說明；`snapshot_layer` 4.6 秒回報，其中大部分是先截圖的時間，以前是 100 秒後存出空的快照 |
| Arc，使用者提供的私人測試檔，檢視權限 | 對 999:61586 重拍快照：203 層，`unreadableLayers=0`，大綱沒有 `[unreadable:` 標記，4 個圖層有匯出設定，與 2026-10-06 相同；與上一份快照比對 0 個變更，截圖位置 `confirmed`，23 秒。`inspect_nodes` 讀 5 層，每層 1 到 4 個區段，沒有讀不懂的。`export_asset` 不帶 format 時沿用設計師的 PNG 2x，1.8 MB |

## 未驗證

- 快照根圖層一個區段都讀不到時的錯誤：只有程式內的檢查，happy-dom 無法模擬快照的選取與 mirror，Arc 上也沒有這種情況可以重現。
- 「讀不懂」在真實改版時是否剛好命中：判斷方式是依目前的 markup 推想 Figma 可能怎麼改，只有用改過的 fixture 測過。
- 編輯權限下，Dev Mode 的屬性面板。使用者的帳號沒有 Dev 席位，所以只看過 Design 面板。
