# 頁面快照：MCP 工具與完整路徑

狀態：第二與第三階段完成。經由 MCP 伺服器、bridge、service worker 與 content script 的完整路徑，已在 Arc 上驗證  
日期：2026-10-01  
規劃：[頁面地圖與快照](../plans/2026-10-01-page-map-research.md)；分頁內的讀取見[第一階段的紀錄](2026-10-01-page-snapshot-phase1.md)

## 工具

| 工具 | 用途 |
|---|---|
| `snapshot_layer(contextId, ref, refresh?)` | 截取 root，讀取整棵子樹並存成快照檔，回傳截圖、snapshot id 與每個圖層一行的大綱。未過期的快照直接從檔案回傳，不操作 Figma |
| `query_snapshot(snapshot, refs?, text?, type?, under?, details?, cursor?)` | 只讀快照檔，依 ref 取得完整內容，或依名稱與文字、類型、所在的圖層篩選，分頁回傳 |

完整的參數與回傳欄位見 [mcp-tools.md](../mcp-tools.md)。

## 快照檔

- 位置：`~/.figloo/snapshots/<檔案 key>/<root ref>.json`，截圖是同名的 `.jpg`；ref 的冒號換成連字號。資料夾權限 700、檔案 600。
- snapshot id 是 `<檔案 key>/<root ref>`，例如 `AbCd/570-14192`，直接對應到路徑；不符合這個格式的 id 視為不存在，所以不會讀到快照資料夾以外的檔案。
- 檔案帶格式版本，版本不符時視為沒有快照。
- 有效期限預設 24 小時，可用 `~/.figloo/config.json` 的 `snapshotTtlHours` 調整。寫入新快照時，同一個檔案 key 底下已過期的快照會一併刪除。
- 278 個圖層的快照約 215 KB，截圖約 300 KB。

## 大綱

每個圖層一行，依序是縮排、ref、類型、名稱、`x,y`、`寬×高`。位置與大小是相對 root 左上角的設計稿像素，Figma 沒有提供位置時寫成 `?,?`。文字內容和名稱不同時，附上內容的開頭；最後是 `[hidden]`、`[has layers]`（有子層的 instance）與 `[export PNG 2x]` 等標記。

278 個圖層的大綱與其他欄位合計約 17.9 KB，在 32 KiB 的上限內。超過上限時大綱會截斷，並附上 `nextCursor` 交給 `query_snapshot` 接著讀。

## 實測

環境：Arc 1.166.0，已登入、檢視權限，英文 UI，使用者提供的私人測試檔，和第一階段同一個 393×852 的頂層 frame。以腳本透過 stdio 啟動建置好的 MCP 伺服器並呼叫工具，伺服器以 bridge 連到 Arc 裡重新載入過的 extension。

| 項目 | 結果 |
|---|---|
| `snapshot_layer` | 278 個圖層，34.7 秒，其中走訪 4.5 秒；UI 操作 494 次 |
| 截圖 | 748×1568；root 在圖中的位置是 (22.7, 22.7)，也就是四周 12 px 的邊距乘上圖片比例；每個設計稿像素等於 1.7853 個圖片像素 |
| 位置對到截圖 | 把 9 個 auto layout、instance 與文字圖層的位置換算後畫在截圖上，框線都落在對應的元素上；文字的框包含行高 |
| 快照期間的其他操作 | `get_anchor` 與 `list_pages` 分別在 3 ms 與 6 ms 內回傳 `BUSY`，不必排在快照後面等候 |
| 結束後 | 選取還原成開始前的圖層；畫面維持縮放在 root |
| 第二次呼叫 | 從快照檔回傳，5 ms，沒有操作 Figma |
| `query_snapshot` | 類型篩選找到 55 個文字圖層；大綱中 33 個隱藏、16 個帶匯出設定；依 ref 取得完整內容；`under` 篩選 |
| 整合測試 | `get-status.e2e.mjs` 與 `explore.e2e.mjs` 以訪客分頁走完，包含經由 service worker 帶回 `crop` 的整頁截圖 |

## 截圖裁切的修正

第一次走完整路徑時，截圖只有 107×1568，拍到的是 root 右邊相鄰的畫面，root 不在圖中。

原因：按下 Shift+2 之後，縮放比例的標籤在 30 到 80 ms 內就更新，但 mirror 裡的圖層位置維持原樣，約 520 到 550 ms 後才一次跳到新位置，中間沒有過渡。原本的做法是等標籤改變後，取樣到兩次相同、而且大小與「面板的寬高乘上新的縮放比例」相差不到 10% 的位置。開始前的縮放比例接近新的比例時，例如 100% 變成 93%，舊位置的大小也在 10% 以內，就被當成新位置。這是既有 `capture` 的問題，`capture` 工具也會遇到。

修正：按下 Shift+2 之前先記下圖層在 mirror 裡的位置，之後等它真的移動，最多 1.5 秒；圖層原本就在定位時沒有東西會移動，等滿 1.5 秒。截圖本來就要等約 3 秒讓縮放的提示框消失，所以 `capture` 的時間沒有明顯變長，兩種情況實測都約 3.5 秒。

| 開始前 | 修正前的裁切 | 修正後的裁切 |
|---|---|---|
| 停在同尺寸的相鄰畫面，93%，只需平移 | 正確，四周 12 px | 正確，四周 12 px |
| 停在同尺寸的相鄰畫面，100% | 偏離 root：左側多出 118 px，右側少了 396 px | 正確，四周 12 px |

只需平移時，舊做法剛好因為縮放標籤沒變、等滿 1.5 秒而沒出錯。

另外，快照會檢查 root 是否完整落在截圖裡；沒有的話回報 `UI_NOT_READY`，請 agent 重新建立快照，不交出錯位的截圖。

## Popup

只選取一個圖層，而且它是畫布上或 section 中的 Frame 或 Auto layout、不在 instance 裡時，複製的提示改成「I want to implement the Figma page I selected」的版本，請 agent 先呼叫 `get_anchor`，再呼叫 `snapshot_layer`。畫面裡的卡片這類 frame，以及沒讀到上層路徑的 frame，維持原本的提示。這部分有單元測試，popup 的實際畫面未在 Arc 上看過。

## 觀察到的既有限制

- 截圖對位偶爾會偏移。2026-10-02 在 Claude Code 中直接呼叫 `snapshot_layer` 時，截圖上方多了 frame 的名稱、下方少了一截，`rootInImage` 比畫面上的 root 高了約 33 個 CSS 像素。原因是 mirror 給的 root 絕對位置比實際高了 33 px：縮放時偏移一直存在，取消選取再重選也沒有消失，選取另一個頂層 frame 再選回來才恢復。捲動畫布、縮放與重新載入分頁都會讓 mirror 正確更新，所以觸發條件尚未查明。大綱中的位置是圖層之間的相對位置，因為所有圖層一起偏移而不受影響；受影響的是截圖的裁切與 `rootInImage`，`capture` 的裁切也依賴同一個位置。

## 截圖對位的確認

針對上面的問題，`snapshot_layer` 不再只相信 mirror：worker 保留未裁切的整張截圖，讀取結束後檢查 mirror 給的 root 外框。外框外側 3 px 應該是畫布的單一顏色，內側 3 px 則不是。

- 符合：`image.alignment` 為 `confirmed`。
- 不符合：在 100 CSS px 內平移尋找最符合的位置，再用離邊緣 1 與 2 px 的取樣挑出正確的像素；找到後以新位置重新裁切，`alignment` 為 `corrected`。
- 找不到可信的位置，例如 root 帶有陰影或周圍沒有畫布時：保留 mirror 的位置，`alignment` 為 `unconfirmed`。

驗證：

| 項目 | 結果 |
|---|---|
| 單元測試 | 合成截圖 5 項：mirror 位置正確時確認；過時 66 px 與斜向偏移時修正到正確像素；不會跳到相鄰的畫面；帶陰影時只會確認或修正到正確位置的 1 px 內，否則不動；周圍沒有畫布時不動 |
| 2026-10-02 那張對位錯誤的截圖 | 以 mirror 的錯誤位置為起點，找到往下 63 個圖片像素的位置，約 158 ms；預期約 64，差的 1 px 是因為那張截圖底部已被裁掉，少了一邊可以參考。畫出外框後與 frame 的上緣貼齊 |
| Arc，重新載入 extension 後在 Claude Code 中呼叫 | 198 個圖層 28.8 秒；截圖 748×1568，`rootInImage` 為 (22.9, 22.8)，四周各留 12 CSS px，frame 的四邊都在圖中。這個工作階段的 MCP 是舊版，輸出中沒有 `alignment`，所以看不到是確認還是修正，兩者都會得到同樣的裁切 |

快照檔的格式因此升到第 2 版，舊的快照視為不存在。
- 使用者的選取藏在收合的群組裡時，`get_anchor` 回報 `NO_SELECTION`。其他工具結束時也無法還原這個選取，會改成取消選取。這次是先由 `explore_page` 取得 root，再建立快照。

## 未驗證

1. 接近 400 個圖層的子樹，以及接近 180 秒的情況。
2. 讀取中 Figma 分頁切到背景時的中止。
3. Section 在圖層面板上的類型標籤是否為 "Section"；不是的話，section 中的畫面會得到一般的提示。
4. Codex 的 `tool_timeout_sec` 設定未實際以 Codex 執行。
5. 新版 MCP 輸出的 `alignment` 值。2026-10-02 已在 Claude Code 工作階段中直接呼叫 `get_anchor`、`snapshot_layer` 與 `query_snapshot`，但那個工作階段的 MCP 在加入 `alignment` 之前就已啟動，桌面版也無法重新連線。
