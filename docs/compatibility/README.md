# 相容性與已知限制

最後更新：2026-10-07。各項結論的細節見文末各階段的驗證紀錄。

## 瀏覽器與作業系統

| 環境 | 狀態 | 依據 |
|---|---|---|
| Arc 1.166.0（Chromium 154），macOS 27.0 | 已驗證。已登入、檢視權限、英文 UI 下，全部工具、popup 與匯出的直接交付都跑通 | M1 到 M3、匯出、popup 與 M4 驗收紀錄 |
| Chrome for Testing 153.0.8010.12（Playwright，headless），macOS 27.0 | 自動化驗證。訪客分頁下的連線、分頁狀態、工具列圖示、頁面列舉、子樹、整頁截圖、popup 與錯誤處理 | 整合測試 |
| Chrome for Testing（Playwright，headless），Ubuntu，GitHub Actions | 自動化驗證，每天由 Figma canary 執行同一組訪客整合測試；2026-10-07 起 | `.github/workflows/figma-canary.yml` |
| Google Chrome 正式版 | 未驗證。Chrome 137 起不接受以命令列載入 extension，所以整合測試改用 Chrome for Testing；手動「載入未封裝項目」預期可用 | |
| 其他 Chromium 瀏覽器，例如 Edge 或 Brave | 未驗證 | |
| Windows 與 Linux | Windows 未驗證；Linux 只有 GitHub Actions 那一列的訪客整合測試。程式本身不依賴 macOS；打包需要 `zip` 指令 | |
| Figma 桌面 App | 不支援。Extension 只在瀏覽器中執行 | |

## Figma 條件

| 條件 | 狀態 |
|---|---|
| 已登入、檢視權限 | 目標情境，已驗證 |
| 訪客，未登入 | 有限。無法選取圖層，所以沒有錨點、屬性讀取與匯出；頁面列舉、進入頁面、子樹與整頁截圖可用 |
| 編輯權限 | 不在目標範圍。2026-10-07 在自己的檔案上實測，屬性面板讀不到：快照的屬性與匯出設定全部是空的，每層都等到逾時 |
| 英文 UI | 已驗證 |
| 其他 UI 語言 | 未驗證。圖層類型與屬性欄位依英文標籤解析 |
| 開啟「Adapt content for screen readers」 | 建議開啟。截圖依圖層在畫面上的位置裁切；未開啟時改以畫布中心推估，這種情況的效果未驗證。截圖與快照結束後還原縮放比例與畫面位置，也需要這項設定 |
| Figma UI 縮到最小 | 圖層面板不會渲染，狀態為 `DEGRADED`，需按 Cmd+\ 展開 |

## 功能

| 功能 | 狀態 | Figma 分頁需在畫面上 |
|---|---|---|
| `get_status` | 已驗證 | 否 |
| `list_pages` | 已驗證 | 否 |
| `explore_page` | 已驗證 | 切換頁面時需要 |
| `get_anchor` | 已驗證，包含多選 | 否 |
| `get_neighbors` | 已驗證，包括子層之間有「Fixed」與「Scrolls」分組標題的 frame | 展開收合的圖層時需要 |
| `get_visual_neighbors` | 已驗證，需要開啟「Adapt content for screen readers」 | 需要 |
| `inspect_nodes` | 已驗證 | 需要 |
| `capture` | 已驗證；結束後還原縮放比例與畫面位置，需要開啟「Adapt content for screen readers」 | 需要 |
| `export_asset` | 已驗證 SVG、PNG 與 JPG、設計師的設定、臨時設定與 ZIP，以及 2026-10 改版後的格式選單；PDF 未驗證 | 需要 |
| `export_assets` | 已驗證，12 個圖層一次匯出、從快照匯出、重新載入分頁後以快取的快照匯出；隱藏圖層跳過 | 需要 |
| `snapshot_layer` | 已驗證，278 個圖層約 35 秒；最多 2,000 層，讀不完時分次接著讀，以較短的時間上限驗證過分段讀取的結果與一次讀完的相同；需要開啟「Adapt content for screen readers」才能量到大部分圖層的位置。讀取期間顯示遮罩，可用「Stop」或 Esc 中止；設計沒變時重讀，比對出 0 個變更；結束後還原縮放比例與畫面位置 | 開始時需要；讀取中進入背景會暫停，回到畫面後繼續 |
| `query_snapshot` | 已驗證，只讀快照檔；`changed: true` 篩選只由單元測試涵蓋 | 否 |
| `summarize_snapshot` | 已驗證，只讀快照檔；以本機三份真實快照核對，顏色、文字樣式與 instance 的數量都與另外統計的結果相同 | 否 |
| 工具列圖示與 popup | 已驗證，包括「Diagnostics」複製的報告不含設計資訊 | 點圖示時分頁本來就在畫面上 |
| 多個 agent 工作階段的交接 | 已驗證，見驗證紀錄 | 否 |

## 已知限制

1. 改變選取、展開、縮放或切換頁面的操作，只在 Figma 分頁顯示在畫面上時有效。分頁在背景時會回報 `TAB_IN_BACKGROUND`，Figloo 不會把分頁帶到前景。讀取頁面、選取與已展開的圖層在背景也能用。`snapshot_layer` 例外：讀取開始後，分頁進入背景時會暫停等待，不會中止。
2. `capture` 與 `snapshot_layer` 會縮放畫面。結束後會還原選取；開啟「Adapt content for screen readers」時，也會還原縮放比例與畫面位置，結果寫在 `viewRestored`。未開啟這項設定、使用者在途中操作 Figma，或讀取結束時分頁在背景，畫面就不會還原。
3. Instance 內部圖層的 ID 只在單次頁面載入有效。重新整理後 context 會失效，這類圖層也沒有連結。
4. 同一時間只有一個 MCP 伺服器服務 extension。其他 agent 工作階段待命，需要 Figma 時在持有者閒置 10 秒後接手；持有者忙碌時回報 `BUSY`。Figloo 0.1.0 的伺服器不支援交接，需要重新啟動那個工作階段。
5. `inspect_nodes` 每次最多 5 個圖層，數值是屬性面板顯示的文字，不另外換算。
6. 匯出時 Figma 的檔名不含倍率後綴，多組設定會打包成 ZIP 再由 MCP 解開。備援的下載路徑可能被瀏覽器的多重下載保護擋下；直接交付在所有實測中都成功。
7. 使用者在操作途中動到 Figma 時，操作會中止並回報 `USER_INTERRUPTED`，面板也不再還原。`snapshot_layer` 例外：它一次展開很多圖層，所以中止時仍會收回，但保留使用者的選取；按遮罩上的「Stop」或 Esc 中止時，則完整還原圖層面板與選取。
8. 每次呼叫都有時間與操作次數的預算，超過時回傳部分結果並附續查資訊；`snapshot_layer` 則分次接著讀。超過 400 層的長圖層清單未在真實檔案上驗證。
9. 背景分頁裡的展開點擊究竟被丟棄還是延後執行，無法確認，所以在背景一律不送出。
10. `get_visual_neighbors` 只比較同一個父層的圖層。由 auto layout 決定位置的文字圖層，畫面與屬性面板都沒有它的位置，會列為未量測。
11. Mirror 偶爾會給出過時的絕對位置：2026-10-02 實測時，root 比畫面高了 33 px，直到選取另一個頂層 frame 才恢復，觸發條件未查明。`snapshot_layer` 會用截圖本身確認並修正 root 的位置，結果寫在 `image.alignment`；無法確認時標為 `unconfirmed`，`rootInImage` 可能偏移。大綱中的位置是圖層之間的相對位置，不受影響。`capture` 的裁切沒有這項確認。
12. Figma 不匯出隱藏圖層，也不匯出位在隱藏群組中的圖層，親手按 Export 也沒有反應。`export_asset` 會回報 `LAYER_HIDDEN`，`export_assets` 從快照匯出時會跳過它們。圖層面板以灰色標示隱藏圖層，instance 與其中的圖層則以最暗的紫色標示。

## 各階段驗證紀錄

- [M0：Figma DOM 可行性](2026-09-30-m0-figma-dom-findings.md)
- [M1：連線閉環](2026-09-30-m1-connection.md)
- [M2：局部探索](2026-09-30-m2-local-exploration.md)
- [M3：屬性讀取、截圖與頁面入口](2026-09-30-m3-inspect-capture.md)
- [匯出 icon 與圖片](2026-09-30-export-asset.md)
- [工具列 popup](2026-09-30-popup.md)
- [M4：交付與驗收](2026-10-01-m4-acceptance.md)
- [相鄰元件與多選錨點](2026-10-01-visual-neighbors-and-multi-select.md)
- [頁面快照第一階段：adapter 的完整讀取](2026-10-01-page-snapshot-phase1.md)
- [頁面快照：MCP 工具與完整路徑](2026-10-01-page-snapshot-tools.md)
- [多個工作階段的交接](2026-10-02-multi-session-handover.md)
- [讀取時的遮罩與背景暫停](2026-10-02-reading-overlay.md)
- [figloo-implement skill 與 Claude Code plugin](2026-10-02-figloo-skill.md)
- [`list_pages` 的頁面列表讀取](2026-10-02-pages-list.md)
- [批次匯出與重新載入後的快照 ref](2026-10-02-export-assets.md)
- [Popup 的診斷資訊與 bug report 表單](2026-10-02-diagnostics.md)
- [匯出區塊的新版格式選單](2026-10-06-export-format-select.md)
- [同格式多倍率時只交回要求的倍率](2026-10-06-export-scale-files.md)
- [圖層面板的「Fixed」與「Scrolls」分組標題](2026-10-07-section-header-rows.md)
- [分段續讀的快照](2026-10-02-resumable-snapshots.md)
- [快照的變更比對](2026-10-03-snapshot-changes.md)
- [截圖與快照後還原畫面](2026-10-03-view-restore.md)
