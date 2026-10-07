# 登入版 canary

狀態：完成，在本機手動執行；使用者決定不排程
日期：2026-10-07
起因：每日的訪客 canary 無法選取圖層，所以碰不到屬性面板、匯出與快照，而 0.4.1 壞掉的正是匯出區塊

## 做法

- 只在維護者的電腦上執行，不放進 CI，所以 GitHub 上沒有任何帳號資訊。
- 使用專用的 Figma 測試帳號，以使用者的分身信箱註冊，顯示名稱中性。這個帳號沒有被加進測試檔的分享清單，而是開啟公開連結取得檢視權限。
- 瀏覽器 profile 放在 `~/.figloo/canary-profile`，權限 700。`tests/canary/login.mjs` 在視窗中開啟這個 profile，由使用者自己登入或調整偏好設定，腳本不輸入任何資料。macOS 上關掉最後一個視窗不會結束瀏覽器，所以腳本以分頁數歸零判斷視窗已關閉。
- 測試帳號開啟了「Adapt content for screen readers」。
- 測試檔的連結放在 git 忽略的 `tests/integration/.env.local`，鍵名是 `FIGLOO_CANARY_FIGMA_URL`。連結的 `node-id` 指向要拍快照的 frame，Figma 開啟時會選取它，所以 `get_anchor` 不需要另外設定。
- 輸出只有 ref、數量與錯誤碼。

## 檢查項目

1. 分頁在兩分鐘內就緒，`access` 是 `view`（`guest` 代表 profile 已登出）、`READY`，並且有 screen reader mirror。
2. `get_anchor` 讀到連結指向的 frame。
3. 頁面上每個有子層的 frame，`get_neighbors` 都讀得到子層，而且沒有中途停下，包括有「Fixed」與「Scrolls」分組標題的 frame。
4. 對錨點拍快照：沒有讀不懂的部分、至少一層有匯出設定、截圖位置經 mirror 確認、畫面已還原。
5. `inspect_nodes` 讀快照的前 5 層：每層都有區段、沒有讀不懂的區段、選取已還原。
6. 以設計師的設定匯出第一個有匯出設定的圖層，至少交回一個非空的檔案。
7. `capture` 交回 JPEG，畫面已還原；`get_visual_neighbors` 沒有錯誤。

## 驗證

| 項目 | 結果 |
|---|---|
| 探查：15 個頂層 frame 各拍一次快照 | 全部完成，`unreadableLayers` 都是 0。匯出設定在 frame 0:2 的 0:44。當時測試帳號還沒開 mirror，所以截圖位置 `unconfirmed`、畫面沒有還原 |
| repo 建置的版本，開啟 mirror 之後 | 通過，22 秒：17 個 frame 的子層、0:2 的 39 層快照（1 層有匯出設定，截圖位置 `confirmed`，畫面已還原）、5 層的屬性、0:44 的 PNG 匯出、截圖、8 個相鄰圖層 |
| 0.4.3 的 release 檔 | 通過，21 秒 |
| 反向檢查：0.4.1 的 release 檔 | 如預期失敗在 `children of 0:78 are listed (got 0, ui_timeout)`，也就是 0.4.2 修正的分組標題問題 |

## Figma 的使用政策

Figma 的服務條款引用的可接受使用政策（2026-08-19 版），禁止抓取或有系統地擷取大量內容、探測服務的弱點或限制，以及超出負載。canary 一天最多一次，只讀使用者自己公開檔裡的少量圖層，不改動任何東西；判斷為低風險，最壞情況是測試帳號被停用，使用者的主帳號不受影響。使用者同意以這種方式進行。

## 執行時機

使用者決定不設定每天的排程，改為需要時手動執行，例如發版前、改動選取後才用得到的功能之後，或有人回報 Figma 改版時。

## 未知

- 登入狀態過期時，canary 會回報 `access` 是 `guest`，這時要用 `login.mjs` 重新登入。過期的週期未知。
