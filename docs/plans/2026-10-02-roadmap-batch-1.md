# Roadmap 第一批：CI、快照摘要、批次匯出、診斷、分段快照、快照 diff、畫面還原

日期：2026-10-02
狀態：使用者已於 2026-10-02 核准，實作中
依據：與 plugin 型 Figma MCP 伺服器的比較後，使用者選定的第 1、2、3、4、5、11、10、12 項
來源：plan mode 的企劃，核准後原樣複製到此

## 情境

比較 plugin 型 Figma MCP 伺服器時，Figloo 有幾處明顯不足：

- 發版全靠手動，repo 公開後也沒有 CI。
- 拿不到檔案層級的設計系統資料，例如 styles 與元件清單。
- 匯出一次只能處理一個圖層。
- 沒有讓使用者回報問題的管道。

另外還有三個既有限制：快照上限 400 層、設計稿更新後無法知道改了哪裡、`capture` 與快照會改變使用者的縮放。這一批在不改變現有範圍（檢視權限、只讀 DOM、不編輯設計）的前提下補上這些項目。

## 使用者的決定，2026-10-02

1. 推 `vX.Y.Z` tag 後，由 GitHub Actions 直接發佈 release，不建草稿。
2. 過期的快照保留 30 天，當作 diff 的比對基準。
3. 超過 400 層的快照採「同一個快照續讀」：同一個 ref 再呼叫一次就接著讀，最後得到一份完整快照。
4. 縮放還原只接受完整還原（縮放比例加上畫面位置）；做不到就把驗證結果寫進文件，不實作。

## 讀程式碼後的修正

- **第 3 項：** 快照裡的 `selection_hierarchy`（Parent component）是外層元件，不是 instance 的主元件。本機三份快照中，instance 的這個欄位不是空的，就是同一個外層元件。所以改為依 instance 的圖層名稱分組（Figma 預設以主元件命名 instance），並附上元件屬性的組合。讀取主元件名稱不在這批範圍內。
- **第 4 項：** extension 的圖層索引只在單次頁面載入內有效。頁面重新載入後，來自快取快照的 ref 找不到，`inspect_nodes`、`capture`、`export_asset` 都會回 `NODE_NOT_FOUND`。現有測試認定這些操作可行，但實際上沒有覆蓋到重新載入的情況。批次匯出要先補上這個基礎。
- **第 1 項：** checksum 只寫在 release 說明的 Files 表格裡，`docs/agent-install.md` 依這個表格核對。zip 每次打包都不同，所以表格必須由 CI 用實際上傳的檔案計算。
- **偶發失敗的測試：** `handover.test.ts` 的「takes over on its own when the holder exits」在伺服器送出 welcome 時就斷言，但 fake extension 要晚一個 event loop 才收到。這是測試本身的競態，不是產品程式的錯。

## 里程碑

每個里程碑完成後先不 commit，回報結果，等使用者同意後再 commit 並 push 到 main（沿用先前的做法）。

### M1：CI 與自動發版（第 1 項）

- **修好偶發失敗的測試：**
  - `handover.test.ts:131-133` 改為等 extension 端收到 beta 的 welcome 再斷言。
  - `apps/mcp/test/helpers.ts` 的 `runReconnectingExtension.stop()` 取消待重連的計時器，`connect()` 也要檢查 `stopped`。
  - 先以迴圈重複執行重現失敗，修正後連跑 100 次都不失敗。
- **`.github/workflows/ci.yml`：**
  - 在 push 到 main 與 PR 時執行，使用 `ubuntu-latest`。
  - `pnpm/action-setup` 讀 `packageManager`，`setup-node` 讀 `.node-version`。
  - 依序執行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm typecheck`，最後 `pnpm -r --workspace-concurrency=1 test`。測試依序跑，降低對時間敏感的測試失敗的機率。
  - 權限只開 `contents: read`。
  - actions 以 commit SHA 固定版本，實作時再查證各 action 目前的最新版本。
- **`scripts/package.mjs`：** 加上版本一致性檢查，涵蓋 manifest、三個 `package.json`、`plugin.json` 的版本與 `.mcpb` 網址。傳入 `--tag vX.Y.Z` 時一併核對 tag。
- **`scripts/release-notes.mjs`（新）：** 產生 release 說明。
  - 內容依序是 CHANGELOG 中該版本的段落、固定的 Install 與 Upgrading 說明，以及 `## Files` 表格。
  - 表格沿用現有格式：`` | `figloo-extension-X.zip` | `<sha256>` | ``，雜湊由實際要上傳的檔案計算。
- **`.github/workflows/release.yml`：**
  - 推 `v*` tag 時執行：測試、打包（核對 tag）、產生說明，再用 `gh release create` 一次發佈。
  - 標題為「Figloo X.Y.Z」，三個檔案明確列出檔名上傳。發佈正式版，不建草稿、不標 prerelease。
  - 另提供 `workflow_dispatch` 演練模式：不發佈，只把說明與檔案存成 artifacts。
- **README（en／zh-TW）的 Development：** 補上發版步驟：
  1. 更新版本號與 CHANGELOG。
  2. 在本機跑 `pnpm test:release`。這個測試需要 Figma 連結，CI 無法執行。
  3. 一起 push main 與 tag。
- **驗證：**
  - 本機跑完整測試，並重現與修正偶發失敗。
  - push 後 GitHub CI 通過。
  - 在 GitHub 跑一次演練，確認說明中的雜湊與 artifacts 一致，格式也與 v0.3.2 相同。
  - 真正的發版留到 M8。

### M2：快照摘要 `summarize_snapshot`（第 2、3 項）

- **新工具，只讀快照檔，不碰 Figma。**
  - 參數：`snapshot`，以及可選的 `under`，只摘要某個區塊。
  - 結果：
    - `colors`：值與不透明度、用途（fill、text、border、shadow）、次數、最多 5 個範例 ref。
    - `typography`：字型、字重、樣式、字級、行高、字距的組合。
    - `gap`、`padding`、`radii`、`borders`（線寬）、`shadows`。
    - `components`：instance 依名稱分組，附元件屬性組合與次數。
    - `hiddenSkipped`、`truncated`。
  - 數值一律照 Figma 顯示的原樣。間距、圓角、線寬依數值排序，其他依次數排序。結果控制在 32 KiB 以內，超過時先減少範例、再截短清單。
- **檔案：**
  - `apps/mcp/src/snapshot-summary.ts`（純函式），在 `snapshot-tools.ts` 註冊。
  - protocol 的 output schema。
  - 重新產生 `docs/mcp-tools.md`。
  - skill 第 5 步改為先呼叫這個工具；更新 `references/snapshot-outline.md`。
  - README 工具表（兩種語言）與 CHANGELOG 的 Unreleased。
- **驗證：**
  - 單元測試涵蓋文字分段（`typographyN`）、各角圓角、排除隱藏圖層與截短。
  - 用 stdio 腳本對本機三份真實快照執行，結果小於 32 KiB，數量與另外統計的結果一致。

### M3：批次匯出 `export_assets`，與重新載入後仍可用的快照 ref（第 4 項）

- **快照 ref 在重新載入後仍可用：**
  - `read_subtree` 回傳 `rootPath`（root 從頂層往下的祖先 ref），存進快照檔。這是可選欄位，不改 `SNAPSHOT_FORMAT_VERSION`。
  - MCP 的 context 記下快照圖層的 parent 鏈。所有需要 ref 的操作（inspect、capture、export、neighbors、snapshot）都帶上 `known`（從頂層到目標的 `{ref, parentRef}`）。
  - extension 用單一的 `seed()`，補上索引中沒有或缺少 parent 的項目（`rowIndex: 0`）。`LayerTree.find()` 經由 parent 找到列後，要記錄下來。
- **`snapshot_layer` 放寬 ref 檢查：** 這個檔案有已存的快照（未過期，或仍在 30 天保留期內）時，接受 context 裡沒有的 root ref。這樣頁面重新載入後，新的 context 也能接回原本的快照。
- **新工具 `export_assets`：**
  - 參數：`contextId`，加上 `refs`（最多 50 個）或 `snapshot`（可加 `under`，匯出所有有匯出設定的圖層）；`saveTo` 為必填的資料夾；另有可選的 `format`、`scale`、`overwrite`。
  - 依序沿用現有的 export op。每次呼叫最多 150 秒，超過時回傳 `remaining`，讓 agent 接著呼叫。
  - 同一批中檔名相同時，加上 ref 後綴；既有檔案需要 `overwrite` 才會覆蓋。
  - 不回傳 inline 圖片。遇到 `TAB_IN_BACKGROUND` 或 `USER_INTERRUPTED` 就停下並回報；其他錯誤記下後繼續下一個。
  - 共用的匯出流程從 `export-asset.ts` 抽出。
- **protocol：** `PROTOCOL_VERSION` 從 0.2.0 升到 0.3.0。這一批只升這一次，版本不符的組合會以 `PROTOCOL_MISMATCH` 明確失敗。
- **驗證：**
  - 單元測試涵蓋：依序匯出、時間預算與 `remaining`、檔名衝突、覆蓋、停止條件、`known` 的內容、seed 之後的 `find`（以 `fake-layers` 測）。
  - Arc 實測：
    1. 從真實快照匯出所有有匯出設定的圖層，至少 10 個。
    2. 重新載入 Figma 分頁，用快取的快照再匯出一次。
    3. 確認沒有下載提示、臨時設定已移除、選取已還原。

### M4：診斷資訊與 issue template（第 5 項）

- **popup：**
  - 頁尾加上「Copy diagnostics」，任何狀態都能用，包括 service worker 連不上時；複製前先預覽內容。
  - 診斷內容由 `apps/extension/src/diagnostics.ts`（純函式）依白名單組成。
  - service worker 提供：protocol 版本、伺服器版本與伺服器 protocol 版本（改為從 welcome 保存）、最近 10 次操作錯誤（op、code、時間）、probe 的額外欄位。
- **絕不包含：** URL、分頁標題、file key、檔名、頁面與圖層名稱、session 的專案名稱、錯誤訊息全文、配對 token。
- **`.github/ISSUE_TEMPLATE/bug_report.yml`：** 欄位包括問題描述、重現步驟、診斷資訊、coding agent、瀏覽器與 Figma 設定，並提醒不要貼上 Figma 連結。
- **文件：** README（兩種語言）的 popup 與疑難排解段落、相容性文件中 popup 那一列。
- **驗證：**
  - 單元測試：在各種狀態下，把所有不安全的欄位填入哨兵值，確認輸出中都沒有出現。既有 popup 的選擇器不變。
  - Arc 實測：由使用者複製診斷資訊貼回來，我確認其中沒有檔名或圖層名稱。

### M5：分段快照續讀（第 11 項）

- **總上限：** 從 400 層提高到 2,000 層，核准時可調整。
  - 每次呼叫都會：縮放到 root、重新走一遍結構、從上次停下的地方繼續讀，直到接近時間預算。
  - 預留的時間為 5 秒加上每個已展開列約 100 毫秒，用於收合。
  - 預估每次可讀約 750 層，2,000 層約需 3 次呼叫。
- **extension：**
  - `readSubtree` 收到 `resume` 時才會回傳 `status: "partial"`，讓舊版 MCP 永遠不會收到半份結果。
  - 每個圖層都攔下 `time_budget` 與 `scan_budget`，改為回傳已讀的部分；`user_interrupted` 照舊拋出。
  - 回傳半份結果時，如果分頁在背景，改用 `putBackLater`；`BackgroundPause` 改用軟性截止時間。
  - 以 `ref|parentRef` 的序列核對結構，不符就從頭讀，並標示 `restarted`。
  - `boundsInRoot` 接受先前已定位的祖先：先放進 `byId` 與 `placed`，再由這次的量測覆蓋。
  - 收合失敗時，留在 `Explorer` 等待下次收合的列。
  - `INDEX_LIMIT` 提高到 50,000。
  - 遮罩顯示整體進度。
  - service worker 把新參數傳下去；續讀時不因截圖檢查而失敗，因為那次的截圖不會保留。
- **MCP：**
  - 讀取中的快照存成 `<root>.partial.json/.jpg`，與完整檔分開，讓 diff 的基準不會被覆蓋。第一次呼叫的截圖與對齊資訊一起保留。
  - partial 檔有自己的期限與清理；`refresh: true` 會捨棄 partial。
  - 輸出加上 `complete` 與 `progress`；讀完才回傳截圖與大綱。
  - 對讀到一半的快照呼叫 `query_snapshot` 或 `summarize_snapshot`，回 `SNAPSHOT_INCOMPLETE` 並提示繼續讀。`SUBTREE_TOO_LARGE` 只在超過總上限時出現。
- **文件：** skill 第 3 步、README 提到 400 的地方、工具文件。
- **驗證：**
  - 單元測試涵蓋：超過 400 層的走訪、續讀位置、結構不符時重讀、帶入祖先的定位、背景中結束、MCP 的合併與檔案。
  - Arc 實測：用超過 1,000 層的圖層（以 `explore_page` 在私人測試檔中尋找）。如果找不到，就由測試腳本縮短每次的時間預算，讓約 280 層的 frame 分成兩次以上讀完。分段讀出的快照與一次讀完的快照比對：ref 完全相同，位置誤差在 1 px 以內。

### M6：快照 diff（第 10 項）

- **何時比對：** 重新讀完一份完整快照，而且前一份完整檔存在（未過期，或過期未滿 30 天）時，計算 `added`、`removed`、`changed`。
  - `changed` 的面向：name、type、hidden、moved（parent 改變）、bounds（差 1 px 以上，忽略來源）、layout、appearance、typography、content、component、exports。
- **輸出：**
  - 比對結果存入新檔的 `changes`。
  - `snapshot_layer` 的輸出加上摘要與被刪除圖層的清單。
  - 大綱加上 `[new]` 與 `[changed: …]` 標記。
  - `query_snapshot` 新增 `changed: true` 篩選。
- **保留與清理：** 完整檔在過期 30 天後清除；不改格式版本，新欄位都是可選的。
- **驗證：**
  - 單元測試涵蓋各面向、位置的微小抖動、保留期限、以過期檔為基準。
  - Arc 實測：同一個 root 在設計沒變的情況下連續 refresh 兩次，結果應為 0 個變更，用來檢查誤報。
  - 檢視權限無法改設計，真正的變更由「修改真實快照副本」的單元測試涵蓋。

### M7：縮放與畫面還原（第 12 項，先驗證可行性）

- **可行性試驗（Arc，AppleScript 環境）：**
  - 合成的 wheel 事件能不能平移畫布？
  - ctrl+wheel 或縮放選單的輸入框，能不能精確設定縮放？
  - 以一個參考圖層在操作前後的 mirror 位置，反覆修正到原位，準確度如何？
- **通過條件：** 在 5 個不同的畫面中，縮放標籤完全相同，參考圖層的位置誤差在 2 個螢幕像素以內，而且在 2 秒內完成。
- **通過：** 在 `capture` 與每次快照呼叫的前後，記錄並還原畫面，輸出加上 `viewRestored`，更新工具說明與已知限制第 2 條。
- **不通過：** 把結果寫進相容性文件，不實作。

### M8：發佈 0.4.0（使用者同意後）

- 依版本規則這批是新功能，所以升 minor：更新三個 `package.json`、manifest、`plugin.json`，並寫 CHANGELOG 段落。
- 在本機跑 `pnpm test:release`，然後一起 push commit 與 tag，由 CI 發佈。
- **驗證：**
  - release 頁面有三個檔案，表格中的雜湊與檔案一致。
  - `releases/latest` 指向 0.4.0。
  - `agent-install.md` 的流程與 plugin 的 `.mcpb` 下載都能用。

## 共通規則

- 每個里程碑都要跑 `pnpm build && pnpm typecheck && pnpm test`，工具文件同步更新。
- 有 Arc 實測的里程碑，另寫一份 `docs/compatibility/` 驗證紀錄，並更新相容性 README。
- Arc 實測時改用 stdio 腳本，在 47130 port 啟動新版伺服器，由使用者在 extension 設定頁切換 port，結束後再切回。重新 build 後，請使用者重新載入 extension。
- 每次 commit 前檢查，不能出現私人測試檔的檔名、連結或產品名稱。
- 每個里程碑都在 CHANGELOG 的 Unreleased 補上條目。

## 風險

| 風險 | 緩解 |
|---|---|
| CI 的 runner 比本機慢，對時間敏感的測試失敗 | 測試依序執行；先修好已知的競態；新的失敗先查原因，不放寬斷言 |
| 續讀時每次重走與收合的時間太長 | 實測後若太長，改成不展開已讀完的子樹 |
| 批次匯出觸發瀏覽器的多重下載保護 | 直接交付路徑不經瀏覽器下載；退回下載路徑失敗時停下並回報 |
| diff 因位置的微小抖動而誤報 | 位置差 1 px 以上才算變更、忽略來源；Arc 上做無變更的 refresh 驗證 |
| 畫面還原做不到 | 依決定 4 只寫文件 |

## 預設值（核准時可調整）

- 分段快照的總上限：2,000 層。
- `export_assets` 每次最多 50 個 ref、150 秒。
- 診斷資訊的錯誤紀錄：最近 10 次。
