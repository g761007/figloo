# Figloo 的 skill 與 plugin

日期：2026-10-02  
狀態：企劃，待 review；排在[多工作階段](2026-10-02-multi-session-handover.md)與[讀取時的遮罩](2026-10-02-reading-overlay.md)之後  
依據：使用者提議提供 skill，讓使用者搭配 Figloo 使用

## 背景

目前 agent 得到的指引有兩種：

| 來源 | 內容 | 不足 |
|---|---|---|
| 工具說明 | 每個工具做什麼、限制、錯誤怎麼處理 | 只講單一工具，不講整個工作要怎麼做 |
| Popup 複製的提示 | 檔案、分頁、選取的圖層，以及先呼叫哪個工具 | 只涵蓋開頭的一兩步 |

把設計稿實作成程式時，真正影響結果的是跨工具的工作方法：先看整體再看細節、把設計稿對應到專案既有的元件與 token、讀懂快照中的記號、依專案慣例切圖、做完後比對。這些適合寫成 skill。

## 已查證的事實（2026-10-02）

- Claude Code 的 plugin 可以同時帶 skill（`skills/<名稱>/SKILL.md`）與 MCP 伺服器（`.mcp.json`，路徑寫 `${CLAUDE_PLUGIN_ROOT}`），用 `claude plugin validate` 檢查，用 `claude plugin eval` 跑評估案例。`mcpServers` 也接受 `.mcpb` bundle 的檔案或 URL。
- Plugin 啟動的 stdio MCP 伺服器只會收到 `CLAUDE_PLUGIN_ROOT` 與 `CLAUDE_PLUGIN_DATA` 環境變數；`export_asset` 用來限定寫入範圍的 `CLAUDE_PROJECT_DIR` 要在 `.mcp.json` 的 `env` 裡以 `${CLAUDE_PROJECT_DIR}` 傳入。
- Codex 支援同樣格式的 `SKILL.md`（frontmatter 必須有 `name` 與 `description`），使用者層級放在 `~/.agents/skills`，repo 層級放在 `.agents/skills`；可以用 `$名稱` 明確呼叫，也會依描述自動選用。

## 目標與非目標

目標：

- 一份 skill，指引 agent 用 Figloo 把 Figma 的頁面或元件實作到使用者的專案裡，並且符合專案既有的慣例。
- Claude Code 與 Codex 共用同一份 `SKILL.md`。
- 提供 Claude Code plugin，把 skill 與 MCP 伺服器的註冊包在一起，使用者不必手動 `claude mcp add`。

非目標：

- 重複工具說明的內容。工具的參數、限制與錯誤處理留在工具說明，所有 MCP client 都看得到；skill 只引用工具名稱。
- 特定框架的程式碼產生器。Skill 講方法，不綁定 React、SwiftUI 或 Compose。
- 取代 extension 的安裝與配對。Extension 仍要手動載入並貼上 token。

## Skill 的內容

名稱暫定 `figloo-implement`。`description` 寫明觸發時機：使用者貼上 Figloo 複製的提示、要求實作在瀏覽器中開著的 Figma 頁面或元件，或要求從 Figma 切圖；並註明這是 Figloo 用的，避免在使用 Figma REST API 或官方 MCP 的情境被選用。

`SKILL.md` 控制在 150 行以內，細節放在需要時才讀的參考檔。

### 流程

1. **確認環境**：呼叫 `get_status`。
   - 連接埠在別的工作階段手上時，說明呼叫工具就會在它閒置時接手。
   - Figma 分頁在背景時，請使用者把分頁放回畫面上。
   - 有多個分頁時，使用貼上的提示裡的 `tabId`，或問使用者。
2. **確認範圍**：呼叫 `get_anchor`。選取的不是整頁的 frame 時，向使用者確認要實作的範圍。
3. **建立快照**：先告訴使用者需要約 40 秒、分頁要留在畫面上、可以按 Stop 中止，再呼叫 `snapshot_layer`。24 小時內沿用；使用者說設計稿改了才用 `refresh`。子樹太大時，改為對列出的子層分段建立快照。
4. **看整體**：先讀截圖與大綱的前兩層，找出區塊與重複的模式；同名的 instance 通常對應同一個元件或清單項目。
5. **對應到專案**：搜尋專案裡既有的元件、顏色、字型與間距 token，以及已有的圖檔，再把設計稿的 instance 與數值對應過去。對應不明確時問使用者，不要寫死數值。
6. **取細節**：用 `query_snapshot` 依區塊（`under`）取完整屬性，不要一個一個呼叫 `inspect_nodes`。Instance 內部需要時才用 `get_neighbors` 與 `inspect_nodes` 即時查詢。
7. **讀懂記號**：
   - `?,?` 表示由 auto layout 決定位置，應該用 flex 或 stack 實作，不要用絕對座標。
   - `[hidden]` 的圖層通常不實作，除非使用者要求。
   - `image.alignment` 是 `unconfirmed` 時，截圖上的對位只當參考。
8. **切圖**：依專案慣例選格式與倍率；大綱中的 `[export …]` 是設計師的設定，可以作為依據。
9. **驗證**：做完後如果能截取實作的畫面，就和快照的截圖並排比對，列出差異。
10. **回報**：實作了什麼、元件與 token 的對應、做了哪些假設、還沒處理的部分。

### 參考檔

- `references/inspection-fields.md`：屬性面板的欄位，例如 `Width: Hug (317px)`、`Padding—Top`、`Gap`、`Flow`、各種圓角，在 CSS、SwiftUI 與 Jetpack Compose 中的對應。
- `references/snapshot-outline.md`：大綱每一行的格式與記號、座標換算到截圖的方式。

## 發佈方式

| 使用者 | 方式 |
|---|---|
| Claude Code | 這個 repo 同時當作 plugin marketplace：`/plugin marketplace add g761007/figloo`，再 `/plugin install figloo@figloo`。Plugin 包含 skill 與 MCP 伺服器的設定 |
| Claude Code，不用 plugin | 把 skill 資料夾複製到 `~/.claude/skills/`，MCP 照現有方式註冊 |
| Codex | 把 skill 資料夾複製到 `~/.agents/skills/`；`config.toml` 的設定照 README，包含 `tool_timeout_sec` |

Plugin 裡的 MCP 伺服器從哪裡來，有兩個選項，待決定：

1. 在 GitHub release 附上 `.mcpb` bundle，plugin 的 `mcpServers` 指向它的 URL。好處是不必把建置結果放進 git；要另外研究 `.mcpb` 的格式與 Node 執行環境。
2. 發佈時把單一檔案的 `figloo-mcp.mjs` 放進 plugin 資料夾並 commit。最簡單，但每個版本都會在 git 歷史裡留下約 1.5 MB。

Repo 目前是 private，marketplace 安裝要有存取權；公開之後一般使用者才能用。

## 階段與驗證

| 階段 | 內容 | 驗證 |
|---|---|---|
| 1 | `SKILL.md` 與兩個參考檔，先放在本機的 `~/.claude/skills/` 試用 | 用一個真實頁面，在範例專案中分別在有與沒有 skill 的情況下實作，比較工具呼叫次數、是否沿用既有的元件與 token，以及與截圖的差異 |
| 2 | Claude Code plugin 與 marketplace 設定、MCP 伺服器的來源 | `claude plugin validate`；從 marketplace 安裝後，在新的工作階段確認 skill 與 MCP 都可用 |
| 3 | 觸發的評估案例、Codex 的安裝說明、README | `claude plugin eval`：該觸發與不該觸發的請求各數則；Codex 實際安裝並以 `$figloo-implement` 呼叫 |

每個階段完成後，經使用者同意再 commit。

## 風險

| 風險 | 緩解 |
|---|---|
| Skill 太長，佔用 context | `SKILL.md` 控制在 150 行內，細節放在參考檔 |
| Skill 與工具的行為不同步 | 工具的細節只寫在工具說明，skill 只描述流程與判斷 |
| 在不相關的 Figma 請求中被觸發 | `description` 限定在 Figloo 與瀏覽器中的 Figma 分頁；用評估案例檢查 |
| 評估案例用到私人測試檔 | 評估案例只用一般性的描述與假資料；用真實頁面的比較只在本機進行，不 commit 結果 |
| 不同 agent 對 skill 的支援不一 | 核心指引仍在工具說明與 popup 的提示中，沒有 skill 也能用 |

## 待決定

1. Skill 的名稱：`figloo-implement`，或更短的 `figloo`。
2. Plugin 裡 MCP 伺服器的來源：`.mcpb` 的 release URL，或 commit 建置好的檔案。
3. 範圍：只涵蓋實作頁面與元件，還是也涵蓋單純的查看與切圖。這份企劃建議三者都涵蓋，以實作為主。
